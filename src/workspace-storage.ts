import { lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
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
  // XDG is NOT honoured on Windows. It is a POSIX convention, and a Windows process that has
  // XDG_CACHE_HOME set got it from Git Bash, MSYS2 or an agent host rather than from a person
  // choosing a cache location, so honouring it moved live session profiles somewhere nothing checks.
  // The POSIX mode test that would have caught a world readable directory is disabled on Windows
  // precisely because Windows does not store a mode, and the ACL reasoning that replaces it is about
  // %LOCALAPPDATA% specifically: measured on the guest as SYSTEM, Administrators and the owning user,
  // where a drive root directory was measured handing down Authenticated Users: Modify. `updateRoot`
  // already ignores XDG on Windows for this reason; these three now agree with it.
  if (platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "sbar-orbit", "workspaces");
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

/**
 * The egress socket directory a bounded-origin session opens, per session, under
 * `$XDG_RUNTIME_DIR/sbar-orbit/egress/<8 hex>`, holding `lease.sock` and `cdp.sock`.
 *
 * `EgressLease.close()` removes it, which is precisely what SIGKILL does not run. `browser-crash.test.ts`
 * kills a broker and proves no descendant survives; it never looks at the filesystem, so these were
 * invisible to every existing test. Measured on this workstation after a day of runs: 33 directories
 * left on tmpfs with no broker owning any of them.
 *
 * That is not merely untidy. `src/fedora.ts` already carries the reasoning for the native runtime
 * directory: tmpfs pages are charged to the cgroup that wrote them, and left behind, closed sessions
 * kept filling the shared memory budget until the kernel throttled everything still running.
 */
export function egressRoot(): string {
  return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "sbar-orbit", "egress");
}

/**
 * Whether a lease socket still has something listening on it.
 *
 * These directories carry NO `owner.json`, so the workspace sweep's ownership logic does not apply:
 * there is no pid and no broker socket recorded anywhere in them. The socket itself is the evidence.
 * A live lease accepts a connection; an abandoned one is a filesystem entry whose listener is gone,
 * and connecting to it fails with ECONNREFUSED immediately, with no timeout to wait out.
 *
 * A directory with no `lease.sock` at all is treated as dead, since that is the shape left by a
 * broker killed between `mkdir` and `listen`.
 */
async function leaseIsLive(directory: string): Promise<boolean> {
  const socket = join(directory, "lease.sock");
  // Windows can refuse lstat on a bound AF_UNIX socket. Only an actual
  // connection tells us whether the lease is live; a failed stat is not absence.
  try {
    const connection = await Bun.connect({ unix: socket, socket: { data() {}, error() {} } });
    connection.end();
    return true;
  } catch { return false; }
}

/**
 * Remove the egress socket directories no live lease owns.
 *
 * Separate from `cleanWorkspaces` rather than folded into it, because the two roots answer different
 * questions with different evidence: a workspace is owned by a broker that records its pid and
 * socket, an egress directory is owned by a listener that records nothing. Sharing one loop would
 * mean one of them lying about the other.
 *
 * The recent grace exists for the same reason it does in the workspace sweep: a session being set up
 * right now has a directory and may not have a listener yet, and a sweep that deletes it takes the
 * socket out from under a session that is about to bind it.
 */
export async function cleanEgress(root = egressRoot(), live = leaseIsLive) {
  const removed: string[] = [], kept: string[] = [], refused: { name: string; reason: string }[] = [];
  let entries: string[];
  try { entries = await readdir(root); } catch { return { root, removed, kept, refused }; }
  for (const name of entries.sort()) {
    const directory = join(root, name);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    if (await live(directory)) { kept.push(name); continue; }
    if (Date.now() - info.mtimeMs < egressGraceMs) { kept.push(name); continue; }
    // One directory that will not go does not end the sweep, the same lesson the workspace sweep
    // already carries: a single refusal used to abandon every remaining reclaim.
    try { await rm(directory, { recursive: true, force: true }); removed.push(name); }
    catch (error) { refused.push({ name, reason: error instanceof Error ? error.message : "could not be removed" }); }
  }
  return { root, removed, kept, refused };
}

const egressGraceMs = 60 * 1000;
