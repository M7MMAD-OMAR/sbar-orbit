import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCommittedSource, packageRefArguments } from "../scripts/package-source";
import { registryPackage } from "../scripts/registry-package";
import { tarExecutable } from "../src/platform";
import { needsCommand } from "./platform-support";

const project = resolve(import.meta.dir, "..");
async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error("Owned fixture command failed: " + (err || out));
  return out;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-immutable-package-"));
  await run(["git", "init", "--quiet"], root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "sbar-orbit", version: "9.8.7", bin: { "sbar-orbit": "bin/sbar-orbit" }, files: ["src", "bin", "bun.lock"] }),
    "bun.lock": await Bun.file(join(project, "bun.lock")).text(),
    "LICENSE": "owned license\n", "NOTICE": "owned notice\n",
    "bin/sbar-orbit": "#!/bin/sh\nexit 0\n",
    "src/value.ts": "export const value = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await Bun.write(join(root, path), text);
  }
  await chmod(join(root, "bin/sbar-orbit"), 0o755);
  await run(["git", "add", "."], root);
  await run(["git", "update-index", "--chmod=+x", "bin/sbar-orbit"], root);
  const commit = async () => {
    await run(["git", "-c", "user.name=Owned Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(root, ".git", "disabled-hooks"), "commit", "--quiet", "-m", "owned fixture"], root);
    return (await run(["git", "rev-parse", "HEAD"], root)).trim();
  };
  return { root, files, commit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("package ref arguments accept only complete immutable IDs and preserve optional default", () => {
  const sha = "a".repeat(40);
  expect(packageRefArguments([])).toEqual({});
  expect(packageRefArguments(["out"], true)).toEqual({ destination: "out" });
  expect(packageRefArguments(["--ref", sha, "out"], true)).toEqual({ ref: sha, destination: "out" });
  for (const args of [["--ref"], ["--ref", "HEAD"], ["--ref", "a".repeat(7)], ["--ref", sha, "--ref", sha], ["extra"], ["--unknown"]])
    expect(() => packageRefArguments(args)).toThrow();
  for (const args of [[], ["out", "extra"], ["--ref", sha]]) expect(() => packageRefArguments(args, true)).toThrow();
});

needsCommand("git", "owned immutable packaging fixture")("committed snapshot ignores dirty index, dirty worktree and untracked future imports", async () => {
  const f = await fixture();
  try {
    const ref = await f.commit();
    await Bun.write(join(f.root, "src/value.ts"), "import unfinished from './future';\n");
    await Bun.write(join(f.root, "package.json"), JSON.stringify({ name: "sbar-orbit", version: "99.0.0" }));
    await run(["git", "add", "src/value.ts", "package.json"], f.root);
    await Bun.write(join(f.root, "src/future.ts"), "unfinished untracked\n");
    const snapshot = await readCommittedSource(f.root, ref);
    expect(snapshot.sourceCommit).toBe(ref); expect(snapshot.version).toBe("9.8.7");
    expect(snapshot.files.find(file => file.path === "src/value.ts")?.bytes.toString()).toBe(f.files["src/value.ts"]);
    expect(snapshot.files.some(file => file.path === "src/future.ts")).toBe(false);
    expect(snapshot.files.find(file => file.path === "bin/sbar-orbit")?.executable).toBe(true);
    await expect(readCommittedSource(f.root, "0".repeat(40))).rejects.toThrow();
    const blob = (await run(["git", "rev-parse", ref + ":package.json"], f.root)).trim();
    await expect(readCommittedSource(f.root, blob)).rejects.toThrow("commit object");
    const dirty = await f.commit();
    await run(["git", "replace", ref, dirty], f.root);
    expect((await readCommittedSource(f.root, ref)).version).toBe("9.8.7");
  } finally { await f.cleanup(); }
});

needsCommand("git", "owned immutable path fixture")("committed modes and private paths preserve strict source and filtered registry policies", async () => {
  const f = await fixture();
  try {
    const ref = await f.commit();
    await Bun.write(join(f.root, "src/secret.key"), "private fixture\n");
    await run(["git", "add", "src/secret.key"], f.root);
    const privateRef = await f.commit();
    await expect(readCommittedSource(f.root, privateRef)).rejects.toThrow("Private or invalid");
    expect((await readCommittedSource(f.root, privateRef, { filterPrivate: true })).files.some(file => file.path.endsWith("secret.key"))).toBe(false);
    const blob = (await run(["git", "rev-parse", ref + ":src/value.ts"], f.root)).trim();
    await run(["git", "update-index", "--cacheinfo", "120000," + blob + ",src/value.ts"], f.root);
    const linkRef = await f.commit();
    await expect(readCommittedSource(f.root, linkRef, { filterPrivate: true })).rejects.toThrow("regular blobs");
  } finally { await f.cleanup(); }
});

(process.platform === "linux" && Bun.which("git") ? test : test.skip)("registry --ref keeps committed version, blobs and source receipt despite dirty checkout", async () => {
  const f = await fixture();
  try {
    const ref = await f.commit();
    await Bun.write(join(f.root, "package.json"), JSON.stringify({ name: "sbar-orbit", version: "99.0.0", files: ["src"] }));
    await Bun.write(join(f.root, "src/value.ts"), "import './unfinished';\n");
    await Bun.write(join(f.root, "src/unfinished.ts"), "must not ship\n");
    await run(["git", "add", "package.json", "src/value.ts"], f.root);
    const archive = await registryPackage(join(f.root, "archives"), f.root, { ref });
    expect(archive.endsWith("sbar-orbit-9.8.7.tgz")).toBe(true);
    expect(await run([tarExecutable(), "xOf", archive, "package/src/value.ts"], f.root)).toBe(f.files["src/value.ts"]!);
    expect(await run([tarExecutable(), "tzf", archive], f.root)).not.toContain("unfinished");
    expect(JSON.parse(await run([tarExecutable(), "xOf", archive, "package/package.json"], f.root)).version).toBe("9.8.7");
    expect(JSON.parse(await run([tarExecutable(), "xOf", archive, "package/SOURCE-COMMIT.json"], f.root))).toEqual({ schema: 1, version: "9.8.7", sourceCommit: ref });
    expect(await run([tarExecutable(), "xOf", archive, "package/bun.lock"], f.root)).toBe(f.files["bun.lock"]!);
    await Bun.write(join(f.root, "src/value.ts"), "different dirty bytes and mtime\n");
    const again = await registryPackage(join(f.root, "archives-again"), f.root, { ref });
    expect(Buffer.from(await Bun.file(archive).arrayBuffer()).equals(Buffer.from(await Bun.file(again).arrayBuffer()))).toBe(true);
  } finally { await f.cleanup(); }
}, 60_000);

(process.platform === "linux" && Bun.which("git") ? test : test.skip)("source --ref filename and manifest use committed version, never dirty fixture files", async () => {
  const f = await fixture();
  try {
    // Copy only the packager implementation into this OWNED fixture, not another checkout.
    for (const name of ["package.ts", "package-source.ts", "public-paths.ts", "package-endings.ts", "source-manifest.ts"]) {
      await mkdir(join(f.root, "scripts"), { recursive: true });
      await Bun.write(join(f.root, "scripts", name), await Bun.file(join(project, "scripts", name)).text());
    }
    await Bun.write(join(f.root, "src/resource-budget.ts"), "export async function requireResourceBudget() {}\n");
    await run(["git", "add", "."], f.root);
    const ref = await f.commit();
    await Bun.write(join(f.root, "package.json"), JSON.stringify({ name: "sbar-orbit", version: "99.0.0" }));
    await Bun.write(join(f.root, "src/value.ts"), "dirty future code\n");
    await run(["git", "add", "package.json", "src/value.ts"], f.root);
    const output = await run([process.execPath, "scripts/package.ts", "--ref", ref], f.root);
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(result.sourceCommit).toBe(ref);
    expect(result.archive.endsWith("sbar-orbit-9.8.7-source.tar.gz")).toBe(true);
    const prefix = "sbar-orbit-9.8.7-source";
    const manifest = JSON.parse(await run([tarExecutable(), "xOf", result.archive, prefix + "/SOURCE-MANIFEST.json"], f.root));
    expect(manifest.sourceCommit).toBe(ref); expect(manifest.version).toBe("9.8.7");
    expect(await run([tarExecutable(), "xOf", result.archive, prefix + "/src/value.ts"], f.root)).toBe(f.files["src/value.ts"]!);
  } finally { await f.cleanup(); }
}, 60_000);
