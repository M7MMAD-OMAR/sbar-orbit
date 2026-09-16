import { lstat, mkdir, readFile, readlink, realpath, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { launcherName } from "./update";

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function sourceLauncher(source: string) {
  const root = await realpath(source);
  const bin = await lstat(join(root, "bin")), pkgInfo = await lstat(join(root, "package.json"));
  // The launcher this platform actually runs. On Windows the executable bit does not exist, and
  // `mode & 0o111` is synthesised from the read only attribute, so testing it there would refuse
  // every correct install for a permission Windows does not have.
  const launcher = join(root, launcherName()), launchInfo = await lstat(launcher);
  const executable = process.platform === "win32" || Boolean(launchInfo.mode & 0o111);
  if (!bin.isDirectory() || bin.isSymbolicLink() || !pkgInfo.isFile() || pkgInfo.isSymbolicLink() ||
    !launchInfo.isFile() || launchInfo.isSymbolicLink() || !executable)
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

/**
 * The command name this install writes into the prefix, and how it points at the source.
 *
 * Linux writes a symlink. Windows cannot: `symlink` is EPERM without Developer Mode or elevation,
 * measured on a Windows 11 guest. What it writes instead is a one line `.cmd` shim that forwards to
 * the source launcher, which needs no special privilege and is what `where sbar-orbit` will find.
 *
 * The shim carries a marker line so `checkExisting` can recognise Orbit's own file. That matters as
 * much as the forwarding: the Linux path refuses to replace anything that is not a symlink pointing
 * into a recognised source, and a shim that could not be told apart from a person's own batch file
 * would have traded that safety away for convenience.
 */
export const commandName = () => process.platform === "win32" ? "sbar-orbit.cmd" : "sbar-orbit";
const SHIM_MARKER = "@rem sbar-orbit-managed-shim";

function shimFor(launcher: string) {
  // %* forwards every argument unchanged, and `call` keeps the shim's exit code as the command's.
  return `@echo off\r\n${SHIM_MARKER}\r\n@rem Target: ${launcher}\r\n@call "${launcher}" %*\r\n`;
}

/** The launcher a managed shim forwards to, or null when this is not one of ours. */
function shimTarget(contents: string) {
  if (!contents.includes(SHIM_MARKER)) return null;
  return /^@call "(.+)" %\*/m.exec(contents)?.[1] ?? null;
}

async function checkExisting(link: string) {
  const stat = await info(link);
  if (!stat) return;
  if (process.platform === "win32") {
    // A regular file, because that is what a shim is. Anything else, including a file that does not
    // carry the marker, is someone else's and is left alone.
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing to replace or remove an existing file");
    const target = shimTarget(await readFile(link, "utf8"));
    if (!target || !isAbsolute(target) || await sourceLauncher(dirname(dirname(target))) !== target)
      throw new Error("Existing command is not a recognized Orbit source launcher");
    return;
  }
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
  const bin = await binDirectory(prefix, true), link = join(bin, commandName());
  if (link === launcher) throw new Error("Installation prefix must be separate from the source directory");
  return withLock(bin, async () => {
    await checkExisting(link);
    const temporary = join(bin, `.sbar-orbit-link-${crypto.randomUUID()}`);
    // Both platforms rename onto the live name, because that is the only atomic swap either offers:
    // Linux over a symlink, Windows over a file. Windows cannot rename over a directory at all.
    if (process.platform === "win32") await writeFile(temporary, shimFor(launcher), "utf8");
    else await symlink(launcher, temporary);
    try { await rename(temporary, link); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return link;
  });
}

/** Remove only the recognized command link. Keep all source and runtime data. */
export async function deactivateLocal(prefix: string) {
  const bin = await binDirectory(prefix, false), link = join(bin, commandName());
  await withLock(bin, async () => { await checkExisting(link); if (await info(link)) await unlink(link); });
}
