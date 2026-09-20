import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectPrerequisites } from "../src/preflight";
import { stepTitles } from "../src/install";
import { launcherName } from "../src/update";
import { bareLineFeeds } from "../scripts/package-endings";
import { tmpdir } from "node:os";

// docs/agent-install.md is a contract an agent is told to branch on, which makes it code that happens
// to be written in Markdown. A documented field that no longer exists is worse than an undocumented
// one, so the document is checked against the program rather than trusted.
const project = resolve(import.meta.dir, "..");
const contract = await readFile(resolve(project, "docs/agent-install.md"), "utf8");

/** The installer this platform actually runs, which is the one the contract tells an agent to call. */
const installer = resolve(project, process.platform === "win32" ? "install.cmd" : "install.sh");

test("one install command registers all selected hosts and repeating it preserves their entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-connect-contract-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"), HERMES_HOME: join(root, "hermes"),
    XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "appdata") };
  // Every run is timed and its host states kept, because the one failure of this test in a full suite
  // run could not be attributed afterwards: a timeout, a nonzero exit and a wrong host state all left
  // the same "two installer-contract failures" behind. The assertion that discarded the installer's
  // stderr was fixed; the one that discarded WHICH run and HOW LONG it took was not, so a recurrence
  // still could not be read. The trace is only ever added to a failure message.
  const trace: string[] = [];
  const label = (extra: string[]) => extra.join(" ") || "install";
  const run = async (extra: string[] = []) => {
    const started = performance.now();
    const child = Bun.spawn([installer, "--no-service", "--connect", "claude,codex,hermes",
      "--prefix", join(root, "prefix with spaces"), "--json", ...extra],
      { env, cwd: project, stdout: "pipe", stderr: "pipe" });
    const [output, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const elapsedMs = Math.round(performance.now() - started);
    if (exit !== 0) {
      trace.push(`${label(extra)}: exit ${exit} after ${elapsedMs} ms :: ${(stderr || output).trim().slice(0, 400)}`);
      throw new Error(`Installer exited ${exit} after ${elapsedMs} ms: ${stderr || output}`);
    }
    expect(exit).toBe(0);
    const report = JSON.parse(output);
    expect(report.installed).toBe(true);
    const registration = report.steps.find((step: { id: string }) => step.id === "hosts").data.registration;
    trace.push(`${label(extra)}: exit 0 after ${elapsedMs} ms, hosts ${registration.map((host: { state: string }) => host.state).join(",")}`);
    return registration;
  };
  const states = (registration: { state: string }[]) => registration.map(host => host.state);
  try {
    expect(states(await run(["--dry-run"]))).toEqual(["planned", "planned", "planned"]);
    expect(states(await run())).toEqual(["configured", "configured", "configured"]);
    expect(states(await run())).toEqual(["unchanged", "unchanged", "unchanged"]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRuns: ${trace.join(" | ")}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

test("the documented plan command returns the documented report", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "orbit-agent-contract-"));
  try {
    const started = performance.now();
    const child = Bun.spawn([installer, "--dry-run", "--json", "--prefix", prefix],
      { cwd: project, stdout: "pipe", stderr: "pipe" });
    const [text, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const elapsedMs = Math.round(performance.now() - started);
    if (code !== 0) throw new Error(`Installer plan exited ${code} after ${elapsedMs} ms: ${stderr || text}`);
    expect(code).toBe(0);
    const report = JSON.parse(text);
    // Every field the contract tells an agent to read.
    expect(report).toMatchObject({ installed: true, dryRun: true, source: project });
    expect(typeof report.launcher).toBe("string");
    expect(typeof report.verified).toBe("string");
    expect(Object.keys(report.capabilities).sort()).toEqual(["browserSessions", "nativeSessions"]);
    expect(report.steps.map((step: { id: string }) => step.id)).toEqual(stepTitles.map(step => step.id));
    for (const step of report.steps) {
      expect(["done", "skipped", "failed"]).toContain(step.state);
      expect(typeof step.detail).toBe("string");
      expect(Number.isInteger(step.elapsedMs)).toBe(true);
    }
    for (const remedy of report.remedies) {
      expect(typeof remedy.id).toBe("string");
      expect(typeof remedy.message).toBe("string");
      expect(typeof remedy.needsElevation).toBe("boolean");
      expect(typeof remedy.agentMayRun).toBe("boolean");
      // A command needing a package manager is never one an agent may run.
      if (remedy.needsElevation) expect(remedy.agentMayRun).toBe(false);
      // Software is named portably. The command, when there is one, is this machine's package manager.
      if (remedy.packages) expect(Array.isArray(remedy.packages)).toBe(true);
    }
    // A dry run names where the command would go, not where the source happens to be.
    // Each platform's own launcher name and separator: `bin/sbar-orbit` here, `bin\\sbar-orbit.cmd`
    // on Windows. Hardcoding the POSIX spelling asserted the separator rather than the property.
    expect(report.launcher).toBe(join(prefix, launcherName()));
    // The one step that does not follow the prefix says what it would do to what is already there.
    const connector = report.steps.find((step: { id: string }) => step.id === "connector");
    expect(["creates", "unchanged", "replaces an earlier configuration"]).toContain(connector.data.replaces);
    expect(connector.data.configuration.mcpServers.orbit.env.ORBIT_SOCKET).toContain("broker.sock");
    // What an agent host is told to run: the launcher this run reports, and nothing that names
    // an interpreter, a checkout or a version.
    expect(connector.data.configuration.mcpServers.orbit.command).toBe(report.launcher);
    expect(connector.data.configuration.mcpServers.orbit.args).toEqual(["mcp"]);
  } finally { await rm(prefix, { recursive: true, force: true }); }
}, 60000);

test("every remedy the prerequisite check can emit is documented", async () => {
  // A machine with nothing on it, so every remedy is produced at once.
  const bare = await inspectPrerequisites("/fixture", {
    platform: "linux", file: async () => false, module: () => false, which: () => null, userManager: async () => false,
    missingLibraries: () => [],
  });
  const ids = [...new Set(bare.checks.map(check => check.remedy?.id).filter(Boolean))];
  expect(ids.length).toBeGreaterThan(6);
  for (const id of ids) expect(contract).toContain(`\`${id}\``);
});

test("every step the installer reports is documented, and so is the elevation boundary", () => {
  for (const step of stepTitles) expect(contract).toContain(`\`${step.id}\``);
  // The two remedies only the installer itself can produce, which the prerequisite check never sees.
  for (const id of ["prefix-not-on-path", "no-lingering", "broker-did-not-start", "broker-silent"])
    expect(contract).toContain(`\`${id}\``);
  expect(contract).toContain("needsElevation");
  expect(contract).toContain("agentMayRun");
  // The portable field, and every package manager a command can be built for.
  expect(contract).toContain("`packages`");
  for (const manager of ["dnf", "apt", "pacman", "zypper", "apk"]) expect(contract).toContain(manager);
  // The sentence the contract tells an agent to repeat rather than drop.
  expect(contract).toContain("not a measurement");
});

/**
 * The two installers are two doors into one installer, and the contract says so. This is what keeps
 * that sentence true.
 *
 * `install.sh` was the only entry point the contract named, while the contract also says it is "not
 * written for one operating system either". On Windows the documented install therefore did not
 * exist: an agent following this file had nothing it could run. Both files now delegate to
 * `scripts/install.ts`, and this test fails if either stops doing so, or if the document goes back to
 * naming only one of them.
 */
test("both documented installers exist, delegate to the same installer, and are both documented", async () => {
  const shell = await readFile(resolve(project, "install.sh"), "utf8");
  const windows = await readFile(resolve(project, "install.cmd"), "utf8");

  // One installer, two doors. A second implementation is the failure this guards against: it would
  // drift, and the drift would only ever be found on the platform nobody was testing.
  expect(shell).toContain("scripts/install.ts");
  expect(windows).toContain("scripts\\install.ts");
  // Both go through the budget wrapper, so neither door lets a run escape the shared budget.
  expect(shell).toContain("scripts/limited.ts");
  expect(windows).toContain("scripts\\limited.ts");

  // The contract names both, since an agent on Windows reads the same file.
  expect(contract).toContain("install.cmd --json");
  expect(contract).toContain("./install.sh --json");

  // cmd.exe reads a batch file byte by byte and a multi line block in an LF-only file is where that
  // goes wrong, which is why .gitattributes pins *.cmd to CRLF. Asserted rather than trusted: a file
  // checked out with LF endings fails in a way that reads like a broken installer.
  expect(bareLineFeeds(windows)).toEqual([]);
});
