import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { auditProcessScope } from "../src/process-scope";
import { sampleProcessMemory } from "./process-memory";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { requireResourceBudget } from "../src/resource-budget";

const targetSeconds = Number(process.argv[2] ?? 20);
if (!Number.isInteger(targetSeconds) || targetSeconds < 20 || targetSeconds > 600) throw new Error("Choose a duration from 20 to 600 seconds");
const reportPath = targetSeconds === 20 ? "output/viewer-timing.json" : `output/viewer-timing-${targetSeconds}.json`;
if (process.argv[3]) throw new Error("Image transport probes are archived; run the production canvas viewer without a mode argument");
const budget = await requireResourceBudget();
const entry = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(v => v.startsWith("0::"));
if (!entry) throw new Error("Missing cgroup");
const group = join("/sys/fs/cgroup", entry.slice(3));
const counters = async (file: string) => Object.fromEntries((await readFile(join(group, file), "utf8")).trim().split("\n").map(line => {
  const [key, value] = line.split(/\s+/); return [key, Number(value)];
}));
const parentGroup = group.slice(0, group.indexOf("/sbarorbit.slice") + "/sbarorbit.slice".length);
const parentCounters = async (file: string) => Object.fromEntries((await readFile(join(parentGroup, file), "utf8")).trim().split("\n").map(line => {
  const [key, value] = line.split(/\s+/); return [key, Number(value)];
}));
const parentBefore = { memory: await parentCounters("memory.events"), tasks: await parentCounters("pids.events"),
  memoryBytes: Number(await readFile(join(parentGroup, "memory.current"), "utf8")), memoryStat: await parentCounters("memory.stat") };
