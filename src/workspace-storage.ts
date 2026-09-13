import { lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrbitError } from "./errors";

/** Fresh private work directories on disk; retained profiles must not consume tmpfs RAM. */
export function workspaceRoot(env = process.env) { return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sbar-orbit/workspaces"); }

export async function createWorkspaceDirectory(prefix: string, root = workspaceRoot()) {
  if (!isAbsolute(root) || !/^[a-z][a-z0-9-]*$/.test(prefix)) throw new OrbitError("INVALID_REQUEST", "Workspace storage requires an absolute path and a simple prefix");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077))
    throw new OrbitError("INVALID_REQUEST", "Workspace storage must be a private directory owned by this user");
  const filesystem = await statfs(root);
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
 */
export async function cleanWorkspaces(root = workspaceRoot(), probe = brokerAnswers) {
  const removed: string[] = [], kept: string[] = [];
  let entries: string[];
  try { entries = await readdir(root); } catch { return { root, removed, kept }; }
  for (const name of entries.sort()) {
    const directory = join(root, name);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const alive = await ownerIsAlive(directory, probe);
    const recent = Date.now() - info.mtimeMs < recordlessGraceMs;
    if (alive || (alive === undefined && recent)) { kept.push(name); continue; }
    await rm(directory, { recursive: true, force: true });
    removed.push(name);
  }
  return { root, removed, kept };
}
