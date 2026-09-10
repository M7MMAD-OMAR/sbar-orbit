import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("publication audit checks staged blobs and reports identifiers without their values", async () => {
  const root = await mkdtemp("/tmp/orbit-public-audit-");
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    return { code: await child.exited, output };
  };
  await run(["git", "init", "-q"]);
  const privatePath = ["", "home", "fixture-person", "workspace"].join("/");
  await writeFile(join(root, "README.md"), privatePath);
  await run(["git", "add", "README.md"]);
  const command = [process.execPath, resolve("scripts/public-audit.ts")];
  const rejected = await run(command);
  expect(rejected.code).toBe(1);
  expect(rejected.output).toContain("personal-home-path");
  expect(rejected.output).not.toContain(privatePath);
  await writeFile(join(root, "README.md"), "Public project documentation");
  expect((await run(command)).code).toBe(1);
  await run(["git", "add", "README.md"]);
  expect((await run(command)).code).toBe(0);
  await writeFile(join(root, ".env"), "FIXTURE_ONLY=example");
  await run(["git", "add", ".env"]);
  expect((await run(command)).output).toContain("private-or-generated-path");
});