const before = await counters("cpu.stat");
const start = performance.now();
const broker = await startBroker();
const viewer = await launchChrome(await createWorkspaceDirectory("timing-viewer"), { width: 1280, height: 1100 });
const page = viewer.page;
const evaluate = async <T>(fn: () => T) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([page.evaluate(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Viewer evaluation exceeded 5 seconds")), 5000);
    })]);
  } finally { clearTimeout(timer); }
};
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<style>body{font:32px sans-serif}</style><input id="message"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Waiting</output>', { headers: { "Content-Type": "text/html" } }) });
const scopeAudits: { atMs: number; checked: number; disappearedProcesses: number; escaped: { pid: number; cgroup: string }[] }[] = [];
const memorySamples: Awaited<ReturnType<typeof sampleProcessMemory>>[] = [];
const sharedMemorySamples: { memoryBytes: number; stat: Record<string, number> }[] = [];
const checkScope = async () => {
  const audit = { atMs: Math.round(performance.now() - start), ...await auditProcessScope() };
  scopeAudits.push(audit);
  memorySamples.push(await sampleProcessMemory(group));
  sharedMemorySamples.push({ memoryBytes: Number(await readFile(join(parentGroup, "memory.current"), "utf8")), stat: await parentCounters("memory.stat") });
  await Bun.write(`output/viewer-memory-${targetSeconds}.json`, JSON.stringify({ scopeAudits, memorySamples, sharedMemorySamples }, null, 2));
  if (audit.escaped.length) throw new Error("An owned process moved outside the measured resource scope");
};
const report: Record<string, unknown> = { status: "running", imageTransportProbe: "production-canvas", budget, durationTargetSeconds: targetSeconds, targetFramesPerSecond: 5 };
await mkdir("output", { recursive: true });
await Bun.write(reportPath, JSON.stringify(report));
try {
  const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
  const act = (action: unknown) => { report.lastRequestedAction = (action as { type: string }).type; return call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action }); };
  await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` });
  await page.addInitScript(() => {
    const stats = { frames: [] as { at: number; age: number }[], ages: [] as { at: number; age: number }[], measuring: false, started: 0 };
    (window as any).__orbitTiming = stats;
    document.addEventListener("DOMContentLoaded", () => {
      const frame = document.querySelector<HTMLImageElement>("#frame");
      if (!frame) return;
      new MutationObserver(() => {
        const capturedAt = Number(frame.dataset.capturedAt);
        if (!capturedAt) return;
        void (frame instanceof HTMLImageElement ? frame.decode() : Promise.resolve()).then(() => requestAnimationFrame(() => {
          if (!stats.measuring || frame.hidden || Number(frame.dataset.capturedAt) !== capturedAt) return;
          stats.frames.push({ at: Date.now(), age: Date.now() - capturedAt });
        })).catch(() => {});
      }).observe(frame, { attributes: true, attributeFilter: ["data-captured-at"] });
    });
    setInterval(() => {
      const frame = document.querySelector<HTMLImageElement>("#frame");
      if (stats.measuring && frame && !frame.hidden && frame.dataset.capturedAt) stats.ages.push({ at: Date.now(), age: Date.now() - Number(frame.dataset.capturedAt) });
    }, 50);
  });
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  await page.goto(url);
  await page.locator("#preview-mode").selectOption("smooth");
  await page.locator("#frame").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const frame = document.querySelector("#frame");
    return frame instanceof HTMLImageElement ? frame.complete : frame instanceof HTMLCanvasElement && !!frame.dataset.capturedAt;
  });
  await evaluate(() => { const stats = (window as any).__orbitTiming; stats.started = Date.now(); stats.measuring = true; });
  await checkScope();
  const measuringStarted = performance.now();
  let nextAudit = measuringStarted + 5000;
  const deadline = measuringStarted + targetSeconds * 1000;
  let nextProgress = measuringStarted + 60000;
  let submissions = 0;
  while (performance.now() < deadline) {
    const sharedMemoryBytes = Number(await readFile(join(parentGroup, "memory.current"), "utf8"));
    if (sharedMemoryBytes > 1900 * 1024 * 1024) {
      report.earlyMemoryStopBytes = sharedMemoryBytes;
      throw new Error("Diagnostic stopped above 1900 MiB shared memory before the hard limit");
    }
    const expected = `Live task ${++submissions}`;
    await act({ type: "fill", selector: "#message", text: expected });
    await act({ type: "click", selector: "button" });
    const read = await act({ type: "read", selector: "output" }) as { text: string };
    if (read.text !== expected) throw new Error("Agent action readback mismatch");
    report.completedSubmissions = submissions;
    await Bun.sleep(250);
    if (performance.now() >= nextAudit) { await checkScope(); nextAudit = performance.now() + 5000; }
    if (performance.now() >= nextProgress) {
      const progress = await evaluate(() => {
        const stats = (window as any).__orbitTiming;
        return { elapsedSeconds: Math.round((Date.now() - stats.started) / 1000), frames: stats.frames.length,
          maximumSampledAgeMs: Math.max(...stats.ages.map((sample: { age: number }) => sample.age)) };
      });
      Object.assign(report, { progress: { ...progress, submissions, containmentSamples: scopeAudits.length, memoryBytes: Number(await readFile(join(group, "memory.current"), "utf8")) } });
      await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report.progress));
      nextProgress += 60000;
    }
  }
  await checkScope();
  const stats = await evaluate(() => { const stats = (window as any).__orbitTiming; stats.measuring = false; return { ...stats, ended: Date.now() }; }) as { frames: { at: number; age: number }[]; ages: { at: number; age: number }[]; started: number; ended: number };
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? null;
  const durationSeconds = (stats.ended - stats.started) / 1000;
  const intervals = stats.frames.slice(1).map((frame, i) => frame.at - stats.frames[i]!.at);
  if (stats.frames.length < 2 || errors.length) throw new Error("Viewer frames missing or script failed");
  await page.close();
  const afterClose = await act({ type: "read", selector: "output" }) as { text: string };
  if (afterClose.text !== `Live task ${submissions}`) throw new Error("Session did not survive viewer close");
  Object.assign(report, { status: "measured", durationSeconds, submissions, renderedFrames: stats.frames.length,
    effectiveFramesPerSecond: Number((stats.frames.length / durationSeconds).toFixed(3)),
    decodedFrameAgeP95Ms: percentile(stats.frames.map(frame => frame.age), 0.95), decodedFrameAgeMaxMs: Math.max(...stats.frames.map(frame => frame.age)),
    displayedAgeP95Ms: percentile(stats.ages.map(sample => sample.age), 0.95), displayedAgeMaxMs: Math.max(...stats.ages.map(sample => sample.age)),
    frameIntervalP95Ms: percentile(intervals, 0.95),
    frameIntervalMaxMs: Math.max(...intervals), frameIntervalsOver1s: intervals.filter(ms => ms > 1000).length,
    finalFrameSilenceMs: stats.ended - stats.frames.at(-1)!.at, maxAgeSamplingGapMs: Math.max(...stats.ages.slice(1).map((sample, i) => sample.at - stats.ages[i]!.at)),
    viewerClosePreservesSession: true, errors });
  await call(broker.socket, "session.stop", session);
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await viewer.close(); await broker.close(); fixture.stop(true);
  const elapsedMs = performance.now() - start;
  const after = await counters("cpu.stat");
  const cpuSeconds = ((after.usage_usec ?? 0) - (before.usage_usec ?? 0)) / 1e6;
  Object.assign(report, { containment: { samples: scopeAudits, maximumSamplingGapMs: Math.max(0, ...scopeAudits.slice(1).map((sample, i) => sample.atMs - scopeAudits[i]!.atMs)) }, elapsedMs: Math.round(elapsedMs), cpuSeconds: Number(cpuSeconds.toFixed(3)),
    averageMachineCpuPercent: Number((100 * cpuSeconds / (elapsedMs / 1000) / cpus().length).toFixed(2)),
    peakMemoryBytes: Number(await readFile(join(group, "memory.peak"), "utf8")), swapBytes: Number(await readFile(join(group, "memory.swap.current"), "utf8")),
    memoryEvents: await counters("memory.events"), taskEvents: await counters("pids.events"),
    sharedBudgetEventsBefore: parentBefore,
    sharedBudgetEventsAfter: { memory: await parentCounters("memory.events"), tasks: await parentCounters("pids.events") },
    limitations: ["One local browser session and a headless viewer under one-CPU aggregate cap, not a physical-display or native-viewer measurement.",
      "Process membership is sampled; transient moves or processes created between snapshots can be missed.",
      "Age is based on backend metadata and sampled timers; timer scheduling can exceed its requested interval.",
      "Metadata-bound image decode plus requestAnimationFrame approximates render readiness, not physical pixel presentation.",
      `${targetSeconds} seconds of scripted work; human participation is not inferred, and this is not a matched overhead benchmark.`] });
  await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
