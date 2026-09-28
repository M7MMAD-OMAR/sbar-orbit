import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";
import { seedNativePreferences } from "./native-preferences";

const maximumAuthBytes = 1024 * 1024;
const installedExecutable = "/usr/lib/chatgpt/ChatGPT";
const orphanGraceMs = 5 * 60 * 1000;
const recordlessGraceMs = 24 * 60 * 60 * 1000;

export type CodexProfileSource = { authPath?: string; executable?: string; stateHome?: string; projectPath?: string };
export type CodexDisplayEnv = { runtimeDirectory: string; waylandDisplay: string; libraryPath: string };

export type PreparedCodexLaunch = {
  argv: string[];
  toolkit: "wayland";
  selectedFiles: [];
  privateHome: string;
  sharedProject?: { path: string; device: string; inode: string };
  accountSnapshot: { authBytes: number; mode: "chatgpt"; projects: number; threads: number; atomicAcrossStores: false;
    continuity: "point-in-time"; privateChanges: "discarded-on-stop"; sharedDesktopAuthority: false };
  release: () => Promise<void>;
};

async function selectedProject(path: string) {
  const home = homedir();
  if (!path.startsWith(home + sep) || path.length > 4096 || path.includes("\0") || path !== resolve(path))
    throw new OrbitError("INVALID_REQUEST", "Codex project needs a canonical directory below the user's home");
  const parts = path.slice(home.length + 1).split(sep);
  if (!parts.length || parts[0]?.startsWith(".") || parts.some(part => !part || part === "." || part === ".."))
    throw new OrbitError("INVALID_REQUEST", "Codex project must not contain an application profile path");
  const uid = BigInt(process.getuid?.() ?? -1);
  let current = home;
  let found;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    found = await lstat(current, { bigint: true }).catch(() => undefined);
    if (!found?.isDirectory() || found.isSymbolicLink() || found.uid !== uid)
      throw new OrbitError("INVALID_REQUEST", "Codex project has an unsafe or missing directory component");
  }
  if (!found) throw new OrbitError("INVALID_REQUEST", "Codex project is unavailable");
  return { path, device: String(found.dev), inode: String(found.ino) };
}

async function processStartTicks(pid: number): Promise<string | undefined> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (!value) return undefined;
  const afterName = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/);
  const start = afterName[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}

export async function cleanOrphanCodexSnapshots(root: string, now = Date.now()) {
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^codex-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    try {
      const directory = join(root, entry.name);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) continue;
      let owner: { pid?: unknown; startTicks?: unknown } | undefined;
      try { owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")); } catch {}
      const age = now - info.mtimeMs;
      if (typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
          typeof owner.startTicks === "string" && /^\d+$/.test(owner.startTicks)) {
        if (await processStartTicks(owner.pid) === owner.startTicks || age < orphanGraceMs) continue;
      } else if (age < recordlessGraceMs) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // A damaged old snapshot must not prevent a fresh private launch.
    }
  }
  return removed;
}

async function privateCodexStorage() {
  const root = join(homedir(), ".cache", "sbar-orbit", "codex-private");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 || await realpath(root) !== root)
    throw new OrbitError("UNSUPPORTED", "Codex private storage is not an owned private directory");
  const filesystem = await statfs(root);
  if ([0x01021994, 0x858458f6].includes(filesystem.type))
    throw new OrbitError("UNSUPPORTED", "Codex conversation snapshot needs disk storage");
  await cleanOrphanCodexSnapshots(root);
  return root;
}

async function snapshotLocalState(source: string, destination: string) {
  const helper = resolve(import.meta.dir, "native/codex_state_snapshot.py");
  const child = Bun.spawn(["/usr/bin/python3", helper, source, destination],
    { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 100000);
  try {
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new OrbitError("BACKEND_FAILED", "Codex local projects could not be snapshotted");
    const report: unknown = JSON.parse(output);
    if (typeof report !== "object" || report === null ||
        typeof (report as { projects?: unknown }).projects !== "number" ||
        typeof (report as { threads?: unknown }).threads !== "number" ||
        (report as { atomicAcrossStores?: unknown }).atomicAcrossStores !== false)
      throw new OrbitError("BACKEND_FAILED", "Codex local state snapshot returned an invalid report");
    return report as { projects: number; threads: number; atomicAcrossStores: false };
  } finally { clearTimeout(timer); }
}

async function readStableAuth(path: string): Promise<Buffer> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new OrbitError("UNSUPPORTED", "Codex account source is unavailable"); }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumAuthBytes)
      throw new OrbitError("UNSUPPORTED", "Codex account source must be a regular unlinked file within its size limit");
    const contents = await file.readFile();
    const after = await file.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        before.dev !== after.dev || before.ino !== after.ino || before.ino !== current.ino ||
        before.size !== after.size || before.size !== current.size ||
        before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs)
      throw new OrbitError("BACKEND_FAILED", "Codex account source changed during the snapshot");
    let parsed: unknown;
    try { parsed = JSON.parse(contents.toString("utf8")); }
    catch { throw new OrbitError("UNSUPPORTED", "Codex account source is invalid"); }
    if (typeof parsed !== "object" || parsed === null ||
        (parsed as { auth_mode?: unknown }).auth_mode !== "chatgpt" ||
        typeof (parsed as { last_refresh?: unknown }).last_refresh !== "string")
      throw new OrbitError("UNSUPPORTED", "Codex account source does not contain a ChatGPT login");
    const tokens = (parsed as { tokens?: unknown }).tokens;
    if (typeof tokens !== "object" || tokens === null ||
        typeof (tokens as { id_token?: unknown }).id_token !== "string" ||
        typeof (tokens as { access_token?: unknown }).access_token !== "string" ||
        typeof (tokens as { refresh_token?: unknown }).refresh_token !== "string" ||
        typeof (tokens as { account_id?: unknown }).account_id !== "string")
      throw new OrbitError("UNSUPPORTED", "Codex account source has no reusable session tokens");
    const accountTokens = tokens as { id_token: string; access_token: string; refresh_token: string; account_id: string };
    const access = accountTokens.access_token;
    const payload = access.split(".")[1];
    let expiry: unknown;
    try { expiry = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")).exp; }
    catch { throw new OrbitError("UNSUPPORTED", "Codex account access token has no readable expiry"); }
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry * 1000 < Date.now() + 300000)
      throw new OrbitError("UNSUPPORTED", "Codex account access token is too close to refresh for a safe copy");
    accountTokens.refresh_token = "";
    return Buffer.from(JSON.stringify(parsed));
  } finally { await file.close(); }
}

