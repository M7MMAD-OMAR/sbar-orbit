import { isPublicSourcePath } from "./public-paths";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { requireResourceBudget } from "../src/resource-budget";
import { readVerifiedSource } from "./source-manifest";

await requireResourceBudget();
const project = resolve(import.meta.dir, "..");
const git = async (...args: string[]) => {
  const child = Bun.spawn(["git", "-C", project, ...args], { stdout: "pipe", stderr: "ignore" });
  const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer());
  return { bytes, code: await child.exited };
};
const top = await git("rev-parse", "--show-toplevel");
const fromIndex = top.code === 0 && top.bytes.toString().trim() === project;
let paths: string[];
const verifiedFiles = new Map<string, { bytes: Buffer; executable: boolean }>();
if (fromIndex) {
  const audit = Bun.spawn([process.execPath, join(project, "scripts/public-audit.ts")], { cwd: project, stdout: "inherit", stderr: "inherit" });
  if (await audit.exited) throw new Error("Public index audit failed");
  paths = (await git("ls-files", "--cached", "-z")).bytes.toString().split("\0").filter(Boolean);
} else {
  const source = await readVerifiedSource(project);
  for (const file of source.files) verifiedFiles.set(file.path, file);
  paths = source.files.map(file => file.path);
}
for (const path of paths) {
  if (!isPublicSourcePath(path))
    throw new Error("Private or invalid package input");
}
if (!paths.includes("LICENSE") || !paths.includes("NOTICE")) throw new Error("License and NOTICE must be included");
const bytesFor = async (path: string) => {
  if (!fromIndex) {
    const file = verifiedFiles.get(path);
    if (!file) throw new Error("Missing verified source bytes");
    return file.bytes;
  }
  const result = await git("show", `:${path}`);
  if (result.code) throw new Error("Cannot read staged package input");
  return result.bytes;
};
const pkg = JSON.parse((await bytesFor("package.json")).toString());
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error("Invalid package version");
const name = `sbar-orbit-${pkg.version}-source`;
const staging = await mkdtemp("/tmp/orbit-package-");
const root = join(staging, name);
await mkdir(root);
const manifest: { path: string; sha256: string }[] = [];
for (const path of [...new Set(paths)].sort()) {
  let executable: boolean;
  if (fromIndex) {
    const mode = (await git("ls-files", "--stage", "--", path)).bytes.toString().split(" ")[0];
    if (!["100644", "100755"].includes(mode ?? "")) throw new Error("Package inputs must be regular files");
    executable = mode === "100755";
  } else {
    const file = verifiedFiles.get(path);
    if (!file) throw new Error("Missing verified source metadata");
    executable = file.executable;
  }
  const bytes = await bytesFor(path), target = join(root, path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, bytes); await chmod(target, executable ? 0o755 : 0o644);
  manifest.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(join(root, "SOURCE-MANIFEST.json"), JSON.stringify({ version: pkg.version, files: manifest }, null, 2) + "\n");
const output = join(project, "output/packages"); await mkdir(output, { recursive: true });
const archive = join(output, `${name}.tar.gz`);
if (await Bun.file(archive).exists()) throw new Error("Archive already exists; use a new version instead of replacing it");
const tar = Bun.spawn(["/usr/bin/tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", staging, name], { stdout: "inherit", stderr: "inherit" });
if (await tar.exited) throw new Error("Source packaging failed");
const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
console.log(JSON.stringify({ archive, sha256, files: manifest.length, source: fromIndex ? "reviewed-git-index" : "source-manifest", includesDependencies: false, includesNativeRuntime: false }));
