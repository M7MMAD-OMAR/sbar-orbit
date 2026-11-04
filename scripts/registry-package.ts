import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { isPublicSourcePath } from "./public-paths";
import { tarExecutable } from "../src/platform";
import { immutableTarArguments, packageRefArguments, readCommittedSource } from "./package-source";

type RegistryStage = { staging: string; unpacked: string; name: string; committed: boolean; run: (args: string[], cwd?: string) => Promise<string> };
/** One audited selection boundary shared by archive production and immutable directory staging. */
async function withRegistryStage<T>(source: string, options: { ref?: string }, consume: (stage: RegistryStage) => Promise<T>): Promise<T> {
  const committed = options.ref === undefined ? undefined : await readCommittedSource(source, options.ref, { filterPrivate: true });
  const committedFiles = new Map(committed?.files.map(file => [file.path, file]));
  const staging = await createWorkspaceDirectory("registry");
  async function run(args: string[], cwd = source) {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe",
      ...(committed ? { env: { ...process.env, TAR_OPTIONS: undefined, GZIP: undefined } } : {}) });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Registry packaging failed (${code}): ${err || out}`);
    return out;
  }
  try {
    const tracked = committed ? committed.files.map(file => file.path) : (await run(["git", "ls-files", "--cached", "-z"])).split("\0").filter(isPublicSourcePath);
    if (!tracked.includes("bun.lock")) throw new Error("Registry packaging requires a tracked bun.lock");
    const checkout = join(staging, "source");
    await mkdir(checkout);
    const checkedDirectories = new Set<string>();
    // Default: tracked working-tree bytes. With --ref: only validated committed blobs.
    // Never copy directories recursively, including submodules with untracked contents.
    for (const path of new Set(tracked)) {
      const immutable = committedFiles.get(path);
      if (immutable) {
        const output = join(checkout, path);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, immutable.bytes, { flag: "wx" });
        await chmod(output, immutable.executable ? 0o755 : 0o644);
        continue;
      }
      // Check parents from the root down before opening the file. A replaced source
      // directory can otherwise redirect an ordinary tracked file outside the checkout.
      let parent = source;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if (checkedDirectories.has(parent)) continue;
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error(`Registry packaging refuses tracked symlink: ${path}`);
        checkedDirectories.add(parent);
      }
      const input = join(source, path);
      const info = await lstat(input);
      if (info.isSymbolicLink()) throw new Error(`Registry packaging refuses tracked symlink: ${path}`);
      if (!info.isFile()) continue;
      const output = join(checkout, path);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(input, output);
      await chmod(output, info.mode);
    }
    await run([process.execPath, "pm", "pack", "--destination", staging], checkout);
    const archives = (await readdir(staging)).filter(name => name.endsWith(".tgz"));
    const name = archives[0];
    if (committed && name !== `sbar-orbit-${committed.version}.tgz`) throw new Error("Registry archive name differs from committed version");
    if (archives.length !== 1 || !name) throw new Error("Expected exactly one registry archive");
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await run([tarExecutable(), "xzpf", join(staging, name), "-C", unpacked]);
    // Bun 1.4.2 excludes root lockfiles unconditionally, even explicit files entries.
    // Retain Bun's package selection, then add the source lock required by install.
    await copyFile(join(checkout, "bun.lock"), join(unpacked, "package", "bun.lock"));
    if (committed) {
      const pkg = await Bun.file(join(unpacked, "package", "package.json")).json();
      if (pkg.name !== "sbar-orbit" || pkg.version !== committed.version) throw new Error("Packed identity differs from committed version");
      await writeFile(join(unpacked, "package", "SOURCE-COMMIT.json"), JSON.stringify({ schema: 1, version: committed.version, sourceCommit: committed.sourceCommit }) + "\n", { flag: "wx" });
    }
    return await consume({ staging, unpacked, name, committed: committed !== undefined, run });
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Produce the unchanged installable registry archive, retaining the canonical GNU/Linux ref guard. */
export async function registryPackage(destination: string, source = resolve(import.meta.dir, ".."), options: { ref?: string } = {}) {
  return withRegistryStage(source, options, async ({ staging, unpacked, name, committed, run }) => {
    const complete = join(staging, "complete.tgz");
    await run(committed ? await immutableTarArguments(tarExecutable(), complete, unpacked, "package")
      : [tarExecutable(), "czf", complete, "-C", unpacked, "package"]);
    await mkdir(destination, { recursive: true });
    const output = join(destination, name);
    // A completed artifact must not replace another release without an explicit cleanup.
    await copyFile(complete, output, constants.COPYFILE_EXCL);
    return output;
  });
}

/** Fresh immutable directory, using Bun's exact registry selection before canonical archive creation. */
export async function registryPackageDirectory(destination: string, source = resolve(import.meta.dir, ".."), options: { ref: string }) {
  if (!options || typeof options.ref !== "string" || !/^[a-fA-F0-9]{40}$/.test(options.ref)) throw new Error("Registry directory staging requires a full immutable --ref");
  source = await realpath(resolve(source)); destination = resolve(destination);
  if (destination === source || destination.startsWith(source + sep) || source.startsWith(destination + sep)) throw new Error("Registry directory output must be outside its source checkout");
  const parent = dirname(destination), parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("Registry directory output requires a canonical existing parent");
  if (await lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Registry directory output must be new and exclusive");
  return withRegistryStage(source, options, async ({ unpacked }) => {
    const input = join(unpacked, "package"); let created = false, count = 0, bytes = 0;
    try {
      // Recheck after all packing work, then create exclusively. Never replace an existing destination.
      if (await realpath(parent) !== parent || (await lstat(parent)).isSymbolicLink()) throw new Error("Registry output parent changed");
      await mkdir(destination, { mode: 0o700 }); created = true;
      async function copy(relative: string, depth: number) {
        if (++count > 20000 || depth > 32 || relative.length > 512) throw new Error("Registry directory entry bound exceeded");
        const from = relative ? join(input, relative) : input, to = relative ? join(destination, relative) : destination, info = await lstat(from);
        if (info.isSymbolicLink() || await realpath(from) !== resolve(from)) throw new Error("Registry directory contains a redirected entry");
        if (info.isDirectory()) {
          if (relative) await mkdir(to, { mode: 0o700 });
          for (const name of (await readdir(from)).sort()) await copy(relative ? relative + "/" + name : name, depth + 1);
          await chmod(to, 0o755);
        } else if (info.isFile()) {
          bytes += info.size; if (info.size > 128 * 1024 * 1024 || bytes > 512 * 1024 * 1024 || info.mode & 0o7000) throw new Error("Registry directory byte or mode bound exceeded");
          await copyFile(from, to, constants.COPYFILE_EXCL);
          // Same ordinary 0644/0755 result as immutable GNU --mode=u+rwX,go+rX,go-w.
          await chmod(to, info.mode & 0o111 ? 0o755 : 0o644);
        } else throw new Error("Registry directory requires only regular files and directories");
      }
      await copy("", 0); return destination;
    } catch (error) {
      if (created) await rm(destination, { recursive: true, force: true }); throw error;
    }
  });
}

if (import.meta.main) {
  const { destination, ref } = packageRefArguments(process.argv.slice(2), true);
  console.log(await registryPackage(resolve(destination!), undefined, { ref }));
}
