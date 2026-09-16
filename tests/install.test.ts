import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { blockingPrerequisites, buildNativeRuntime, nativeBuildTools, onPath, runInstall, stepTitles } from "../src/install";
import { InstallDisplay, offerings, supportsDisplay, type StepView } from "../src/install-ui";
import { nativeRuntimeLocations } from "../src/runtime-paths";
import { commandName } from "../src/local-install";
import { tmpdir } from "node:os";

const project = resolve(import.meta.dir, "..");
// No package manager is ever spawned from a test. The dependency step is the one part of the
// installer that reaches the network, and a test that let it would be testing bun, not Orbit.
const refuse = async () => { throw new Error("A test must not run a package manager"); };

async function sandbox() {
  const prefix = await mkdtemp(join(tmpdir(), "orbit-install-prefix-"));
  const config = await mkdtemp(join(tmpdir(), "orbit-install-config-"));
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
      .toEqual(["dependencies", "native", "launcher", "service", "connector", "verify"]);
    expect(await missing(join(box.prefix, "bin", commandName()))).toBe(true);
    expect(await missing(join(box.config, "sbar-orbit/mcp.json"))).toBe(true);
  } finally { await box.restore(); }
}, 20000);

test("an install without a service links the command and writes connector configuration", async () => {
  const box = await sandbox();
  try {
    const report = await runInstall({ prefix: box.prefix, service: false, install: refuse });
    expect(report.installed).toBe(true);
    const link = join(box.prefix, "bin", commandName());
    expect(report.launcher).toBe(link);
    // On Linux the installed command IS the launcher, reached through a symlink, so its own text is
    // there. On Windows it is a shim that forwards to the launcher, so what identifies it is the
    // marker and the target rather than the launcher's contents.
    const installed = await Bun.file(link).text();
    if (process.platform === "win32") {
      expect(installed).toContain("sbar-orbit-managed-shim");
      expect(installed).toContain(commandName());
    } else expect(installed).toContain("Sbar Orbit");
    const written = JSON.parse(await readFile(join(box.config, "sbar-orbit/mcp.json"), "utf8"));
    // The prefix link, which is the path local-install switches between versions, rather than
    // this checkout: configuration written against a source directory does not survive an
    // upgrade or a rollback, and cannot be right on a machine that is not this one.
    expect(written.mcpServers.orbit.command).toBe(link);
    expect(written.mcpServers.orbit.args).toEqual(["mcp"]);
    // The socket path is correct on each platform in that platform's own spelling: a POSIX runtime
    // directory, or %LOCALAPPDATA% with backslashes on Windows. Asserting the POSIX form everywhere
    // would assert the Linux spelling rather than the property, which is that the connector is told
    // the same socket the broker binds.
    expect(written.mcpServers.orbit.env.ORBIT_SOCKET).toContain(join("sbar-orbit", "broker.sock"));
    // Nothing was installed into systemd, so the step that needs a managed broker cannot claim a pass.
    expect(report.steps.find(step => step.id === "service")?.state).toBe("skipped");
    expect(report.steps.find(step => step.id === "verify")?.state).toBe("skipped");
    // A prefix outside PATH is a real limit on the person's next command, so it is carried out.
    const path = report.remedies.find(remedy => remedy.id === "prefix-not-on-path");
    expect(path?.needsElevation).toBe(false);
    // Not every hands-off remedy needs elevation: this one is the person's shell configuration.
    expect(path?.agentMayRun).toBe(false);
    expect(path?.message).toContain(link);
  } finally { await box.restore(); }
}, 20000);

