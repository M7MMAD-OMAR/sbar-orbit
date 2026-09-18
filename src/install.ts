import { homedir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inspectPrerequisites, type PrerequisiteCheck, type Remedy } from "./preflight";
import { nativeRuntimeLocations, nativeRuntimePackages, type NativeRuntime } from "./runtime-paths";
import { activateLocal, commandName } from "./local-install";
import { installService, serviceSocketPath, connectorConfigDirectory } from "./service";
import { enableAutostart, autostartStatus } from "./autostart";
import { connectorEntry } from "./connector-entry";
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
 * It installs nothing that needs root. Bun, a browser, Xwayland and the capture tools are the
 * person's package manager's job, and a step that pretended otherwise would be lying about a failure
 * a person would meet minutes later.
 */

export type StepOutcome = { state: "done" | "skipped" | "failed"; detail: string; remedies?: Remedy[]; data?: Record<string, unknown> };
export type StepRecord = StepOutcome & { id: string; title: string; elapsedMs: number };
export type InstallOptions = {
  source?: string;
  prefix?: string;
  unitDirectory?: string;
  service?: boolean;
  dryRun?: boolean;
  reinstallDependencies?: boolean;
  /** Build the private display runtime from the tracked bootstrap. Off by default: browser sessions do not need it. */
  native?: boolean;
  /** Reporting hook, so the terminal display and the JSON report read the same events. */
  onStep?: (id: string, state: "running" | StepOutcome["state"], record?: StepRecord) => void;
  /** Injected for tests, which must never spawn a package manager. */
  install?: (source: string) => Promise<{ ok: boolean; output: string }>;
  /** Injected for tests, which must never download packages or compile anything. */
  bootstrap?: (source: string, runtimeDirectory: string) => Promise<{ ok: boolean; output: string }>;
};

const project = resolve(import.meta.dir, "..");

/** The distinct causes behind a set of failed checks, in the order they were checked. */
function remediesOf(checks: PrerequisiteCheck[]): Remedy[] {
  const found: Remedy[] = [];
  for (const { remedy } of checks) if (remedy && !found.some(known => known.id === remedy.id)) found.push(remedy);
  return found;
}

/**
 * The Bun that is running this code, not whatever `bun` resolves to on PATH.
 *
 * Both launchers already resolve Bun by location, for the reason `bin/sbar-orbit` states: a service
 * or an agent host starts Orbit with its own PATH, which need not carry Bun at all. Spawning a bare
 * "bun" threw that away and failed with `Executable not found in $PATH`, measured on the Windows
 * guest where Bun lives outside PATH. `process.execPath` is the interpreter already in hand.
 */
function bunExecutable() {
  return process.execPath || Bun.which("bun") || "bun";
}

