import { chmod, copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { isPublicSourcePath } from "./public-paths";

/** Produce the installable registry artifact, including its frozen dependency lock. */
export async function registryPackage(destination: string, source = resolve(import.meta.dir, "..")) {
  const staging = await createWorkspaceDirectory("registry");
  async function run(args: string[], cwd = source) {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Registry packaging failed (${code}): ${err || out}`);
    return out;
  }
  try {
    const tracked = (await run(["git", "ls-files", "--cached", "-z"])).split("\0").filter(isPublicSourcePath);
    if (!tracked.includes("bun.lock")) throw new Error("Registry packaging requires a tracked bun.lock");
    const checkout = join(staging, "source");
    await mkdir(checkout);
    const checkedDirectories = new Set<string>();
    // Git selects the paths; the working tree supplies their current bytes and modes.
    // Never copy directories recursively, including submodules with untracked contents.
    for (const path of new Set(tracked)) {
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
    if (archives.length !== 1 || !name) throw new Error("Expected exactly one registry archive");
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await run(["tar", "xzf", join(staging, name), "-C", unpacked]);
    // Bun 1.4.2 excludes root lockfiles unconditionally, even explicit files entries.
    // Retain Bun's package selection, then add the source lock required by install.
    await copyFile(join(checkout, "bun.lock"), join(unpacked, "package", "bun.lock"));
    const complete = join(staging, "complete.tgz");
    await run(["tar", "czf", complete, "-C", unpacked, "package"]);
    await mkdir(destination, { recursive: true });
    const output = join(destination, name);
    // A completed artifact must not replace another release without an explicit cleanup.
    await copyFile(complete, output, constants.COPYFILE_EXCL);
    return output;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: bun scripts/registry-package.ts <output-directory>");
  console.log(await registryPackage(resolve(destination)));
}
