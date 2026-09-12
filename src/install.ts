import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { inspectPrerequisites } from "./preflight";
import { activateLocal } from "./local-install";
import { installService, serviceSocketPath } from "./service";
import { enableAutostart, autostartStatus } from "./autostart";
import { call } from "./ipc";
import { OrbitError } from "./errors";

/**
 * One command that does every part of an Orbit installation this user can do without elevation, and
 * that says plainly which parts nobody can do for them.
 *
 * The steps are deliberately thin: each one calls the module that already owns that job, so there is
 * one implementation of linking a launcher, writing units and reading prerequisites, not two. What is
 * new here is the order, the fact that a failure carries its own remedy, and that the report
 * distinguishes "this did not run" from "this passed".
 *
 * It installs nothing that needs root. Bun, Chrome, Xwayland and the Fedora capture tools are the
 * person's package manager's job, and a step that pretended otherwise would be lying about a failure
 * a person would meet minutes later.
 */

export type StepOutcome = { state: "done" | "skipped" | "failed"; detail: string; remedies?: string[]; data?: Record<string, unknown> };
export type StepRecord = StepOutcome & { id: string; title: string; elapsedMs: number };
export type InstallOptions = {
  source?: string;
  prefix?: string;
  unitDirectory?: string;
  service?: boolean;
  dryRun?: boolean;
  reinstallDependencies?: boolean;
  /** Reporting hook, so the terminal display and the JSON report read the same events. */
  onStep?: (id: string, state: "running" | StepOutcome["state"], record?: StepRecord) => void;
  /** Injected for tests, which must never spawn a package manager. */
  install?: (source: string) => Promise<{ ok: boolean; output: string }>;
};

const project = resolve(import.meta.dir, "..");

