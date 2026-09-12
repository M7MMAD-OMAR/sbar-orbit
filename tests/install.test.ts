import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { blockingPrerequisites, onPath, runInstall, stepTitles } from "../src/install";
import { InstallDisplay, offerings, supportsDisplay, type StepView } from "../src/install-ui";

const project = resolve(import.meta.dir, "..");
// No package manager is ever spawned from a test. The dependency step is the one part of the
// installer that reaches the network, and a test that let it would be testing bun, not Orbit.
const refuse = async () => { throw new Error("A test must not run a package manager"); };

async function sandbox() {
  const prefix = await mkdtemp("/tmp/orbit-install-prefix-");
  const config = await mkdtemp("/tmp/orbit-install-config-");
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  return { prefix, config, async restore() {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(prefix, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  } };
}

const missing = (path: string) => stat(path).then(() => false, () => true);

test("a dry run reports every step and changes nothing", async () => {
  const box = await sandbox();
  try {
    const report = await runInstall({ prefix: box.prefix, dryRun: true, install: refuse });
    expect(report.installed).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.steps.map(step => step.id)).toEqual(stepTitles.map(step => step.id));
    // The first step only reads, so it runs for real even here. Everything that writes is skipped.
    expect(report.steps.filter(step => step.state === "skipped").map(step => step.id))
      .toEqual(["dependencies", "launcher", "service", "connector", "verify"]);
    expect(await missing(join(box.prefix, "bin/sbar-orbit"))).toBe(true);
    expect(await missing(join(box.config, "sbar-orbit/mcp.json"))).toBe(true);
  } finally { await box.restore(); }
}, 20000);

test("an install without a service links the command and writes connector configuration", async () => {
  const box = await sandbox();
  try {
    const report = await runInstall({ prefix: box.prefix, service: false, install: refuse });
    expect(report.installed).toBe(true);
    const link = join(box.prefix, "bin/sbar-orbit");
    expect(report.launcher).toBe(link);
    expect(await Bun.file(link).text()).toContain("Sbar Orbit");
    const written = JSON.parse(await readFile(join(box.config, "sbar-orbit/mcp.json"), "utf8"));
    expect(written.mcpServers.orbit.args[0]).toBe(join(project, "src/mcp.ts"));
    expect(written.mcpServers.orbit.env.ORBIT_SOCKET).toContain("sbar-orbit/broker.sock");
    // Nothing was installed into systemd, so the step that needs a managed broker cannot claim a pass.
    expect(report.steps.find(step => step.id === "service")?.state).toBe("skipped");
    expect(report.steps.find(step => step.id === "verify")?.state).toBe("skipped");
    // A prefix outside PATH is a real limit on the person's next command, so it is carried out.
    const path = report.remedies.find(remedy => remedy.id === "prefix-not-on-path");
    expect(path?.needsElevation).toBe(false);
    expect(path?.message).toContain(link);
  } finally { await box.restore(); }
}, 20000);

test("an install refuses a directory that is not an Orbit source, and says which step failed", async () => {
  const box = await sandbox();
  const fake = await mkdtemp("/tmp/orbit-install-fake-");
  try {
    await mkdir(join(fake, "bin"), { recursive: true });
    await writeFile(join(fake, "package.json"), JSON.stringify({ name: "not-orbit", version: "1.0.0" }));
    await writeFile(join(fake, "bin/sbar-orbit"), "#!/bin/sh\n", { mode: 0o755 });
    const report = await runInstall({ source: fake, prefix: box.prefix, service: false, install: refuse });
    expect(report.installed).toBe(false);
    const failed = report.steps.filter(step => step.state === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // It stops at the first failure rather than reporting later steps it never attempted.
    expect(report.steps.at(-1)?.state).toBe("failed");
    expect(await missing(join(box.prefix, "bin/sbar-orbit"))).toBe(true);
  } finally {
    await rm(fake, { recursive: true, force: true });
    await box.restore();
  }
}, 20000);

test("the checks a dependency install can fix are separated from the ones it cannot", () => {
  const checks = [
    { id: "linux", group: "common", available: false },
    { id: "zod", group: "common", available: false },
    { id: "playwright", group: "common", available: false },
    { id: "chrome-or-chromium", group: "browser", available: false },
  ] satisfies { id: string; group: "common" | "browser" | "native"; available: boolean }[];
  expect(blockingPrerequisites(checks).map(check => check.id)).toEqual(["linux"]);
});

test("PATH membership is read, not guessed", () => {
  expect(onPath("/opt/example/one/bin", "/usr/bin:/opt/example/one/bin")).toBe(true);
  expect(onPath("/opt/example/one/bin/", "/usr/bin:/opt/example/one/bin")).toBe(true);
  expect(onPath("/opt/example/one/bin", "/usr/bin:/opt/example/two/bin")).toBe(false);
  expect(onPath("/opt/example/one/bin", "")).toBe(false);
});

test("the display prints one line per change without a terminal, and leaves the cursor alone", () => {
  const written: string[] = [];
  const views: StepView[] = stepTitles.map(step => ({ ...step, state: "pending", detail: "", elapsedMs: 0 }));
  const display = new InstallDisplay(text => written.push(text), false);
  display.start(views);
  views[0]!.state = "running";
  display.update(views);
  views[0]!.state = "done"; views[0]!.detail = "all present";
  display.update(views);
  display.stop();
  const text = written.join("");
  expect(text).toContain("S B A R   O R B I T");
  expect(text).toContain(`  ${stepTitles[0]!.title} ...`);
  expect(text).toContain(`✔ ${stepTitles[0]!.title}: all present`);
  expect(text).not.toContain("\x1b[?25l");
  expect(text).not.toContain("\x1b[2m");
});

test("the live display repaints in place and always restores the cursor", () => {
  const written: string[] = [];
  const views: StepView[] = stepTitles.map(step => ({ ...step, state: "pending", detail: "", elapsedMs: 0 }));
  const display = new InstallDisplay(text => written.push(text), true);
  display.start(views);
  views[0]!.state = "done"; views[0]!.elapsedMs = 1200;
  display.update(views);
  display.setNote(offerings[0]!);
  display.stop();
  const text = written.join("");
  expect(text).toContain("\x1b[?25l");
  expect(text).toContain("\x1b[?25h");
  expect(text).toContain("\x1b[0J");
  // The progress count is what the steps reported, never a step that has not finished.
  expect(text).toContain(`1/${stepTitles.length}`);
  expect(text).toContain("1.2s");
  expect(text).toContain(offerings[0]!);
});

test("a terminal is required before anything is repainted", () => {
  expect(supportsDisplay({ isTTY: true }, {})).toBe(true);
  expect(supportsDisplay({ isTTY: false }, {})).toBe(false);
  expect(supportsDisplay({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  expect(supportsDisplay({ isTTY: true }, { TERM: "dumb" })).toBe(false);
});

test("nothing the installer shows a person claims more than the project has measured", () => {
  for (const line of offerings) {
    expect(line).not.toMatch(/[–—]/);
    expect(line.length).toBeLessThan(96);
  }
  expect(offerings.length).toBeGreaterThan(4);
});
