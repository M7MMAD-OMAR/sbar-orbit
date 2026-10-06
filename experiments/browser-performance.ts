import { readFile, mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export function distribution(values: number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value)))
    throw new Error("Missing or invalid measurements");
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted[Math.floor((sorted.length - 1) / 2)];
  const upper = sorted[Math.ceil((sorted.length - 1) / 2)];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (lower === undefined || upper === undefined || p95 === undefined) throw new Error("Missing measurements");
  return { median: (lower + upper) / 2, p95, count: sorted.length };
}

export function threshold(value: number | null, limit: number) {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(limit)) return "not measured";
  return value < limit ? "passed" : "failed";
}

export function actionMean(actionMs: Record<string, number[]>) {
  const types = ["fill", "click", "read"];
  const counts = types.map(type => actionMs[type]?.length ?? 0);
  if (!counts[0] || counts.some(count => count !== counts[0])) throw new Error("Unequal or missing action workload");
  const values = types.flatMap(type => actionMs[type] ?? []);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error("Invalid action duration");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface ProcessSample { pid: number; parent: number; start: string; rssBytes: number }
export function ownedRss(root: number, processes: ProcessSample[]) {
  const owned = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (owned.has(process.parent) && !owned.has(process.pid)) {
      owned.add(process.pid); changed = true;
    }
  }
  return processes.filter(process => owned.has(process.pid)).reduce((sum, process) => sum + process.rssBytes, 0);
}

// One isolated subreaper per arm. RUSAGE_CHILDREN includes waited descendant CPU,
// whereas ru_maxrss is only the largest child, so tree RSS is sampled separately.
// Read only descendants, through every thread's children list, including adoptees.
export const collector = String.raw`
import ctypes, json, os, re, resource, signal, subprocess, sys, time
from pathlib import Path
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError("Cannot enable measurement subreaper")
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
root, report = os.getpid(), Path(sys.argv[1])
child = subprocess.Popen(sys.argv[2:])
page_size = os.sysconf("SC_PAGE_SIZE")
rows, failures, max_gap, last = [], 0, 0, time.monotonic()
browser_commands = {}
group = Path(f"/proc/{root}/cgroup").read_text()
boundary_lost = False
deadline, failed, root_status = last + 25, False, None
def census():
    global boundary_lost
    pending, seen, result = [root], set(), []
    while pending:
        pid = pending.pop()
        if pid in seen: continue
        seen.add(pid)
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            result.append({"pid":pid, "parent":int(fields[1]), "start":fields[19],
                           "rssBytes":int(fields[21])*page_size})
            if Path(f"/proc/{pid}/cgroup").read_text() != group: boundary_lost = True
            try:
                if os.path.realpath(f"/proc/{pid}/exe") == sys.argv[-1]:
                    argv = Path(f"/proc/{pid}/cmdline").read_bytes().decode().split("\0")[:-1]
                    if argv and not any(re.search(r"(?:^|\s)--type=", arg) for arg in argv):
                        browser_commands[f"{pid}:{fields[19]}"] = argv
            except FileNotFoundError: pass
            for task in Path(f"/proc/{pid}/task").iterdir():
                try: pending.extend(map(int, (task/"children").read_text().split()))
                except FileNotFoundError: pass
        except FileNotFoundError: pass
    return result
def stop(signum, frame):
    global failed
    failed = True
    for process in census():
        if process["pid"] != root:
            try: os.kill(process["pid"], signal.SIGKILL)
            except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True:
    now = time.monotonic()
    max_gap = max(max_gap, (now-last)*1000); last = now
    try: rows.append({"atMs":now*1000, "processes":census()})
    except (OSError, ValueError, IndexError): failures += 1
    if now > deadline or boundary_lost: stop(None, None)
    children = True
    while True:
        try: pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            children = False; break
        if pid == 0: break
        if pid == child.pid: root_status = os.waitstatus_to_exitcode(status)
    if not children: break
    time.sleep(0.05)
usage, own = resource.getrusage(resource.RUSAGE_CHILDREN), resource.getrusage(resource.RUSAGE_SELF)
report.write_text(json.dumps({"root":root, "worker":child.pid, "exitCode":root_status,
    "timedOut":failed, "cpuSeconds":usage.ru_utime+usage.ru_stime+own.ru_utime+own.ru_stime,
    "cpuMethod":"RUSAGE_SELF plus RUSAGE_CHILDREN after subreaper wait to ECHILD",
    "sampleFailures":failures, "maxSampleGapMs":max_gap, "samples":rows,
    "browserCommands":browser_commands, "cleanup":"wait returned ECHILD"}))
sys.exit(1 if failed or root_status != 0 else 0)
`;

