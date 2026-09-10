import { lstat, mkdir, readFile, readlink, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function sourceLauncher(source: string) {
  const root = await realpath(source);
  const bin = await lstat(join(root, "bin")), pkgInfo = await lstat(join(root, "package.json"));
  const launcher = join(root, "bin/sbar-orbit"), launchInfo = await lstat(launcher);
  if (!bin.isDirectory() || bin.isSymbolicLink() || !pkgInfo.isFile() || pkgInfo.isSymbolicLink() ||
    !launchInfo.isFile() || launchInfo.isSymbolicLink() || !(launchInfo.mode & 0o111))
    throw new Error("Source must contain a regular executable Orbit launcher and package.json");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "sbar-orbit" || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version))
    throw new Error("Source is not an Orbit release or checkout");
  return launcher;
}

async function binDirectory(prefix: string, create: boolean) {
  if (!prefix || /[\x00-\x1f\x7f]/.test(prefix)) throw new Error("Invalid installation prefix");
  const root = resolve(prefix);
  for (const path of [root, join(root, "bin")]) {
    if (create) await mkdir(path, { recursive: true });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Installation prefix and bin must be real directories");
  }
  return realpath(join(root, "bin"));
}

async function checkExisting(link: string) {
  const stat = await info(link);
  if (!stat) return;
  if (!stat.isSymbolicLink()) throw new Error("Refusing to replace or remove an existing file");
  const target = await readlink(link);
  // This recognizes source installations, not ownership against same-user programs.
  if (!isAbsolute(target) || await sourceLauncher(dirname(dirname(target))) !== target)
    throw new Error("Existing link is not a recognized Orbit source launcher");
}

async function withLock<T>(bin: string, work: () => Promise<T>) {
  const lock = join(bin, ".sbar-orbit-install-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another installation may be active; inspect the installation lock before retrying");
    throw error;
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}

/** Activate an already prepared source directory without copying or deleting it. */
export async function activateLocal(source: string, prefix: string) {
  const launcher = await sourceLauncher(source);
  const bin = await binDirectory(prefix, true), link = join(bin, "sbar-orbit");
  if (link === launcher) throw new Error("Installation prefix must be separate from the source directory");
  return withLock(bin, async () => {
    await checkExisting(link);
    const temporary = join(bin, `.sbar-orbit-link-${crypto.randomUUID()}`);
    await symlink(launcher, temporary);
    try { await rename(temporary, link); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return link;
  });
}

/** Remove only the recognized command link. Keep all source and runtime data. */
export async function deactivateLocal(prefix: string) {
  const bin = await binDirectory(prefix, false), link = join(bin, "sbar-orbit");
  await withLock(bin, async () => { await checkExisting(link); if (await info(link)) await unlink(link); });
}