test("an install refuses a directory that is not an Orbit source, and says which step failed", async () => {
  const box = await sandbox();
  const fake = await mkdtemp(join(tmpdir(), "orbit-install-fake-"));
  try {
    await mkdir(join(fake, "bin"), { recursive: true });
    await writeFile(join(fake, "package.json"), JSON.stringify({ name: "not-orbit", version: "1.0.0" }));
    // The launcher name this platform installs, so the fixture is a source tree a real install
    // would accept rather than one that only looks right on Linux.
    await writeFile(join(fake, "bin", commandName()), "#!/bin/sh\n", { mode: 0o755 });
    const report = await runInstall({ source: fake, prefix: box.prefix, service: false, install: refuse });
    expect(report.installed).toBe(false);
    const failed = report.steps.filter(step => step.state === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // It stops at the first failure rather than reporting later steps it never attempted.
    expect(report.steps.at(-1)?.state).toBe("failed");
    expect(await missing(join(box.prefix, "bin", commandName()))).toBe(true);
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
    expect(line).not.toMatch(/[\u2013\u2014]/);
    expect(line.length).toBeLessThan(96);
  }
  expect(offerings.length).toBeGreaterThan(4);
});

test("the native runtime step builds only when asked, and names the tools it lacks", async () => {
  // A source with no runtime, so the step has something to build; nothing here compiles anything.
  const source = await mkdtemp(join(tmpdir(), "orbit-native-source-"));
  // A data home of its own: the runtime is shared between versions now, and a test must never write
  // into the person's real one. tests/native-runtime.test.ts covers where it lands and why.
  const dataHome = await mkdtemp(join(tmpdir(), "orbit-native-data-"));
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  const { shared } = nativeRuntimeLocations(source);
  const runtime = shared.runtime;
  const calls: string[] = [];
  const fake = async (from: string, runtimeDirectory: string) => {
    calls.push(from);
    await mkdir(join(runtimeDirectory, "root/usr/bin"), { recursive: true });
    await writeFile(join(runtimeDirectory, "root/usr/bin/sway"), "#!/bin/sh\n");
    await writeFile(join(runtimeDirectory, "pointer"), "");
    return { ok: true, output: "sway version 1.11" };
  };
  try {
    const present = () => "/usr/bin/tool";
    // A source tree that carries the bootstrap, which is what a clone is and a registry install is not.
    await mkdir(join(source, "experiments/fedora-display"), { recursive: true });
    await writeFile(join(source, "experiments/fedora-display/bootstrap.sh"), "#!/bin/sh\n");
    expect(await buildNativeRuntime(source, { dryRun: true, which: present })).toMatchObject({ state: "skipped", detail: "would run experiments/fedora-display/bootstrap.sh" });
    const lacking = await buildNativeRuntime(source, { which: tool => tool === "cc" ? null : "/usr/bin/tool" });
    expect(lacking).toMatchObject({ state: "failed", detail: "cc missing" });
    expect(lacking.remedies?.[0]).toMatchObject({ id: "no-native-build-tools", needsElevation: true });
    expect(calls).toEqual([]);
    const failing = await buildNativeRuntime(source, { which: present, bootstrap: async () => ({ ok: false, output: "dnf: no such package" }) });
    expect(failing).toMatchObject({ state: "failed", detail: "dnf: no such package" });
    expect(await buildNativeRuntime(source, { which: present, bootstrap: fake })).toMatchObject({ state: "done", data: { runtime } });
    expect(calls).toEqual([source]);
    // Built once, the step is a no-op, and says where the runtime is.
    expect(await buildNativeRuntime(source, { which: () => null, bootstrap: fake })).toMatchObject({ state: "skipped", detail: `already built in ${runtime}` });
    expect(calls).toEqual([source]);
    expect(nativeBuildTools).toContain("wayland-scanner");
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousDataHome;
    await rm(source, { recursive: true, force: true });
    await rm(dataHome, { recursive: true, force: true });
  }
});

/**
 * An install that installs no service does not then fail for the absence of one.
 *
 * On Windows the service step skips by design, because a Chromium family browser cannot run in
 * session 0. `verify` was still gated only on `wantsService`, so it waited 15 seconds for a managed
 * broker nobody had started, reported `verify: failed`, and exited 1 on a machine where every step had
 * actually succeeded. The remedy it printed told the person to read a systemd journal that does not
 * exist there.
 *
 * Found by installing the published release archive on a Windows guest. Nothing in the suite installs
 * the real artifact, which is exactly why it survived: `--no-service` takes a different branch, and
 * the Windows branch had no test at all. See docs/windows-measured.md section 22.
 */
test("an install that installs no service reports verify as skipped, not failed", async () => {
  const box = await sandbox();
  try {
    const report = await runInstall({ prefix: box.prefix, service: false, install: refuse });
    const verify = report.steps.find(step => step.id === "verify");
    const service = report.steps.find(step => step.id === "service");
    expect(service?.state).toBe("skipped");
    // The one that matters: a skipped service cannot produce a failed verification.
    expect(verify?.state).toBe("skipped");
    expect(report.installed).toBe(true);
    // And no remedy sends a person to a journal for a broker that was never installed.
    expect(report.remedies.map(remedy => remedy.id)).not.toContain("broker-silent");
  } finally { await box.restore(); }
});
