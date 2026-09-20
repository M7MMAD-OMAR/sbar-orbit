import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Produce the installable registry artifact, including its frozen dependency lock. */
export async function registryPackage(destination: string, source = resolve(import.meta.dir, "..")) {
  const staging = await mkdtemp(join(tmpdir(), "orbit-registry-"));
  async function run(args: string[]) {
    const child = Bun.spawn(args, { cwd: source, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Registry packaging failed (${code}): ${err || out}`);
  }
  try {
    await run([process.execPath, "pm", "pack", "--destination", staging]);
    const archives = (await readdir(staging)).filter(name => name.endsWith(".tgz"));
    const name = archives[0];
    if (archives.length !== 1 || !name) throw new Error("Expected exactly one registry archive");
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await run(["tar", "xzf", join(staging, name), "-C", unpacked]);
    // Bun 1.4.2 excludes root lockfiles unconditionally, even explicit files entries.
    // Retain Bun's package selection, then add the source lock required by install.
    await copyFile(join(source, "bun.lock"), join(unpacked, "package", "bun.lock"));
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
