import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectPrerequisites } from "../src/preflight";
import { stepTitles } from "../src/install";

// docs/agent-install.md is a contract an agent is told to branch on, which makes it code that happens
// to be written in Markdown. A documented field that no longer exists is worse than an undocumented
// one, so the document is checked against the program rather than trusted.
const project = resolve(import.meta.dir, "..");
const contract = await readFile(resolve(project, "docs/agent-install.md"), "utf8");

test("the documented plan command returns the documented report", async () => {
  const prefix = await mkdtemp("/tmp/orbit-agent-contract-");
  try {
    const child = Bun.spawn([resolve(project, "install.sh"), "--dry-run", "--json", "--prefix", prefix],
      { cwd: project, stdout: "pipe", stderr: "pipe" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
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
    expect(report.launcher).toBe(`${prefix}/bin/sbar-orbit`);
    // The one step that does not follow the prefix says what it would do to what is already there.
    const connector = report.steps.find((step: { id: string }) => step.id === "connector");
    expect(["creates", "unchanged", "replaces an earlier configuration"]).toContain(connector.data.replaces);
    expect(connector.data.configuration.mcpServers.orbit.env.ORBIT_SOCKET).toContain("broker.sock");
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