async function runBunInstall(source: string) {
  const child = Bun.spawn([bunExecutable(), "install", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: source, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
}

async function runBootstrap(source: string, runtimeDirectory: string) {
  const child = Bun.spawn(["bash", join(source, "experiments/fedora-display/bootstrap.sh")],
    { cwd: source, stdout: "pipe", stderr: "pipe", env: { ...process.env, ORBIT_RUNTIME_DIR: runtimeDirectory } });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
}

/** What the bootstrap needs on the machine: the package tools it downloads and unpacks with, and a C toolchain for the pointer helper. */
export const nativeBuildTools = ["dnf", "rpm2cpio", "cpio", "curl", "wayland-scanner", "cc", "pkg-config"];
const nativeBuildRemedy: Remedy = { id: "no-native-build-tools", needsElevation: true, agentMayRun: false,
  command: `sudo dnf install gcc pkgconf-pkg-config wayland-devel libxkbcommon-devel cpio curl ${nativeRuntimePackages}`,
  message: "Building the private display runtime needs a C toolchain, the Wayland and xkbcommon development files, the tools that download and unpack Fedora packages, and the libraries the compositor links against." };

/**
 * The private compositor and pointer helper, built from the tracked bootstrap into the shared runtime
 * directory, outside every version of Orbit, so a version swap does not take native sessions away.
 * Measured 13 September 2026 on this Fedora 44 host: the script downloads three pinned packages,
 * unpacks them without installing, checks two protocol files against their digests, compiles the
 * helper, and reports sway 1.11, 3.3 MB on disk, in under a minute. It has run on no other system,
 * which is why the step is opt-in and says so.
 */
export async function buildNativeRuntime(source: string, options: { dryRun?: boolean; bootstrap?: InstallOptions["bootstrap"]; which?: (tool: string) => string | null } = {}): Promise<StepOutcome> {
  const { shared, inSource } = nativeRuntimeLocations(source);
  const present = async (path: string) => Bun.file(path).exists();
  const built = async (paths: NativeRuntime) => await present(join(paths.executables, "sway")) && await present(paths.pointer);
  if (await built(shared)) return { state: "skipped", detail: `already built in ${shared.runtime}`, data: { runtime: shared.runtime, source: "shared" } };
  // A runtime built before the move is inside whichever source tree built it, and copying it is seconds
  // against a download and a compile. Adopting is also what keeps native sessions working across the
  // first version swap on a machine that already had one, which is the whole reason for the move.
  if (await built(inSource)) {
    if (options.dryRun) return { state: "skipped", detail: `would adopt the runtime in ${inSource.runtime}` };
    await mkdir(dirname(shared.runtime), { recursive: true });
    // `cp -a`, not the library copy. Measured 14 September 2026: `node:fs/promises` `cp` rewrote the
    // unpacked tree's relative symlinks into absolute paths back into the source tree, so the adopted
    // runtime kept working only while the tree it came from was still there, and sway failed to load
    // libliftoff.so.0 the moment it was not. That is the exact dependency this move exists to remove.
    const copied = Bun.spawn(["cp", "-a", `${inSource.runtime}/.`, shared.runtime], { stdout: "pipe", stderr: "pipe" });
    const problem = (await new Response(copied.stderr).text()).trim();
    if (await copied.exited !== 0) return { state: "failed", detail: problem.split("\n").at(-1)?.slice(0, 200) || "the copy failed" };
    if (!await built(shared)) return { state: "failed", detail: "the copy finished and left no runtime behind" };
    return { state: "done", detail: `adopted the runtime built in ${inSource.runtime}`, data: { runtime: shared.runtime, source: "adopted" } };
  }
  const which = options.which ?? (tool => Bun.which(tool));
  const missing = nativeBuildTools.filter(tool => !which(tool));
  if (missing.length) return { state: "failed", detail: `${missing.join(", ")} missing`, remedies: [nativeBuildRemedy] };
  // The registry package carries no `experiments/`, so this is the ordinary shape of a `--native` run
  // after `bun add -g sbar-orbit`. Saying which file bash could not open explains nothing; saying that
  // this copy of Orbit does not carry the bootstrap names the actual cause and the way around it.
  if (!options.bootstrap && !(await present(join(source, "experiments/fedora-display/bootstrap.sh"))))
    return { state: "failed", detail: "this copy of Orbit carries no native bootstrap; the registry package ships source, not experiments",
      remedies: [{ id: "native-bootstrap-absent", needsElevation: false, agentMayRun: false,
        command: "git clone https://github.com/M7MMAD-OMAR/sbar-orbit",
        message: "Native sessions need the private display runtime, which is built from experiments/fedora-display/bootstrap.sh in the repository. Clone it and run ./install.sh --native there. Browser sessions need none of this." }] };
  if (options.dryRun) return { state: "skipped", detail: "would run experiments/fedora-display/bootstrap.sh" };
  const result = await (options.bootstrap ?? runBootstrap)(source, shared.runtime);
  if (!result.ok) return { state: "failed", detail: result.output || "the bootstrap failed",
    remedies: [{ id: "native-bootstrap-failed", needsElevation: false, agentMayRun: true, command: "bash experiments/fedora-display/bootstrap.sh",
      message: `The bootstrap failed in ${source}. Run it there and read its own output; it pins Fedora package versions.` }] };
  if (!await built(shared)) return { state: "failed", detail: "the bootstrap finished and left no runtime behind" };
  return { state: "done", detail: `sway and the pointer helper in ${shared.runtime}`, data: { runtime: shared.runtime, source: "built" } };
}

/** The checks a dependency install cannot fix, separated from the ones it can. */
export function blockingPrerequisites<T extends Pick<PrerequisiteCheck, "id" | "group" | "available">>(checks: T[]) {
  const modules = ["playwright", "@modelcontextprotocol/sdk/client/index.js", "zod"];
  return checks.filter(check => check.group === "common" && !check.available && !modules.includes(check.id));
}

/** Whether a directory is on PATH, which decides if the person can type the command by name. */
export function onPath(directory: string, path = process.env.PATH ?? "", separator = delimiter) {
  // `delimiter`, not `":"`. A literal colon is the POSIX separator and also splits `C:\Users\...` at
  // the drive letter, so on Windows every entry became a fragment and `onPath` returned false for a
  // prefix that really was on PATH. The install then printed the `prefix-not-on-path` remedy telling
  // a person to fix something that was not broken, and `data.onPath` is a field an agent branches on.
  //
  // The separator is a parameter so a test can state a POSIX PATH and a Windows PATH on either host,
  // rather than only ever checking the shape the machine running the suite happens to use.
  return path.split(separator).filter(Boolean).map(entry => resolve(entry)).includes(resolve(directory));
}

export const stepTitles: { id: string; title: string }[] = [
  { id: "prerequisites", title: "Check what this machine already has" },
  { id: "dependencies", title: "Prepare project dependencies" },
  { id: "native", title: "Build the private display runtime" },
  { id: "launcher", title: "Link the sbar-orbit command" },
  { id: "service", title: "Install the broker service and desktop entries" },
  { id: "connector", title: "Write the agent connector configuration" },
  { id: "verify", title: "Verify the installed broker answers" },
];

/**
 * Where a default install goes, per platform, because `~/.local` is a POSIX convention and nothing on
 * Windows looks there. `%LOCALAPPDATA%\sbar-orbit` is the prefix `defaultLauncherPath()` in
 * `src/update.ts` already names, and the two disagreeing is what made every default Windows install
 * unupdatable: `updatableInstall()` resolved a launcher that had been written somewhere else.
 */
export function defaultPrefix(env = process.env, platform = process.platform) {
  if (platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit");
  return join(homedir(), ".local");
}

export async function runInstall(options: InstallOptions = {}) {
  const source = resolve(options.source ?? project);
  const prefix = resolve(options.prefix ?? defaultPrefix());
  const unitDirectory = options.unitDirectory ?? process.env.ORBIT_UNIT_DIR ?? join(homedir(), ".config/systemd/user");
  const wantsService = options.service !== false;
  const dryRun = options.dryRun === true;
  const install = options.install ?? runBunInstall;
  const records: StepRecord[] = [];
  const remedies: Remedy[] = [];
  // `commandName()`, not the literal bash launcher: a run that returns before the launcher step, a
  // failed prerequisites check for instance, reports this path, and on Windows the other name is a
  // bash script cmd.exe cannot execute.
  let launcher = join(source, "bin", commandName());

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
    // One entry per distinct cause, not one per failed check: three missing capture tools are one
    // command to run, and an agent acting on the list should not run it three times.
    for (const remedy of outcome.remedies ?? []) if (!remedies.some(known => known.id === remedy.id)) remedies.push(remedy);
    options.onStep?.(id, outcome.state, record);
    return record;
  };

  // Held here rather than read back out of the step's `data`: that field is the public report shape an
  // agent parses, and the success branch deliberately publishes the summary rather than the whole
  // sweep. A local keeps the second consumer below from making the report format load-bearing.
  let swept: Awaited<ReturnType<typeof inspectPrerequisites>> | null = null;
  const prerequisites = await step("prerequisites", async () => {
    const report = swept = await inspectPrerequisites(source);
    const blocking = blockingPrerequisites(report.checks);
    if (blocking.length)
      return { state: "failed", detail: `${blocking.map(check => check.id).join(", ")} missing`, remedies: remediesOf(blocking), data: { report } };
    const missing = report.checks.filter(check => !check.available && check.group !== "common");
    return {
      state: "done",
      detail: missing.length ? `${missing.length} optional item missing` : "everything this step can see is present",
      // Not fatal: a machine without the native runtime still runs browser sessions, and saying so at
      // the end is more use than refusing to install.
      remedies: remediesOf(missing),
      data: { browser: report.browserPrerequisitesFound, native: report.nativePrerequisitesFound, missing: missing.map(check => check.id) },
    };
  });
  if (prerequisites.state === "failed") return finish();

  await step("dependencies", async () => {
    // The sweep the prerequisites step already ran, not a second one. Nothing has touched the machine
    // between them (`install(source)` happens below), and on Windows the sweep spawns a `reg query`
    // per browser location, so asking twice cost six subprocesses for an answer already in hand.
    // The fallback is not decoration: the step records a failure rather than throwing if the sweep
    // itself threw, and this step must not then read a null.
    const report = swept ?? await inspectPrerequisites(source);
    const present = report.checks.filter(check => check.id.includes("playwright") || check.id === "zod" || check.id.includes("modelcontextprotocol")).every(check => check.available);
    if (present && !options.reinstallDependencies) return { state: "skipped", detail: "already resolved" };
    if (dryRun) return { state: "skipped", detail: "would run bun install --frozen-lockfile --ignore-scripts" };
    const result = await install(source);
    if (!result.ok) return { state: "failed", detail: result.output || "bun install failed",
      remedies: [{ id: "dependencies-missing", needsElevation: false, agentMayRun: true, command: "bun install --frozen-lockfile --ignore-scripts",
        message: `The dependency install failed in ${source}. Run it there and read its own output.` }] };
    return { state: "done", detail: "frozen lockfile, no lifecycle scripts" };
  });

  await step("native", async () => {
    // Opt-in, because it downloads packages and compiles, and because it has only ever been run on
    // Fedora. A machine without it still runs browser sessions, and the prerequisites step already
    // says how to get it.
    if (!options.native) return { state: "skipped", detail: "not requested; --native builds it, browser sessions do not need it" };
    return buildNativeRuntime(source, { dryRun, bootstrap: options.bootstrap });
  });

  const linked = await step("launcher", async () => {
    if (dryRun) {
      // The top level launcher is what a caller reads to find the command afterwards. During a dry
      // run it has to name where the link would go, not where the source happens to be.
      launcher = join(prefix, "bin", commandName());
      return { state: "skipped", detail: `would link ${launcher}` };
    }
    const link = await activateLocal(source, prefix);
    launcher = link;
    const reachable = onPath(join(prefix, "bin"));
    return {
      state: "done", detail: link,
      // Elevation is not the only reason to stand back: PATH lives in the person's shell
      // configuration, which Orbit does not edit, so this one is reported and never acted on.
      remedies: reachable ? [] : [{ id: "prefix-not-on-path", needsElevation: false, agentMayRun: false,
        message: `The command is linked at ${link} and ${join(prefix, "bin")} is not on PATH, so it cannot be typed by name yet.` }],
      data: { link, onPath: reachable },
    };
  });
  if (linked.state === "failed") return finish();

  const service = await step("service", async () => {
    if (!wantsService) return { state: "skipped", detail: "--no-service" };
    // Not a gap to fill later. A Chromium family browser will not run in Windows session 0, measured
    // on a Windows 11 guest, so the broker belongs in the person's own session and there is no
    // analogue of `loginctl enable-linger`. Autostart there is a per user Run key or logon task.
    if (process.platform === "win32")
      return { state: "skipped", detail: "Windows has no user service for this: a browser cannot run in session 0, so the broker runs in your session. Start it with `sbar-orbit.cmd serve`" };
    if (dryRun) return { state: "skipped", detail: "would write units and enable the broker" };
    // macOS has a real per user service and it is a LaunchAgent, not a systemd unit. The autostart
    // promise it can make is narrower and the report says so rather than borrowing the Linux
    // wording: an agent starts with the person's LOGIN, and there is no lingering equivalent that
    // would bring the broker up at boot before one.
    if (process.platform === "darwin") {
      const { enableLaunchAgent } = await import("./macos-autostart");
      const socket = serviceSocketPath();
      const agent = await enableLaunchAgent(launcher, socket);
      return {
        state: agent.status.running ? "done" : agent.bootstrapped ? "done" : "failed",
        detail: agent.status.running ? "running, and starts when you log in"
          : agent.bootstrapped ? "installed and starts when you log in"
          : `launchctl bootstrap refused the agent: ${agent.output ?? "no output"}`,
        remedies: agent.bootstrapped ? [] : [{ id: "launch-agent-refused", needsElevation: false, agentMayRun: true,
          command: `launchctl bootstrap gui/$(id -u) ${agent.wrote[0]}`,
          message: "The launch agent was written and launchd would not load it. Run the bootstrap by hand and read its own output." }],
        data: { agent: agent.wrote, status: agent.status },
      };
    }
    const units = await installService(launcher, unitDirectory);
    const autostart = await enableAutostart(launcher);
    const status = await autostartStatus();
    return {
      state: status.brokerActive ? "done" : "failed",
      detail: status.brokerActive ? (status.startsWithTheDesktop ? "running, and starts with your desktop" : "running") : "the broker service did not come up",
      remedies: status.brokerActive
        ? (status.lingering ? [] : [{ id: "no-lingering", needsElevation: true, agentMayRun: false, command: `loginctl enable-linger ${process.env.USER ?? ""}`.trim(),
            message: "Orbit starts with your desktop. Surviving a full logout as well needs lingering, which needs elevation." }])
        : [{ id: "broker-did-not-start", needsElevation: false, agentMayRun: true, command: "systemctl --user status sbar-orbit.service",
            message: "The broker service was installed and did not come up. Its own status output says why." }],
      data: { units: units.written, autostart: autostart.wrote, status },
    };
  });

  await step("connector", async () => {
    const socket = serviceSocketPath();
    // The launcher, not this Bun and this checkout: see connector-entry.ts for why a source path
    // cannot survive an upgrade, a rollback or a machine that is not the one it was written on.
    const configuration = { mcpServers: { orbit: { ...connectorEntry({ launcher, source }), env: { ORBIT_SOCKET: socket } } } };
    const directory = connectorConfigDirectory();
    const path = join(directory, "mcp.json");
    // This path does not follow --prefix: one machine has one registered connector, whichever source
    // was installed last. So say what is already there before replacing it, and in a dry run print
    // exactly what would be written, rather than making a caller read the source to find out.
    const existing = await readFile(path, "utf8").catch(() => null);
    const same = existing !== null && existing.trim() === JSON.stringify(configuration, null, 2).trim();
    const replaces = existing === null ? "creates" : same ? "unchanged" : "replaces an earlier configuration";
    if (dryRun) return { state: "skipped", detail: `would write ${path}, ${replaces}`, data: { path, replaces, configuration } };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Orbit's own directory, never the host's configuration. Registering it with a particular agent
    // host stays the person's decision, and the exact command for it is printed at the end.
    await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    // A machine installed before the connector learned about %APPDATA% has one at the POSIX path
    // too, naming a socket in Windows terms from a directory nothing on Windows reads. Leaving it
    // would leave two connector files disagreeing after the next upgrade, and the stale one is the
    // kind of thing that gets found years later and trusted. Said in the report rather than removed
    // silently: it is the person's file, and a step that deletes without saying so is worse than one
    // that leaves something behind.
    // Asked of the function that owns the rule, not re-spelled here. The hand-written form dropped
    // the `XDG_CONFIG_HOME` half of it, so a Windows machine with that variable set (Git Bash sets
    // one) had its old connector written somewhere this check would never look, and the install
    // would report nothing left behind while the stale file sat there.
    const stale = process.platform === "win32" ? join(connectorConfigDirectory(process.env, "linux"), "mcp.json") : null;
    const leftBehind = stale && stale !== path && await readFile(stale, "utf8").then(() => true).catch(() => false);
    return { state: "done", data: { path, replaces, configuration, ...(leftBehind ? { stale } : {}) },
      detail: leftBehind ? `${path}, ${replaces}; an older ${stale} is still there and is no longer read` : `${path}, ${replaces}` };
  });

  await step("verify", async () => {
    if (dryRun) return { state: "skipped", detail: "would ask the broker for a doctor report" };
    // Whether there is a broker to verify is a question the service step already answered, so it is
    // read here rather than re-derived from `wantsService` and the platform. Both spellings were the
    // same question: without them the install waited 15 seconds for a broker nobody started, then
    // reported `verify: failed` and exited 1 on a Windows machine where every step had succeeded,
    // with a remedy naming a systemd journal that does not exist there. Found by installing the
    // published release on a Windows guest, not by the suite, because no test installs the real
    // archive. Asking the step means the next reason to skip a service, a new platform or a policy,
    // does not have to remember to add a third branch here. A FAILED service step still reaches the
    // poll below, deliberately: that failure is worth reporting against the socket it names.
    if (service.state === "skipped")
      return { state: "skipped", detail: `no managed broker was installed: ${service.detail}` };
    const socket = serviceSocketPath();
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const doctor = await call(socket, "doctor") as Record<string, unknown>;
        return { state: "done", detail: `broker answered on ${socket}`, data: { doctor } };
      } catch { await Bun.sleep(250); }
    }
    return { state: "failed", detail: "no answer from the managed broker",
      remedies: [{ id: "broker-silent", needsElevation: false, agentMayRun: true, command: "journalctl --user -u sbar-orbit.service --since -5min",
        message: "The broker service is installed but nothing answered on its socket. Its journal says why." }] };
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
