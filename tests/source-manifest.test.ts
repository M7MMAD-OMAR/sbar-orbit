import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readVerifiedSource } from "../scripts/source-manifest";

async function fixture() {
  const root = await mkdtemp("/tmp/orbit-manifest-test-");
  const contents = { "package.json": '{"name":"sbar-orbit","version":"0.1.0-alpha.1"}', LICENSE: "Fixture license", NOTICE: "Fixture notice", "bin/sbar-orbit": "#!/bin/sh\nexit 0\n" };
  await mkdir(join(root, "bin"));
  const files = [];
  for (const [path, text] of Object.entries(contents)) {
    await writeFile(join(root, path), text, { mode: path.startsWith("bin/") ? 0o755 : 0o644 });
    files.push({ path, sha256: createHash("sha256").update(text).digest("hex") });
  }
  const manifest = { version: "0.1.0-alpha.1", files };
  const save = () => writeFile(join(root, "SOURCE-MANIFEST.json"), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

test("verified source retains exact bytes and rejects later content changes", async () => {
  const f = await fixture(), verified = await readVerifiedSource(f.root);
  expect(verified.files.length).toBe(4);
  expect(verified.files.find(file => file.path === "bin/sbar-orbit")?.executable).toBe(true);
  await writeFile(join(f.root, "NOTICE"), "Changed");
  expect(verified.files.find(file => file.path === "NOTICE")?.bytes.toString()).toBe("Fixture notice");
  await expect(readVerifiedSource(f.root)).rejects.toThrow("content mismatch");
});

test("manifest rejects duplicate/private/traversal paths and mismatched versions", async () => {
  for (const path of ["LICENSE", "../outside", ".private/.env.example", "SOURCE-MANIFEST.json"]) {
    const f = await fixture();
    f.manifest.files.push({ path, sha256: "0".repeat(64) }); await f.save();
    await expect(readVerifiedSource(f.root)).rejects.toThrow("Invalid source manifest entry");
  }
  const f = await fixture(); f.manifest.version = "0.1.0-alpha.2"; await f.save();
  await expect(readVerifiedSource(f.root)).rejects.toThrow("version mismatch");
});

test("source cannot follow a symlinked parent even when content hashes match", async () => {
  const f = await fixture();
  await rename(join(f.root, "bin"), join(f.root, "other-bin"));
  await symlink(join(f.root, "other-bin"), join(f.root, "bin"));
  await expect(readVerifiedSource(f.root)).rejects.toThrow("without linked parents");
});

test("the extracted-source packager refuses altered content before creating an archive", async () => {
  const f = await fixture(), project = resolve(import.meta.dir, "..");
  for (const path of ["scripts/package.ts", "scripts/public-paths.ts", "scripts/source-manifest.ts"]) {
    await mkdir(dirname(join(f.root, path)), { recursive: true });
    await writeFile(join(f.root, path), await readFile(join(project, path)));
  }
  // Isolate manifest enforcement from systemd availability in this packaging fixture.
  // Local execution still inherits the test runner's resource scope.
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src/resource-budget.ts"), "export async function requireResourceBudget() {}\n");
  await writeFile(join(f.root, "NOTICE"), "Altered after extraction");
  const child = Bun.spawn([process.execPath, join(f.root, "scripts/package.ts")], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("content mismatch");
  expect(stdout).not.toContain('"archive"');
});
