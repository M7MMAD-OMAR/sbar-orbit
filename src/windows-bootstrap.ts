/** Neutral Windows payload/bootstrap verification. No installer, lifecycle, broker or IPC dependency. */
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { preparedIdentity } from "./managed-identity";
import { DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME, desktopSourceDigest, validateDesktopPayload, windowsFileDigest } from "./windows-desktop-update";

const BOOTSTRAP = "windows-bootstrap.json";
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
export async function verifyWindowsCurrent(root: string, options: { internalTransition?: true } = {}) {
  root = await canonicalDirectory(root);
  const pointer = join(root, "current.txt"), info = await lstat(pointer);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) fail("Invalid managed Windows pointer");
  const directory = (await readFile(pointer, "utf8")).replace(/\r?\n$/, "");
  if (!isAbsolute(directory) || directory !== resolve(directory) || dirname(directory) !== join(root, "versions")) fail("Managed pointer escaped its versions directory");
  await canonicalDirectory(join(root, "versions")); await canonicalDirectory(directory);
  const version = directory.slice(join(root, "versions").length + 1);
  const barrier = await exists(join(root, "activation-recovery.json"));
  if (barrier) {
    if (!options.internalTransition || !barrier.isFile() || barrier.isSymbolicLink() || barrier.size > 32768) fail("Managed admission is closed pending recovery; new launches are refused");
    const pending = JSON.parse(await readFile(join(root, "activation-recovery.json"), "utf8"));
    if (!["pending", "windows-bootstrap"].includes(pending.phase) || ![pending.version, pending.previous].includes(version)) fail("Managed transition is not bound to the selected version");
  }
  const identity = await preparedIdentity(root, version);
  if (identity.runtime !== join(directory, DESKTOP_RUNTIME)) fail("Windows release must use its verified versioned runtime");
  await validateDesktopPayload(directory, version, await desktopSourceDigest(directory));
  return { ok: true as const, bootstrapProtocol: 2 as const, version, root, directory,
    desktopPath: join(directory, DESKTOP_EXE), runtime: identity.runtime, cliPath: join(directory, "src/cli.ts"),
    mcpPath: join(directory, "src/mcp.ts"), connectorPath: join(directory, "src/connector-config.ts"), identity: { ...identity, root, directory } };
}

/** Called only after exact owned broker task exit, under the activation admission barrier.
 * Side-by-side payloads are never modified. Sharing violations refuse and allow normal rollback.
 */
export async function admittedWindowsBootstrap(root: string) {
  root = await canonicalDirectory(root);
  const record = await boundedJson(join(root, BOOTSTRAP), 4096);
  if (record.schema !== 2 || record.bootstrapProtocol !== 2 || typeof record.version !== "string" || typeof record.launcherDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.launcherDigest)) fail("Unknown stable bootstrap provenance");
  await preparedIdentity(root, record.version);
  const origin = join(root, "versions", record.version);
  const manifest = await validateDesktopPayload(origin, record.version, await desktopSourceDigest(origin));
  const executable = join(root, "bin/Orbit.exe"), info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(executable) !== executable
      || manifest.files.find(file => file.path === DESKTOP_LAUNCHER)?.sha256 !== record.launcherDigest
      || await windowsFileDigest(executable) !== record.launcherDigest) fail("Stable bootstrap differs from its sealed published origin");
  return { version: record.version as string, launcherDigest: record.launcherDigest as string, bootstrapProtocol: 2 as const };
}

export async function selectWindowsBootstrap(root: string, options: { replace?: (path: string, bytes: Buffer) => Promise<void> } = {}) {
  const selected = await verifyWindowsCurrent(root, { internalTransition: true }), launcher = join(root, "bin/Orbit.exe");
  const source = await readFile(join(selected.directory, DESKTOP_LAUNCHER)), expected = digest(source);
  await mkdir(dirname(launcher), { recursive: true }); await canonicalDirectory(dirname(launcher));
  const current = await exists(launcher);
  if (current && (!current.isFile() || current.isSymbolicLink())) fail("Stable desktop launcher is not a regular owned file");
  let admitted: Awaited<ReturnType<typeof admittedWindowsBootstrap>> | undefined;
  if (current) admitted = await admittedWindowsBootstrap(root);
  if (!current || digest(await readFile(launcher)) !== expected) {
    try { await (options.replace ?? atomic)(launcher, source); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!admitted || !["EACCES", "EPERM", "EBUSY"].includes(code ?? "")) throw error;
      // Idle MCP can hold this PE mapped. Keep the admitted protocol-2 host and origin.
      // The single current pointer still advances GUI, CLI and runtime. Never force-close.
      const still = await admittedWindowsBootstrap(root);
      if (still.version !== admitted.version || still.launcherDigest !== admitted.launcherDigest) throw error;
      return { ...selected, bootstrapVersion: still.version, bootstrapRetained: true };
    }
  }
  await atomic(join(root, BOOTSTRAP), JSON.stringify({ schema: 2, bootstrapProtocol: 2, version: selected.version, launcherDigest: expected }) + "\n");
  return { ...selected, bootstrapVersion: selected.version, bootstrapRetained: false };
}
