import { isPublicSourcePath } from "../scripts/public-paths";
import { expect, test } from "bun:test";
import { needsGitCheckout } from "./platform-support";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

needsGitCheckout("git ls-files, which needs the repository and not just the binary")("publication audit checks staged blobs and reports identifiers without their values", async () => {
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

needsGitCheckout("git ls-files, which needs the repository and not just the binary")("a systemd template unit is not read as an address, and a real one still is", async () => {
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

/**
 * The macOS refusal list has to catch the call somebody would really write, not the one spelling that
 * happened to get typed into the rule.
 *
 * This exists because an adversarial probe fed the original rules sixteen realistic TCC triggering
 * calls and they caught **two**. `CGWindowListCreateImageFromArray` is a different symbol from
 * `CGWindowListCreateImage`; `CGDisplayCreateImage` was not in the list at all; `screencapture` was
 * anchored to `/usr/sbin/` so a bare spawn walked past; and the cursor warp calls are input even
 * though their names say display. Every one of those is a dialog on the person's screen.
 *
 * Driven through the real script against a real staged file, so this tests the audit rather than a
 * copy of its regexes that could drift away from it.
 */
needsGitCheckout("git ls-files, which needs the repository and not just the binary")(
  "the macOS refusal list catches every realistic spelling, not one", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-tcc-audit-"));
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    return { code: await child.exited, output };
  };
  await run(["git", "init", "-q"]);
  await mkdir(join(root, "src"));
  const command = [process.execPath, resolve("scripts/public-audit.ts")];

  const forbidden: [string, string][] = [
    ["CGWindowListCreateImageFromArray(list)", "macos-screen-recording"],
    ["CGDisplayCreateImage(CGMainDisplayID())", "macos-screen-recording"],
    ["const c = new SCStreamConfiguration()", "macos-screen-recording"],
    ['Bun.spawn(["screencapture", "-x", out])', "macos-screen-recording"],
    ["AXIsProcessTrustedWithOptions(options)", "macos-accessibility"],
    ["CGWarpMouseCursorPosition(point)", "macos-accessibility"],
    ["CGDisplayMoveCursorToPoint(display, point)", "macos-accessibility"],
    ["CGEventTapCreateForPid(pid, place)", "macos-input-monitoring"],
    ["IOHIDPostEvent(service, type)", "macos-input-monitoring"],
    ["NSWorkspace.shared.open(url)", "macos-automation"],
  ];
  for (const [source, rule] of forbidden) {
    await writeFile(join(root, "src/probe.ts"), `export const probe = () => { ${source}; };\n`);
    await run(["git", "add", "src/probe.ts"]);
    const report = JSON.parse((await run(command)).output);
    // Named per case, so a failure says WHICH call slipped through rather than that something did.
    expect(report.findings, `${source} must be refused`).toContainEqual({ file: "src/probe.ts", rule });
  }

  // And the other half of a useful rule: it must not fire on ordinary code. A rule that cries wolf is
  // one people learn to ignore, which is how a real finding gets scrolled past.
  await writeFile(join(root, "src/probe.ts"),
    "export const fine = (symbols: number[]) => symbols[0] === 1 && \"display\".length > 2;\n");
  await run(["git", "add", "src/probe.ts"]);
  const clean = JSON.parse((await run(command)).output);
  expect(clean.findings).toEqual([]);
});
