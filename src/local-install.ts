import { lstat, mkdir, readFile, readlink, realpath, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { launcherName } from "./update";
import { createHash } from "node:crypto";
import { withUpdateLock } from "./update-lock";
import { managedTarget } from "./managed-entry";

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function sourceLauncher(source: string) {
  const pointer = process.platform === "win32" && await info(`${source}.txt`);
  const root = pointer ? await managedTarget(dirname(resolve(source))) : await realpath(source);
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
  // Validate the resolved release above, but preserve a managed current symlink in the command.
  return process.platform !== "win32" || pointer ? join(resolve(source), launcherName()) : launcher;
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

function shimFor(launcher: string, runtime = process.execPath) {
  if (/[/\\]current[/\\]bin[/\\]sbar-orbit\.cmd$/.test(launcher)) {
    const entry = join(dirname(dirname(dirname(launcher))), "managed-entry.ts");
    const escape = (value: string) => {
      if (/[\r\n\0"]/.test(value)) throw new Error("Invalid managed launcher path");
      return value.replaceAll("%", "%%");
    };
    return `@echo off\r\n@setlocal DisableDelayedExpansion\r\n${SHIM_MARKER}\r\n@rem Target: ${launcher}\r\n@"${escape(runtime)}" run "${escape(entry)}" %*\r\n@exit /b %errorlevel%\r\n`;
  }
  // %* forwards every argument unchanged, and `call` keeps the shim's exit code as the command's.
  return `@echo off\r\n${SHIM_MARKER}\r\n@rem Target: ${launcher}\r\n@call "${launcher}" %*\r\n`;
}

/** The launcher a managed shim forwards to, or null when this is not one of ours. */
export function shimTarget(contents: string) {
  if (!contents.includes(SHIM_MARKER)) return null;
  return /^@call "(.+)" %\*/m.exec(contents)?.[1]
    ?? (/^@setlocal DisableDelayedExpansion\r?$/m.test(contents) ? /^@rem Target: (.+)\r?$/m.exec(contents)?.[1]?.trimEnd() : null)
    ?? null;
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
    const source = dirname(dirname(target));
    const runtime = await info(`${source}.txt`)
      ? JSON.parse(await readFile(join(await managedTarget(dirname(source)), "orbit-release-identity.json"), "utf8")).runtime : process.execPath;
    if (await readFile(link, "utf8") !== shimFor(target, runtime))
      throw new Error("Existing shim action differs from the owned launcher");
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
    if (process.platform === "win32" && await info(`${source}.txt`)) {
      const root = dirname(resolve(source));
      await withUpdateLock(root, async () => {
        const entry = join(root, "managed-entry.ts"), ownership = join(root, "managed-entry-identity.json");
        const existing = await info(entry), recorded = await info(ownership);
        const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
        if (existing || recorded) {
          if (!existing?.isFile() || existing.isSymbolicLink() || !recorded?.isFile() || recorded.isSymbolicLink())
            throw new Error("Stable helper ownership is absent or foreign; migrate deliberately");
          const identity = JSON.parse(await readFile(ownership, "utf8"));
          if (identity.schema !== 1 || identity.root !== root || identity.digest !== hash(await readFile(entry)))
            throw new Error("Stable helper ownership differs; migrate deliberately");
        }
        const bytes = await readFile(join(import.meta.dir, "managed-entry.ts"));
        // Establish a new helper only. Updating two names would create an ambiguous crash window.
        if (existing) {
          if (hash(bytes) !== hash(await readFile(entry)))
            throw new Error("Stable helper upgrade requires deliberate recovery; existing helper retained");
        } else {
          const temporary = `${entry}.${crypto.randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await writeFile(ownership, JSON.stringify({ schema: 1, root, digest: hash(bytes) }) + "\n", { flag: "wx", mode: 0o600 });
            await rename(temporary, entry);
          } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        }
      });
    }
    const temporary = join(bin, `.sbar-orbit-link-${crypto.randomUUID()}`);
    // Both platforms rename onto the live name, because that is the only atomic swap either offers:
    // Linux over a symlink, Windows over a file. Windows cannot rename over a directory at all.
    if (process.platform === "win32") {
      const runtime = await info(`${source}.txt`)
        ? JSON.parse(await readFile(join(await managedTarget(dirname(resolve(source))), "orbit-release-identity.json"), "utf8")).runtime : process.execPath;
      await writeFile(temporary, shimFor(launcher, runtime), "utf8");
    }
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