export async function prepareCodexLaunch(
  sessionDirectory: string,
  display: CodexDisplayEnv,
  source: CodexProfileSource = {},
): Promise<PreparedCodexLaunch> {
  const session = resolve(sessionDirectory);
  const metadata = await stat(session);
  if (!metadata.isDirectory()) throw new OrbitError("INVALID_REQUEST", "Codex needs a private session directory");
  if (display.runtimeDirectory !== session || !/^[A-Za-z0-9_.-]+$/.test(display.waylandDisplay) ||
      !display.libraryPath)
    throw new OrbitError("INVALID_REQUEST", "Codex needs Orbit's private display environment");
  const executable = source.executable ?? installedExecutable;
  if (!(await stat(executable).then(value => value.isFile(), () => false)))
    throw new OrbitError("UNSUPPORTED", "Codex Desktop is not installed");
  const authPath = source.authPath ?? join(homedir(), ".codex", "auth.json");
  const sharedProject = source.projectPath === undefined ? undefined : await selectedProject(source.projectPath);
  const root = await mkdtemp(join(await privateCodexStorage(), "codex-"));
  try {
    await chmod(root, 0o700);
    const startTicks = await processStartTicks(process.pid);
    if (!startTicks) throw new OrbitError("UNSUPPORTED", "Codex private storage needs process identity");
    await writeFile(join(root, "owner.json"), JSON.stringify({ pid: process.pid, startTicks }),
      { flag: "wx", mode: 0o600 });
    const home = join(root, "home");
    const codex = join(home, ".codex");
    const config = join(home, ".config");
    const data = join(home, ".local", "share");
    const state = join(home, ".local", "state");
    const cache = join(home, ".cache");
    for (const path of [home, codex, config, join(config, "Codex"), join(home, ".local"), data, state, cache])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await seedNativePreferences(config);
    const stateReport = await snapshotLocalState(source.stateHome ?? join(homedir(), ".codex"), codex);
    const auth = await readStableAuth(authPath);
    await writeFile(join(codex, "auth.json"), auth, { flag: "wx", mode: 0o600 });
    const insideHome = homedir();
    const argv = [
      "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "XDG_SESSION_TYPE=wayland",
      "GSETTINGS_BACKEND=dconf",
      `XDG_RUNTIME_DIR=${display.runtimeDirectory}`, `WAYLAND_DISPLAY=${display.waylandDisplay}`,
      `LD_LIBRARY_PATH=${display.libraryPath}`,
      `HOME=${insideHome}`, `CODEX_HOME=${join(insideHome, ".codex")}`,
      `XDG_CONFIG_HOME=${join(insideHome, ".config")}`,
      `XDG_DATA_HOME=${join(insideHome, ".local", "share")}`,
      `XDG_STATE_HOME=${join(insideHome, ".local", "state")}`,
      `XDG_CACHE_HOME=${join(insideHome, ".cache")}`,
      executable, "--enable-features=UseOzonePlatform", "--ozone-platform=wayland",
      `--user-data-dir=${join(insideHome, ".config", "Codex")}`,
    ];
    if (!home.startsWith(join(homedir(), ".cache", "sbar-orbit", "codex-private") + sep))
      throw new OrbitError("BACKEND_FAILED", "Codex snapshot escaped private disk storage");
    return {
      argv, toolkit: "wayland", selectedFiles: [], privateHome: home,
      ...(sharedProject === undefined ? {} : { sharedProject }),
      accountSnapshot: { authBytes: auth.length, mode: "chatgpt", ...stateReport,
        continuity: "point-in-time", privateChanges: "discarded-on-stop", sharedDesktopAuthority: false },
      release: async () => { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
