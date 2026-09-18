import { lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { OrbitError } from "./errors";

/**
 * Fresh private work directories on disk; retained profiles must not consume tmpfs RAM.
 *
 * On Windows the equivalent of `$XDG_CACHE_HOME` is `%LOCALAPPDATA%`, which is per user and
 * deliberately non roaming, so a multi gigabyte browser profile is not synced to a domain share.
 */
export function workspaceRoot(env = process.env, platform = process.platform) {
  // `platform` is injected for the same reason `env` is: without it the Windows branch cannot be
  // reached from a test on any other host, so the one path a Windows user depends on would be
  // verified only by inference. That is this project's own "not measured" rule being bent inside a
  // function it applies to. `serviceSocketPath` and `connectorConfigDirectory` already take it.
  if (platform === "win32" && !env.XDG_CACHE_HOME)
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit", "workspaces");
  // `~/Library/Caches` is the documented place for regenerable per user data on macOS, which is
  // exactly what a session workspace is: it holds a fresh browser profile that is thrown away when
  // the session ends. It is excluded from Time Machine by default, which is the right answer for a
  // directory that can hold gigabytes of browser cache.
  //
  // Application Support would also work and is wrong for the same reason `$XDG_DATA_HOME` would be
  // on Linux: this is cache, and telling the system otherwise means backing it up.
  //
  // `posix.join` for both POSIX branches, because `join` is bound to the HOST platform: with the
  // `platform` argument now injectable, a Windows host asking for the macOS or Linux answer would
  // otherwise get backslashes in it. The same correction the darwin path builders in
  // `src/service.ts` and `src/runtime-paths.ts` took.
  if (platform === "darwin" && !env.XDG_CACHE_HOME)
    return posix.join(homedir(), "Library", "Caches", "sbar-orbit", "workspaces");
  return posix.join(env.XDG_CACHE_HOME || posix.join(homedir(), ".cache"), "sbar-orbit/workspaces");
}

export async function createWorkspaceDirectory(prefix: string, root = workspaceRoot()) {
  if (!isAbsolute(root) || !/^[a-z][a-z0-9-]*$/.test(prefix)) throw new OrbitError("INVALID_REQUEST", "Workspace storage requires an absolute path and a simple prefix");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  // The POSIX half of the check: a uid to compare against and mode bits that mean something. Windows
  // has neither. `process.getuid` is undefined there, and `mode` is synthesised from the read only
  // attribute rather than read from an ACL, so `mode & 0o077` is a test of nothing that would refuse
  // every Windows host for a permission it does not have. The Windows equivalent is the inherited
  // ACL on %LOCALAPPDATA%, measured on a Windows 11 guest as SYSTEM, Administrators and the owning
  // user, with no Everyone and no Anonymous. See docs/windows-measured.md.
  const posixPrivate = process.platform !== "win32"
    && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0);
  if (!info.isDirectory() || info.isSymbolicLink() || posixPrivate)
    throw new OrbitError("INVALID_REQUEST", "Workspace storage must be a private directory owned by this user");
  const filesystem = await statfs(root);
  // tmpfs and ramfs magic numbers. Neither exists on Windows, where the check is a no op rather than
  // a wrong answer: statfs reports a type this list does not contain.
  if ([0x01021994, 0x858458f6].includes(filesystem.type))
    throw new OrbitError("UNSUPPORTED", "Workspace storage is on a RAM filesystem; set XDG_CACHE_HOME to a disk-backed directory");
  return mkdtemp(join(root, `${prefix}-`));
}

/**
 * A workspace names the broker that owns it, so a later `clean` can tell a live broker's directory
 * from one a crashed or killed broker left behind. The owner is identified by its socket, and alive
 * means it answers on that socket: the same test a managed broker applies before displacing another.
 * A pid would not do, since a pid is reused and a process's command line is not what its argv says.
 */
export async function markWorkspaceOwner(directory: string, socket: string, pid = process.pid) {
  await writeFile(join(directory, "owner.json"), JSON.stringify({ pid, socket }), { mode: 0o600 });
}

export async function brokerAnswers(socket: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "doctor", params: {} }), signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && (await response.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}

async function ownerIsAlive(directory: string, probe: (socket: string) => Promise<boolean>): Promise<boolean | undefined> {
  let owner: { socket?: unknown; pid?: unknown };
  try { owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")); } catch { return undefined; }
  if (typeof owner.socket !== "string" || !isAbsolute(owner.socket)) return undefined;
  // The socket answering is necessary and not sufficient. A managed broker binds one fixed path, so
  // every managed broker there has ever been recorded the same socket, and the one running now
  // answers for all of them: measured 13 September 2026, 24 such directories and most of 7.2 GB kept
  // by `clean` as alive. The pid decides between them. A reused pid would keep one directory for
  // one more sweep, which is the cost of not reading command lines.
  if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
    try { process.kill(Number(owner.pid), 0); } catch (error) { if ((error as { code?: string }).code === "ESRCH") return false; }
  }
  return probe(owner.socket);
}

const recordlessGraceMs = 60 * 60 * 1000;

/**
 * Remove the workspaces no running broker owns. A directory with no owner record predates the
 * record; it is kept while it is recent, in case an older broker still holds it, and removed
 * otherwise. Nothing here reads a profile's contents.
 *
 * One directory that will not go does not end the sweep. Measured 13 September 2026: a single
 * workspace under a read-only path threw out of the loop, so a run with 214 directories and 7.4 GB
 * to reclaim removed none of them and reported only "Command failed". Each refusal is now carried
 * in its own list with the reason, and the rest of the sweep continues.
 */
export async function cleanWorkspaces(root = workspaceRoot(), probe = brokerAnswers) {
  const removed: string[] = [], kept: string[] = [], refused: { name: string; reason: string }[] = [];
  let entries: string[];
  try { entries = await readdir(root); } catch { return { root, removed, kept, refused }; }
  for (const name of entries.sort()) {
    const directory = join(root, name);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const alive = await ownerIsAlive(directory, probe);
    const recent = Date.now() - info.mtimeMs < recordlessGraceMs;
    if (alive || (alive === undefined && recent)) { kept.push(name); continue; }
    try { await rm(directory, { recursive: true, force: true }); removed.push(name); }
    catch (error) { refused.push({ name, reason: error instanceof Error ? error.message : "could not be removed" }); }
  }
  return { root, removed, kept, refused };
}