const fixture = `<!doctype html><meta charset="utf-8"><input id="message"><button>Save</button><output></output>
<script>document.querySelector('button').onclick=()=>{document.querySelector('output').textContent=document.querySelector('input').value}</script>`;
const viewport = { width: 1280, height: 800 };
const rounds = 10, frames = 3;
type Arm = "direct" | "orbit";
interface WorkerResult {
  arm: Arm; workerPid: number; executable: string; startupMs: number; readyAt: number;
  idleRssBytes: number; startupToFixtureMs: number; actionMs: Record<string, number[]>; frameMs: number[];
  verifiedRounds: number; frameBytes: number[]; budget: unknown;
}
interface TreeResult {
  root: number; worker: number; exitCode: number | null; timedOut: boolean; cpuSeconds: number;
  cpuMethod: string; sampleFailures: number; maxSampleGapMs: number;
  browserCommands: Record<string, string[]>; cleanup: string;
  samples: { atMs: number; processes: ProcessSample[] }[];
}

async function worker(arm: Arm, root: string, url: string, expectedExecutable: string) {
  const { requireResourceBudget } = await import("../src/resource-budget");
  const budget = await requireResourceBudget();
  const { defaultChromeExecutable } = await import("../src/chrome");
  const discovered = defaultChromeExecutable();
  if (!discovered || await realpath(discovered) !== expectedExecutable) throw new Error("Browser executable mismatch");
  const { chromium } = await import("playwright");
  const result: WorkerResult = { arm, workerPid: process.pid, executable: expectedExecutable,
    startupMs: 0, readyAt: 0, startupToFixtureMs: 0, idleRssBytes: 0, actionMs: {}, frameMs: [], verifiedRounds: 0, frameBytes: [], budget };
  let close: (() => Promise<void>) | undefined;
  let act: (type: string, text?: string) => Promise<unknown>;
  let navigate: () => Promise<unknown>;
  let capture: () => Promise<string>;
  let launch: () => Promise<void>;
  if (arm === "orbit") {
    const { startBroker, call } = await import("../src/ipc");
    const broker = await startBroker({ accountRoot: join(root, "accounts") });
    close = () => broker.close();
    let sessionId = "";
    launch = async () => {
      const session = await call(broker.socket, "session.create", { backend: "browser", viewport }) as { sessionId: string };
      sessionId = session.sessionId;
    };
    act = (type, text) => call(broker.socket, "session.act", { sessionId, requestId: crypto.randomUUID(),
      action: { type, selector: type === "fill" ? "#message" : type === "click" ? "button" : "output", ...(text === undefined ? {} : { text }) } });
    navigate = () => call(broker.socket, "session.act", { sessionId, requestId: crypto.randomUUID(), action: { type: "navigate", url } });
    capture = async () => (await call(broker.socket, "session.observe", { sessionId }) as { image: string }).image;
  } else {
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
    let page: import("playwright").Page;
    let cdp: import("playwright").CDPSession | undefined;
    launch = async () => {
      const profile = join(root, "profile");
      await mkdir(profile);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
        !["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"].includes(key))) as Record<string, string>;
      Object.assign(env, { XDG_CONFIG_HOME: join(profile, "config"), TMPDIR: root,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-session-bus` });
      context = await chromium.launchPersistentContext(profile, { executablePath: discovered, headless: true, viewport,
        env, args: ["--disable-background-networking", "--disable-dev-shm-usage", "--disable-crash-reporter", "--password-store=basic", "--disable-extensions"], timeout: 15000 });
      close = () => context.close();
      const first = context.pages()[0];
      if (!first) throw new Error("Direct page missing");
      page = first;
      page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(15000);
    };
    act = async (type, text) => {
      if (type === "fill") return page.locator("#message").fill(text ?? "");
      if (type === "click") return page.locator("button").click();
      return { text: await page.locator("output").innerText() };
    };
    navigate = () => page.goto(url, { waitUntil: "domcontentloaded" });
    capture = async () => {
      cdp ??= await context.newCDPSession(page);
      return (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false })).data;
    };
  }
  try {
    await Bun.sleep(200);
    const stat = (await readFile(`/proc/${process.pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
    if (!stat) throw new Error("Missing idle RSS");
    result.idleRssBytes = Number(stat) * 1024;
    const start = performance.now();
    await launch();
    result.startupMs = performance.now() - start; result.readyAt = Date.now();
    await navigate();
    result.startupToFixtureMs = performance.now() - start;
    for (let round = 0; round < rounds; round++) {
      const text = `fixture ${round} مرحبا`;
      for (const type of ["fill", "click", "read"]) {
        const start = performance.now();
        const response = await act(type, type === "fill" ? text : undefined);
        (result.actionMs[type] ??= []).push(performance.now() - start);
        if (type === "read" && (response as { text: string }).text !== text) throw new Error("Fixture result mismatch");
      }
      result.verifiedRounds++;
    }
    for (let frame = 0; frame < frames; frame++) {
      const start = performance.now();
      const image = Buffer.from(await capture(), "base64");
      result.frameMs.push(performance.now() - start);
      if (image[0] !== 255 || image[1] !== 216 || image.length < 100) throw new Error("JPEG capture missing");
      result.frameBytes.push(image.length);
    }
  } finally { await close?.(); }
  await Bun.write(join(root, "worker.json"), JSON.stringify(result));
}

async function sourceIdentity() {
  const files = [...new Bun.Glob("src/**/*").scanSync({ onlyFiles: true })].filter(file => /\.(ts|py)$/.test(file));
  files.push("package.json", "bun.lock", "bunfig.toml", "scripts/limited.ts", "experiments/browser-performance.ts");
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(file));
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  return { commit, sha256: hash.digest("hex"), files };
}

async function experiment() {
  if (process.platform !== "linux") throw new Error("Process-tree measurement is Linux only; other platforms are not measured");
  const { requireResourceBudget } = await import("../src/resource-budget");
  const budget = await requireResourceBudget();
  const { defaultChromeExecutable } = await import("../src/chrome");
  const discovered = defaultChromeExecutable();
  if (!discovered) throw new Error("No discovered browser");
  const executable = await realpath(discovered);
  const root = await mkdtemp("/var/tmp/orbit-perf-");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(fixture, { headers: { "content-type": "text/html; charset=utf-8" } }) });
  const source = await sourceIdentity();
  const runs: { pair: number; arm: Arm; worker: WorkerResult; tree: TreeResult; peakTreeRssBytes: number; coldStartupMs: number }[] = [];
  const report: Record<string, unknown> = { schema: 1, status: "running", source, budget, executable,
    fixtureSha256: createHash("sha256").update(fixture).digest("hex"), viewport, rounds, frames, concurrency: 1, runs,
    startedAt: new Date().toISOString(), limitations: [
      "Five fresh profiles per arm, warm machine caches, one Linux host and one synchronous loopback fixture.",
      "Browser flags and launch transport differ: direct Playwright defaults versus production Orbit CDP launcher; owned browser argv recorded.",
      "CPU includes each worker client and its Python collector through shutdown; fixture and coordinator excluded.",
      "Peak RSS is the maximum sampled sum, includes shared pages once per process and can miss between-sample peaks.",
      "Idle overhead is the fresh broker worker RSS minus the initialized direct worker RSS, before browser creation.",
      "Frame latency is capture request to JPEG response; display age, viewer, native, focus and human work are not measured.",
      "Three frame samples per run validate JPEG availability, not pixel correctness or high-confidence tail estimates.",
    ] };
  try {
    const deadline = performance.now() + 165000;
    for (let pair = 0; pair < 5; pair++) {
      const order: Arm[] = pair % 2 ? ["orbit", "direct"] : ["direct", "orbit"];
      for (const arm of order) {
        if (performance.now() > deadline - 25000) throw new Error("Experiment runtime budget exhausted");
        const directory = join(root, `${pair}-${arm}`); await mkdir(directory, { mode: 0o700 });
        const start = Date.now();
        const child = Bun.spawn(["/usr/bin/python3", "-c", collector, join(directory, "tree.json"),
          process.execPath, "--smol", resolve(import.meta.path), "--worker", arm, directory,
          `http://127.0.0.1:${server.port}`, executable], { stdout: "ignore", stderr: "inherit" });
        const exit = await child.exited;
        const tree = JSON.parse(await readFile(join(directory, "tree.json"), "utf8")) as TreeResult;
        report.lastAttempt = { pair, arm, tree };
        if (exit !== 0 || tree.exitCode !== 0 || tree.timedOut || tree.sampleFailures || !tree.samples.length)
          throw new Error(`Invalid ${arm} measurement: exit ${exit}, timeout ${tree.timedOut}, sample failures ${tree.sampleFailures}`);
        const worker = JSON.parse(await readFile(join(directory, "worker.json"), "utf8")) as WorkerResult;
        report.lastAttempt = { pair, arm, tree, worker };
        if (worker.verifiedRounds !== rounds || worker.frameMs.length !== frames ||
            worker.executable !== executable || !Object.values(tree.browserCommands).length ||
            Object.values(tree.browserCommands).some(argv => !argv.some(arg => arg.startsWith("--headless"))))
          throw new Error(`Workload or browser mode mismatch: ${JSON.stringify({ rounds: worker.verifiedRounds,
            frames: worker.frameMs.length, executable: worker.executable, expected: executable, commands: tree.browserCommands })}`);
        const peakTreeRssBytes = Math.max(...tree.samples.map(sample => ownedRss(tree.root, sample.processes)));
        runs.push({ pair, arm, worker, tree, peakTreeRssBytes, coldStartupMs: worker.readyAt - start });
        console.error(`Pair ${pair + 1}: ${arm} measured`);
      }
    }
    const summary: Record<string, unknown> = {};
    for (const arm of ["direct", "orbit"] as const) {
      const own = runs.filter(run => run.arm === arm);
      summary[arm] = { startupMs: distribution(own.map(run => run.worker.startupMs)),
        startupToFixtureMs: distribution(own.map(run => run.worker.startupToFixtureMs)),
        coldStartupMs: distribution(own.map(run => run.coldStartupMs)),
        cpuSeconds: distribution(own.map(run => run.tree.cpuSeconds)),
        peakTreeRssMiB: distribution(own.map(run => run.peakTreeRssBytes / 1048576)),
        idleWorkerRssMiB: distribution(own.map(run => run.worker.idleRssBytes / 1048576)),
        actionMs: Object.fromEntries(["fill", "click", "read"].map(type => [type, distribution(own.flatMap(run => run.worker.actionMs[type] ?? []))])),
        frameMs: distribution(own.flatMap(run => run.worker.frameMs)) };
    }
    const matched = Array.from({ length: 5 }, (_, pair) => {
      const direct = runs.find(run => run.pair === pair && run.arm === "direct");
      const orbit = runs.find(run => run.pair === pair && run.arm === "orbit");
      if (!direct || !orbit) throw new Error("Missing matched pair");
      const latency = (run: typeof direct) => actionMean(run.worker.actionMs);
      return { pair, idleOverheadMiB: (orbit.worker.idleRssBytes - direct.worker.idleRssBytes) / 1048576,
        actionExtraPercent: (latency(orbit) / latency(direct) - 1) * 100,
        directActionMeanMs: latency(direct), orbitActionMeanMs: latency(orbit) };
    });
    const idle = distribution(matched.map(pair => pair.idleOverheadMiB));
    // Negative overhead is valid, although durations and RSS are nonnegative.
    const extra = matched.map(pair => pair.actionExtraPercent).sort((a, b) => a - b)[2];
    report.summary = summary; report.matched = matched;
    report.targets = { idleOverhead: { limitMiB: 100, medianMiB: idle.median, status: threshold(idle.median, 100) },
      actionLatency: { metric: "median of five paired per-run mean action latency relative differences", limitExtraPercent: 20,
        medianExtraPercent: extra, status: threshold(extra ?? null, 20) } };
    report.status = "measured";
  } catch (error) { report.status = "invalid"; report.error = String(error); process.exitCode = 1; }
  finally {
    report.sourceAfter = await sourceIdentity();
    if ((report.sourceAfter as typeof source).sha256 !== source.sha256) {
      report.status = "invalid"; report.error = "Source changed during measurement"; process.exitCode = 1;
    }
    server.stop(true); await rm(root, { recursive: true, force: true });
    await mkdir("output", { recursive: true });
    const output = process.env.ORBIT_PERFORMANCE_OUTPUT ?? "output/browser-performance.json";
    await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ status: report.status, summary: report.summary, targets: report.targets, output, error: report.error }, null, 2));
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--worker") {
    const [arm, root, url, executable] = process.argv.slice(3);
    if ((arm !== "direct" && arm !== "orbit") || !root || !url || !executable) throw new Error("Invalid worker arguments");
    await worker(arm, root, url, executable);
  } else await experiment();
}