async function runBunInstall(source: string) {
  const child = Bun.spawn(["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: source, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
}

/** The checks a dependency install cannot fix, separated from the ones it can. */
export function blockingPrerequisites(checks: { id: string; group: string; available: boolean; remedy: string }[]) {
  const modules = ["playwright", "@modelcontextprotocol/sdk/client/index.js", "zod"];
  return checks.filter(check => check.group === "common" && !check.available && !modules.includes(check.id));
}

/** Whether a directory is on PATH, which decides if the person can type the command by name. */
export function onPath(directory: string, path = process.env.PATH ?? "") {
  return path.split(":").filter(Boolean).map(entry => resolve(entry)).includes(resolve(directory));
}

export const stepTitles: { id: string; title: string }[] = [
  { id: "prerequisites", title: "Check what this machine already has" },
  { id: "dependencies", title: "Prepare project dependencies" },
  { id: "launcher", title: "Link the sbar-orbit command" },
  { id: "service", title: "Install the broker service and desktop entries" },
  { id: "connector", title: "Write the agent connector configuration" },
  { id: "verify", title: "Verify the installed broker answers" },
];

export async function runInstall(options: InstallOptions = {}) {
  const source = resolve(options.source ?? project);
  const prefix = resolve(options.prefix ?? join(homedir(), ".local"));
  const unitDirectory = options.unitDirectory ?? process.env.ORBIT_UNIT_DIR ?? join(homedir(), ".config/systemd/user");
  const wantsService = options.service !== false;
  const dryRun = options.dryRun === true;
  const install = options.install ?? runBunInstall;
  const records: StepRecord[] = [];
  const remedies: string[] = [];
  let launcher = join(source, "bin/sbar-orbit");

  const step = async (id: string, work: () => Promise<StepOutcome>) => {
    const title = stepTitles.find(entry => entry.id === id)?.title ?? id;
    options.onStep?.(id, "running");
    const started = performance.now();
    let outcome: StepOutcome;
    try { outcome = await work(); }
    catch (error) {
      outcome = { state: "failed", detail: error instanceof OrbitError ? error.message : error instanceof Error ? error.message : "Step failed" };
    }
    const record: StepRecord = { id, title, elapsedMs: Math.round(performance.now() - started), ...outcome };
    records.push(record);
    for (const remedy of outcome.remedies ?? []) if (!remedies.includes(remedy)) remedies.push(remedy);
    options.onStep?.(id, outcome.state, record);
    return record;
  };

  const prerequisites = await step("prerequisites", async () => {
    const report = await inspectPrerequisites(source);
    const blocking = blockingPrerequisites(report.checks);
    if (blocking.length)
      return { state: "failed", detail: `${blocking.map(check => check.id).join(", ")} missing`, remedies: blocking.map(check => check.remedy), data: { report } };
    const missing = report.checks.filter(check => !check.available && check.group !== "common");
    return {
      state: "done",
      detail: missing.length ? `${missing.length} optional item missing` : "everything this step can see is present",
      // Not fatal: a machine without the native runtime still runs browser sessions, and saying so at
      // the end is more use than refusing to install.
      remedies: missing.map(check => check.remedy),
      data: { browser: report.browserPrerequisitesFound, native: report.nativePrerequisitesFound, missing: missing.map(check => check.id) },
    };
  });
  if (prerequisites.state === "failed") return finish();

  await step("dependencies", async () => {
    const report = await inspectPrerequisites(source);
    const present = report.checks.filter(check => check.id.includes("playwright") || check.id === "zod" || check.id.includes("modelcontextprotocol")).every(check => check.available);
    if (present && !options.reinstallDependencies) return { state: "skipped", detail: "already resolved" };
    if (dryRun) return { state: "skipped", detail: "would run bun install --frozen-lockfile --ignore-scripts" };
    const result = await install(source);
    if (!result.ok) return { state: "failed", detail: result.output || "bun install failed", remedies: [`Run bun install --frozen-lockfile --ignore-scripts in ${source}`] };
    return { state: "done", detail: "frozen lockfile, no lifecycle scripts" };
  });

  const linked = await step("launcher", async () => {
    if (dryRun) return { state: "skipped", detail: `would link ${join(prefix, "bin/sbar-orbit")}` };
    const link = await activateLocal(source, prefix);
    launcher = link;
    const reachable = onPath(join(prefix, "bin"));
    return {
      state: "done", detail: link,
      remedies: reachable ? [] : [`Add ${join(prefix, "bin")} to PATH to type sbar-orbit by name`],
      data: { link, onPath: reachable },
    };
  });
  if (linked.state === "failed") return finish();

  await step("service", async () => {
    if (!wantsService) return { state: "skipped", detail: "--no-service" };
    if (dryRun) return { state: "skipped", detail: "would write units and enable the broker" };
    const units = await installService(launcher, unitDirectory);
    const autostart = await enableAutostart(launcher);
    const status = await autostartStatus();
    return {
      state: status.brokerActive ? "done" : "failed",
      detail: status.brokerActive ? (status.startsWithTheDesktop ? "running, and starts with your desktop" : "running") : "the broker service did not come up",
      remedies: status.brokerActive ? (status.lingering ? [] : ["Surviving a full logout additionally needs loginctl enable-linger, which requires elevation"])
        : ["Read systemctl --user status sbar-orbit.service"],
      data: { units: units.written, autostart: autostart.wrote, status },
    };
  });

  await step("connector", async () => {
    const socket = serviceSocketPath();
    const configuration = { mcpServers: { orbit: { command: process.execPath, args: [join(source, "src/mcp.ts")], env: { ORBIT_SOCKET: socket } } } };
    const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sbar-orbit");
    const path = join(directory, "mcp.json");
    if (dryRun) return { state: "skipped", detail: `would write ${path}` };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Orbit's own directory, never the host's configuration. Registering it with a particular agent
    // host stays the person's decision, and the exact command for it is printed at the end.
    await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    return { state: "done", detail: path, data: { path, configuration } };
  });

  await step("verify", async () => {
    if (dryRun) return { state: "skipped", detail: "would ask the broker for a doctor report" };
    if (!wantsService) return { state: "skipped", detail: "no managed broker was installed" };
    const socket = serviceSocketPath();
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const doctor = await call(socket, "doctor") as Record<string, unknown>;
        return { state: "done", detail: `broker answered on ${socket}`, data: { doctor } };
      } catch { await Bun.sleep(250); }
    }
    return { state: "failed", detail: "no answer from the managed broker", remedies: ["Read journalctl --user -u sbar-orbit.service"] };
  });

  return finish();

  function finish() {
    const failed = records.filter(record => record.state === "failed");
    const prerequisiteData = records.find(record => record.id === "prerequisites")?.data as { browser?: boolean; native?: boolean } | undefined;
    return {
      installed: !failed.length,
      source, prefix, launcher,
      dryRun,
      steps: records,
      capabilities: {
        browserSessions: prerequisiteData?.browser === true,
        nativeSessions: prerequisiteData?.native === true,
      },
      remedies,
      // Nothing here is a measurement. It says what was installed, not what was proven to work.
      verified: "Installation steps only. Resource acceptance, application behaviour and the native display are separate gates in docs/validation.md.",
    };
  }
}

export type InstallReport = Awaited<ReturnType<typeof runInstall>>;
