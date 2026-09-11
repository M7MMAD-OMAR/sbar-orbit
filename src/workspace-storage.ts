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
 * from one a crashed or killed broker left behind. The process identity is the pid plus the command
 * line it was started with, since a pid alone is reused by unrelated processes.
 */
export async function markWorkspaceOwner(directory: string, pid = process.pid) {
  await writeFile(join(directory, "owner.json"), JSON.stringify({ pid, argv: process.argv.slice(0, 2) }), { mode: 0o600 });
}

async function ownerIsAlive(directory: string, procRoot = "/proc"): Promise<boolean | undefined> {
  let owner: { pid?: unknown; argv?: unknown };
  try { owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")); } catch { return undefined; }
  if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return undefined;
  try {
    const running = (await readFile(join(procRoot, String(owner.pid), "cmdline"))).toString().split("\0");
    return Array.isArray(owner.argv) && owner.argv.every((word, index) => running[index] === word);
  } catch { return false; }
}

/**
 * Remove the workspaces no running broker owns. A directory with no owner record predates the
 * record; it is kept while it is recent, in case an older broker still holds it, and removed
 * otherwise. Nothing here reads a profile's contents.
 */
export async function cleanWorkspaces(root = workspaceRoot(), options: { procRoot?: string; graceMs?: number; now?: number } = {}) {
  const removed: string[] = [], kept: string[] = [];
  let entries: string[];
  try { entries = await readdir(root); } catch { return { root, removed, kept }; }
  for (const name of entries.sort()) {
    const directory = join(root, name);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const alive = await ownerIsAlive(directory, options.procRoot);
    const recent = (options.now ?? Date.now()) - info.mtimeMs < (options.graceMs ?? 60 * 60 * 1000);
    if (alive || (alive === undefined && recent)) { kept.push(name); continue; }
    await rm(directory, { recursive: true, force: true });
    removed.push(name);
  }
  return { root, removed, kept };
}
