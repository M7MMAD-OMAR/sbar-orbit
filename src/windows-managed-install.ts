/** Central Windows installation transaction. Native desktop control is not implemented by this installer. */
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, freemem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { preparedIdentity, sealRelease, sameBrokerIdentity, type BrokerIdentity } from "./managed-identity";
import { managedUpdateRoot, requireUpdateAdmission } from "./update-admission";
import { withUpdateLock } from "./update-lock";
import { brokerTaskXml, currentUserSid, taskNameForUser } from "./windows-autostart";
import { boundedCommand, managedLifecycle, taskOwned, type CommandRunner, type ManagedLifecycle } from "./managed-lifecycle";
import { serviceSocketPath } from "./service";
import { call } from "./ipc";
import { DESKTOP_MANIFEST, DESKTOP_RUNTIME, desktopSourceDigest, validateDesktopPayload, windowsFileDigest } from "./windows-desktop-update";

import { selectWindowsBootstrap, verifyWindowsCurrent } from "./windows-bootstrap";
export { admittedWindowsBootstrap, selectWindowsBootstrap, verifyWindowsCurrent } from "./windows-bootstrap";

const BOOTSTRAP = "windows-bootstrap.json";
const INVENTORY = "windows-release-files.json";
const fail = (message: string): never => { throw new Error(message); };
const exists = async (path: string) => lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function boundedJson(path: string, maximum = 32768) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail("Managed metadata must be a bounded regular file");
  return JSON.parse(await readFile(path, "utf8"));
}
async function canonicalDirectory(path: string) {
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail("Managed directory is redirected or noncanonical");
  return resolve(path);
}
async function atomic(path: string, bytes: string | Buffer) {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
function shim(root: string) {
  if (/["%\r\n\0]/.test(root)) fail("Managed Windows root is not safe for the stable command shim");
  return ["@echo off", "@rem sbar-orbit-managed-shim", "@rem Target: " + join(root, "current/bin/sbar-orbit.cmd"),
    "@setlocal DisableDelayedExpansion", '@"' + join(root, "bin/Orbit.exe") + '" --cli "' + root + '" %*', "@exit /b %errorlevel%", ""].join("\r\n");
}
export type WindowsInstallOptions = {
  root?: string; automaticUpdates: boolean;
  /** Owned fixture seams. Defaults call the actual account Task Scheduler and fixed broker socket. */
  platform?: NodeJS.Platform; run?: CommandRunner; sid?: string; socket?: string;
  healthy?: (identity: BrokerIdentity) => Promise<boolean>;
  lifecycle?: ManagedLifecycle;
};
async function healthy(identity: BrokerIdentity, socket: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const result = await call(socket, "doctor", {}, AbortSignal.timeout(500)) as { managedIdentity?: unknown }; if (sameBrokerIdentity(result.managedIdentity, identity)) return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
async function freshTaskAbsent(run: CommandRunner, task: string) {
  const result = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $tasks=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskPath -eq '\\' -and $_.TaskName -eq '" + task + "'}); if($tasks.Count -eq 0){'ABSENT'}else{'PRESENT'}"], 5000);
  if (!result.ok || result.output.trim() !== "ABSENT") fail("First install requires proven absence of the per-user broker task; migrate existing mechanisms deliberately");
}
async function copyPayload(source: string, destination: string) {
  let count = 0, bytes = 0;
  async function inspect(path: string, depth = 0) {
    if (++count > 20000 || depth > 32 || path.length - source.length > 512) fail("Installer entry count, depth or path bound exceeded");
    const info = await lstat(path); if (info.isSymbolicLink()) fail("Installer payload contains a link or redirected input");
    if (info.isDirectory()) { for (const name of await readdir(path)) await inspect(join(path, name), depth + 1); }
    else if (info.isFile()) { bytes += info.size; if (count > 20000 || bytes > 1024 * 1024 * 1024 || info.size > 256 * 1024 * 1024) fail("Installer payload exceeds its file or byte bound"); }
    else fail("Installer payload must contain only regular files");
  }
  await inspect(source);
  if (bytes > 64 * 1024 * 1024 && freemem() < Math.max(1024 * 1024 * 1024, bytes * 2)) fail("Insufficient available memory for a budgeted payload copy; close no owner processes automatically");
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
}
export async function installWindowsManaged(payload: string, options: WindowsInstallOptions) {
  if ((options.platform ?? process.platform) !== "win32") fail("The managed Windows installer requires Windows; source fixtures are not live acceptance");
  const root = resolve(options.root ?? managedUpdateRoot()), source = await canonicalDirectory(payload);
  if (options.platform === undefined && root !== resolve(managedUpdateRoot())) fail("Windows installation requires the normal per-user managed root");
  if (source === root || source.startsWith(root + sep) || root.startsWith(source + sep)) fail("Installer source and managed destination must be separate");
  if (typeof options.automaticUpdates !== "boolean") fail("An explicit automatic-update choice is required");
  if (await exists(join(source, ".git"))) fail("Install an audited release payload, never copy a source checkout or owner workspace");
  const allowedInputs = new Set(["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "skills", "experiments", "node_modules", "runtime", DESKTOP_MANIFEST, "SOURCE-COMMIT", "SOURCE-COMMIT.json", "orbit-source-manifest.json", "AGENTS.md", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md"]);
  if ((await readdir(source)).some(name => !allowedInputs.has(name))) fail("Installer payload contains unrecognized or private inputs");
  const manifest = await boundedJson(join(source, "package.json"), 1024 * 1024);
  if (manifest.name !== "sbar-orbit" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) fail("Installer payload is not a versioned Orbit release");
  await validateDesktopPayload(source, manifest.version, await desktopSourceDigest(source));
  for (const required of ["node_modules/@modelcontextprotocol/sdk/package.json", "src/windows-managed-install.ts"]) if (!(await lstat(join(source, required))).isFile()) fail("Installer must bundle its source verifier and offline production dependencies");
  const run = options.run ?? boundedCommand, sid = options.sid ?? await currentUserSid(), socket = options.socket ?? serviceSocketPath();
  if (!/^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(sid)) fail("Invalid account SID");
  await mkdir(root, { recursive: true, mode: 0o700 }); await canonicalDirectory(root);
  return withUpdateLock(root, async () => {
    await requireUpdateAdmission(root);
    if (await exists(join(root, "current.txt"))) {
      const selected = await verifyWindowsCurrent(root);
      if (selected.version !== manifest.version) fail("An existing managed install must stage and activate updates; never overwrite its running version");
      if (JSON.stringify(await validateDesktopPayload(source, manifest.version)) !== JSON.stringify(await validateDesktopPayload(selected.directory, selected.version))) fail("Same version has different shipped desktop identity");
      const lifecycle = options.lifecycle ?? managedLifecycle({ platform: "win32", launcher: join(root, "bin/sbar-orbit.cmd"), socket, sid: async () => sid, run, windowsDesktopRoot: root });
      const admitted = await lifecycle.admit!(selected.identity);
      if (!admitted.ok || !(await (options.healthy ?? (identity => healthy(identity, socket)))(selected.identity))) fail("Existing managed install is not healthy and exactly admitted; recover deliberately");
      return { ...selected, reused: true, automaticUpdates: (await readFile(join(root, "automatic"), "utf8").catch(() => "")).trim() === "on" };
    }
    const names = await readdir(root);
    if (names.some(name => ![process.platform === "linux" ? ".update.lock" : ".update-lock", "automatic"].includes(name))) fail("First install found unknown/unmanaged files; preserve them and migrate deliberately");
    const preferenceInfo = await exists(join(root, "automatic"));
    if (preferenceInfo && (!preferenceInfo.isFile() || preferenceInfo.isSymbolicLink() || preferenceInfo.size > 32)) fail("Automatic-update preference is redirected");
    const preference = preferenceInfo ? (await readFile(join(root, "automatic"), "utf8")).trim() : undefined;
    if (preference !== undefined && preference !== "on" && preference !== "off") fail("Unknown automatic-update preference");
    const automatic = preference === "off" ? false : options.automaticUpdates;
    await freshTaskAbsent(run, taskNameForUser(sid));
    if (await exists(socket)) fail("First install found a broker endpoint; silence is not absence of active work");
    const barrier = join(root, "activation-recovery.json"), owner = crypto.randomUUID();
    const handle = await open(barrier, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ schema: 1, phase: "windows-bootstrap", owner, version: manifest.version })); await handle.sync(); } finally { await handle.close(); }
    const directory = join(root, "versions", manifest.version), launcher = join(root, "bin/sbar-orbit.cmd");
    let registered = false;
    try {
      await mkdir(join(root, "versions")); await copyPayload(source, directory);
      await sealRelease(directory, manifest.version, join(directory, DESKTOP_RUNTIME));
      await recordWindowsReleaseFiles(directory);
      await atomic(join(root, "current.txt"), directory);
      const selected = await selectWindowsBootstrap(root);
      await writeFile(launcher, shim(root), { flag: "wx", mode: 0o600 });
      await freshTaskAbsent(run, taskNameForUser(sid));
      const xml = join(root, ".bootstrap-" + owner + ".xml");
      const environment = { ORBIT_BUN: selected.runtime, ORBIT_MANAGED_ENV_SCHEMA: "1", ORBIT_SOCKET: socket };
      await writeFile(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(brokerTaskXml(launcher, sid, environment), "utf16le")]), { flag: "wx", mode: 0o600 });
      try {
        const created = await run(["schtasks.exe", "/Create", "/TN", taskNameForUser(sid), "/XML", xml]);
        if (!created.ok) fail("Owned broker task registration failed; bootstrap recovery is required");
        registered = true;
      } finally { await unlink(xml).catch(() => {}); }
      const started = await run(["schtasks.exe", "/Run", "/TN", taskNameForUser(sid)]);
      if (!started.ok || !(await (options.healthy ?? (identity => healthy(identity, socket)))(selected.identity))) fail("Installed broker did not acknowledge the exact source/runtime identity; Windows IPC is not proven");
      // Keep an existing explicit off preference. Initial on is an explicit installer choice.
      if (automatic) {
        const schedule = await (options.lifecycle ?? managedLifecycle({ platform: "win32", launcher, socket, sid: async () => sid, run, windowsDesktopRoot: root })).schedule(true);
        if (!schedule.ok) fail("Automatic updater registration failed; bootstrap recovery is required");
      }
      await atomic(join(root, "automatic"), automatic ? "on" : "off");
      const recorded = JSON.parse(await readFile(barrier, "utf8")); if (recorded.owner !== owner) fail("Bootstrap admission ownership changed");
      await unlink(barrier);
      return { ...selected, launcher, automaticUpdates: automatic, reused: false };
    } catch (error) {
      // Never erase unknown state or announce success. Keep durable admission on every failed adoption.
      if (registered) await run(["schtasks.exe", "/End", "/TN", taskNameForUser(sid)]).catch(() => ({ ok: false, output: "Owned bootstrap stop is unconfirmed" }));
      throw error;
    }
  });
}

