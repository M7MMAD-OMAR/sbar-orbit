import { lstat, mkdir, mkdtemp, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrbitError } from "./errors";

/** Fresh private work directories on disk; retained profiles must not consume tmpfs RAM. */
export async function createWorkspaceDirectory(prefix: string, root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sbar-orbit/workspaces")) {
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
