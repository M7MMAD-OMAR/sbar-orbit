import { isPublicSourcePath } from "../scripts/public-paths";
import { expect, test } from "bun:test";
import { needsCommand } from "./platform-support";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

needsCommand("git", "git ls-files")("publication audit checks staged blobs and reports identifiers without their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-public-audit-"));
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
  await mkdir(join(root, ".private"));
  await writeFile(join(root, ".private/.env.example"), "FIXTURE_ONLY=example");
  await run(["git", "add", ".private/.env.example"]);
  const hiddenExample = JSON.parse((await run(command)).output);
  expect(hiddenExample.findings).toContainEqual({ file: ".private/.env.example", rule: "private-or-generated-path" });
  await run(["git", "rm", "--cached", ".private/.env.example"]);
  await writeFile(join(root, ".env.example"), "FIXTURE_ONLY=example");
  await run(["git", "add", ".env.example"]);
  expect((await run(command)).code).toBe(0);
  await writeFile(join(root, ".env"), "FIXTURE_ONLY=example");
  await run(["git", "add", ".env"]);
  expect((await run(command)).output).toContain("private-or-generated-path");
});


test("publication path policy keeps private directories excluded even for example filenames", () => {
  for (const path of [".private/.env.example", "output/.env.example", "docs/evidence/.env.example", ".git/config", ".env.production.env.example", "../README.md", "docs//README.md", "docs/../README.md"])
    expect(isPublicSourcePath(path)).toBe(false);
  for (const path of [".env.example", "examples/.env.example", "README.md", ".github/workflows/checks.yml"])
    expect(isPublicSourcePath(path)).toBe(true);
});

needsCommand("git", "git ls-files")("a systemd template unit is not read as an address, and a real one still is", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-audit-units-"));
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "ignore" });
    return { code: await child.exited, output: await new Response(child.stdout).text() };
  };
  await run(["git", "init", "-q"]);
  const command = [process.execPath, resolve("scripts/public-audit.ts")];
  // The unit this project's own installer starts. A rule that cannot write it down stops the
  // documentation rather than a leak, which is what it did when the fresh-machine experiment landed.
  await writeFile(join(root, "units.md"), [
    "systemctl --user status user@1000.service",
    "The template is user@.service and the instance is user@1000.service.",
    "sbarorbit.slice is a slice, and orbit@1.timer is a timer.",
  ].join("\n"));
  await run(["git", "add", "units.md"]);
  const units = await run(command);
  expect(units.code).toBe(0);
  expect(units.output).not.toContain("email-needs-publication-review");
  // The case the skip list is built around, and the reason every suffix in it is singular: `.services`
  // is a real top level domain and `.service` is not, so an address at a `.services` domain has to
  // stay a finding. Assembled rather than written, the way the home path above is, so this file does
  // not carry an address itself.
  const address = ["sales", "acme.services"].join("@");
  await writeFile(join(root, "units.md"), `user@1000.service, and ${address}`);
  await run(["git", "add", "units.md"]);
  const mixed = await run(command);
  expect(mixed.code).toBe(1);
  expect(mixed.output).toContain("email-needs-publication-review");
  expect(mixed.output).not.toContain(address);
});