async function releaseFiles(directory: string) {
  const files: { path: string; sha256: string }[] = []; let bytes = 0, visited = 0;
  async function visit(relative: string) {
    if (++visited > 20000 || relative.split("/").length > 32 || relative.length > 512) fail("Release inventory entry, depth or path bound exceeded");
    if (relative === INVENTORY) return;
    const path = join(directory, relative), info = await lstat(path);
    if (info.isSymbolicLink()) fail("Release inventory contains a redirected input");
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(relative ? relative + "/" + name : name);
    else if (info.isFile()) {
      bytes += info.size; if (files.length >= 20000 || info.size > 256 * 1024 * 1024 || bytes > 1024 * 1024 * 1024) fail("Release inventory exceeds its bound");
      files.push({ path: relative, sha256: await windowsFileDigest(path) });
    } else fail("Release inventory must contain only regular files");
  }
  await visit(""); return files;
}
export async function recordWindowsReleaseFiles(directory: string) {
  const files = await releaseFiles(directory);
  await writeFile(join(directory, INVENTORY), JSON.stringify({ schema: 1, files }) + "\n", { flag: "wx", mode: 0o600 });
}
export async function prepareWindowsUninstall(root: string) {
  const selected = await verifyWindowsCurrent(root);
  return withUpdateLock(root, async () => {
    await requireUpdateAdmission(root);
    const temporary = await mkdtemp(join(tmpdir(), "orbit-uninstall-")), destination = join(temporary, "payload");
    await copyPayload(selected.directory, destination);
    await validateDesktopPayload(destination, selected.version, await desktopSourceDigest(destination));
    await writeFile(join(destination, "maintenance-copy.json"), JSON.stringify({ schema: 1, root: selected.root, version: selected.version }), { flag: "wx", mode: 0o600 });
    return { ok: true, runtime: join(destination, DESKTOP_RUNTIME), entry: join(destination, "src/windows-managed-install.ts"), maintenanceDirectory: temporary };
  });
}
async function noInstalledProcesses(root: string, run: CommandRunner, guiOnly: boolean) {
  const encoded = Buffer.from(root + sep, "utf8").toString("base64");
  const script = "$ErrorActionPreference='Stop'; $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); $p=@(Get-CimInstance Win32_Process -ErrorAction Stop); $busy=@($p | Where-Object {"
    + (guiOnly ? "$_.Name -eq 'Orbit.Desktop.exe' -and " : "")
    + "((-not $_.ExecutablePath " + (guiOnly ? "" : "-and ($_.Name -eq 'Orbit.exe' -or $_.Name -eq 'Orbit.Desktop.exe')") + ") -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)))}); if($busy.Count){'BUSY'}else{'ABSENT'}";
  const probe = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], 5000);
  if (!probe.ok || probe.output.trim() !== "ABSENT") fail("Close the installed Orbit GUI, adapters and active work before uninstalling; unknown process ownership is not absence");
}
export async function uninstallWindowsManaged(root: string, options: Omit<WindowsInstallOptions, "automaticUpdates"> = {}) {
  if ((options.platform ?? process.platform) !== "win32") fail("Windows uninstall requires Windows");
  root = await canonicalDirectory(root);
  if (resolve(process.execPath).startsWith(root + sep) || resolve(import.meta.dir).startsWith(root + sep)) fail("Run uninstall from the verified external maintenance copy after the stable launcher exits");
  const copy = await boundedJson(join(dirname(import.meta.dir), "maintenance-copy.json"), 4096);
  if (copy.schema !== 1 || copy.root !== root) fail("Maintenance copy is not bound to this managed root");
  const selected = await verifyWindowsCurrent(root);
  if (copy.version !== selected.version) fail("The installed version changed after maintenance preparation");
  const run = options.run ?? boundedCommand, sid = options.sid ?? await currentUserSid(), socket = options.socket ?? serviceSocketPath();
  const launcher = join(root, "bin/sbar-orbit.cmd");
  await noInstalledProcesses(root, run, true);
  return withUpdateLock(root, async () => {
    await requireUpdateAdmission(root);
    const lifecycle = managedLifecycle({ platform: "win32", launcher, socket, run, sid: async () => sid, windowsDesktopRoot: root });
    const admitted = await lifecycle.admit!(selected.identity); if (!admitted.ok) fail(admitted.output);
    const token = await call(socket, "update.begin") as { token?: string };
    if (typeof token.token !== "string") fail("Broker did not admit uninstall after draining active work");
    const barrier = join(root, "activation-recovery.json");
    const writer = await open(barrier, "wx", 0o600);
    try { await writer.writeFile(JSON.stringify({ schema: 1, phase: "windows-uninstall", version: selected.version })); await writer.sync(); } finally { await writer.close(); }
    // All validation precedes deletion. On uncertainty retain admission, never kill unknown work.
    const inventories: { directory: string; files: { path: string; sha256: string }[] }[] = [];
    for (const version of await readdir(join(root, "versions"))) {
      if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail("Unknown prepared directory must be recovered deliberately before uninstall");
      const directory = join(root, "versions", version); await preparedIdentity(root, version);
      const inventoryInfo = await lstat(join(directory, INVENTORY));
      if (!inventoryInfo.isFile() || inventoryInfo.isSymbolicLink() || inventoryInfo.size > 8 * 1024 * 1024) fail("Missing bounded owned release inventory");
      const inventory = JSON.parse(await readFile(join(directory, INVENTORY), "utf8"));
      const actual = await releaseFiles(directory);
      if (inventory.schema !== 1 || JSON.stringify(inventory.files) !== JSON.stringify(actual)) fail("Modified or unknown release files will not be removed");
      inventories.push({ directory, files: actual });
    }
    const bootstrap = await boundedJson(join(root, BOOTSTRAP), 4096);
    if (bootstrap.schema !== 1 || bootstrap.launcherDigest !== digest(await readFile(join(root, "bin/Orbit.exe"))) || await readFile(launcher, "utf8") !== shim(root)) fail("Installed launcher ownership changed");
    const stopped = await lifecycle.stop!(); if (!stopped.ok) fail("Owned broker task stop was not confirmed; admission remains closed");
    await noInstalledProcesses(root, run, false);
    const disabled = await lifecycle.schedule(false); if (!disabled.ok) fail("Owned updater removal was not confirmed");
    const task = taskNameForUser(sid), exported = await run(["schtasks.exe", "/Query", "/TN", task, "/XML"]);
    if (!exported.ok || !taskOwned(exported.output, launcher, sid)) fail("Broker task ownership changed before removal");
    const removed = await run(["schtasks.exe", "/Delete", "/TN", task, "/F"]); if (!removed.ok) fail("Owned broker task removal failed");
    await freshTaskAbsent(run, task);
    for (const inventory of inventories) {
      const directories = new Set<string>();
      for (const file of inventory.files) {
        const path = resolve(inventory.directory, file.path);
        if (!path.startsWith(inventory.directory + sep) || await windowsFileDigest(path) !== file.sha256) fail("Owned file changed during removal; remaining files preserved");
        await unlink(path); let parent = dirname(path);
        while (parent.startsWith(inventory.directory + sep)) { directories.add(parent); parent = dirname(parent); }
      }
      await unlink(join(inventory.directory, INVENTORY));
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) await rmdir(directory);
      await rmdir(inventory.directory);
    }
    for (const path of [launcher, join(root, "bin/Orbit.exe"), join(root, BOOTSTRAP), join(root, "current.txt"), join(root, "previous.txt")]) {
      const item = await exists(path); if (item) { if (!item.isFile() || item.isSymbolicLink()) fail("Unexpected uninstall metadata is preserved"); await unlink(path); }
    }
    await rmdir(join(root, "versions"));
    if (!(await readdir(join(root, "bin"))).length) await rmdir(join(root, "bin"));
    await unlink(barrier);
    return { ok: true, uninstalled: true, preservedUserData: true, root, maintenanceCopy: "Private temporary maintenance files may be removed after this process exits" };
  });
}

async function verifyBrokerStartup(root: string) {
  const selected = await verifyWindowsCurrent(root, { internalTransition: true });
  const pendingPath = join(selected.root, "activation-recovery.json"), pendingInfo = await exists(pendingPath);
  if (!pendingInfo) return selected;
  if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || pendingInfo.size > 32768) fail("Invalid pending startup admission");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  if (!(["pending", "windows-bootstrap"].includes(pending.phase))
      || ![pending.version, pending.previous].includes(selected.version)
      || pending.phase === "pending" && (typeof pending.token !== "string" || !pending.token)
      || pending.phase === "windows-bootstrap" && typeof pending.owner !== "string"
      || process.env.ORBIT_MANAGED_ENV_SCHEMA !== "1" || process.env.ORBIT_BUN !== selected.runtime
      || process.env.ORBIT_SOCKET !== serviceSocketPath()) fail("Managed broker startup is not exactly admitted by the pending transaction");
  const sid = await currentUserSid(), task = await boundedCommand(["schtasks.exe", "/Query", "/TN", taskNameForUser(sid), "/XML"]);
  if (!task.ok || !taskOwned(task.output, join(root, "bin/sbar-orbit.cmd"), sid)) fail("Pending startup lacks the exact owned account task");
  return selected;
}

async function main() {
  await (await import("./resource-budget")).requireResourceBudget();
  const [command, ...args] = process.argv.slice(2), values = new Map<string, string>();
  if (args.length % 2) fail("Expected named installer arguments");
  for (let at = 0; at < args.length; at += 2) { const name = args[at]!, value = args[at + 1]!; if (!name.startsWith("--") || values.has(name)) fail("Invalid installer arguments"); values.set(name, value); }
  if (command === "verify-current" && values.size === 2 && values.has("--root") && values.get("--broker-startup") === "true") return verifyBrokerStartup(values.get("--root")!);
  if (values.size === 1 && values.has("--root")) {
    if (command === "verify-current") return verifyWindowsCurrent(values.get("--root")!);
    if (command === "prepare-uninstall") return prepareWindowsUninstall(values.get("--root")!);
    if (command === "uninstall") return uninstallWindowsManaged(values.get("--root")!);
  }
  if (command !== "install" || values.size !== 3 || !values.has("--payload") || !values.has("--root") || !["on", "off"].includes(values.get("--automatic-updates") ?? "")) fail("Usage: install --payload PATH --root ROOT --automatic-updates on|off; or verify-current --root ROOT");
  return installWindowsManaged(values.get("--payload")!, { root: values.get("--root")!, automaticUpdates: values.get("--automatic-updates") === "on" });
}
if (import.meta.main) main().then(result => console.log(JSON.stringify(result)), error => { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Managed installation failed" })); process.exitCode = 1; });
