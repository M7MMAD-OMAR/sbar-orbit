import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

const budget = await requireResourceBudget();
const entry = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(v => v.startsWith("0::"));
if (!entry) throw new Error("Missing cgroup");
const group = join("/sys/fs/cgroup", entry.slice(3));
const counters = async (file: string) => Object.fromEntries((await readFile(join(group, file), "utf8")).trim().split("\n").map(line => {
  const [key, value] = line.split(/\s+/); return [key, Number(value)];
}));
const value = async (file: string) => Number((await readFile(join(group, file), "utf8")).trim());
const submissions = new Map<string, number>();
const page = `<!doctype html><meta charset="utf-8"><input id="message"><button>Save</button><output></output>
<script>
const input=document.querySelector('input'),out=document.querySelector('output');
input.value=localStorage.getItem('message')||'';out.textContent=input.value;
document.querySelector('button').onclick=async()=>{
 const text=input.value;localStorage.setItem('message',text);
 const response=await fetch('/submit',{method:'POST',body:text});
 out.textContent=response.ok?text:'FAILED';
};
</script>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/submit" && request.method === "POST") {
    const text = await request.text(); submissions.set(text, (submissions.get(text) ?? 0) + 1);
    return new Response("Saved");
  }
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
} });
const started = performance.now();
const baseline = await counters("cpu.stat");
const report: Record<string, unknown> = { status: "running", startedAt: new Date().toISOString(), budget, concurrentBrowsers: 2, submissionsPerSession: 100, transport: "Unix socket RPC" };
await mkdir("output", { recursive: true });
const broker = await startBroker();
const counts = [0, 0];
try {
  const ids = await Promise.all([0, 1].map(async () => {
    const result = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    return result.sessionId;
  }));
  const [a, b] = ids;
  if (!a || !b || a === b) throw new Error("Two distinct sessions required");
  report.startupMs = Math.round(performance.now() - started);
  const act = (sessionId: string, action: unknown) => call(broker.socket, "session.act", { sessionId, requestId: crypto.randomUUID(), action });
  const url = `http://127.0.0.1:${server.port}`;
  const readExact = async (sessionId: string, expected: string) => {
    const deadline = performance.now() + 3000;
    do {
      const result = await act(sessionId, { type: "read", selector: "output" }) as { text: string };
      if (result.text === expected) return;
      await Bun.sleep(20);
    } while (performance.now() < deadline);
    throw new Error(`Incorrect result for ${expected}`);
  };
  await Promise.all(ids.map(id => act(id, { type: "navigate", url })));
  // Each round schedules both sessions before awaiting either result.
  for (let round = 1; round <= 100; round++) {
    await Promise.all(ids.map(async (id, index) => {
      const expected = `Agent ${index} / ${round} / مرحبا`;
      await act(id, { type: "fill", selector: "#message", text: expected });
      await act(id, { type: "click", selector: "button" });
      await readExact(id, expected);
      if (submissions.get(expected) !== 1) throw new Error("Missing or duplicate server submission");
      if (round % 10 === 0) {
        await act(id, { type: "navigate", url });
        await readExact(id, expected);
      }
      counts[index] = round;
    }));
    if (round % 25 === 0) console.log(`Verified ${round} submissions per session`);
  }
  const stopping = performance.now();
  const stopped = await call(broker.socket, "session.stop", { sessionId: a }) as { state: string };
  report.stopFirstMs = Math.round(performance.now() - stopping);
  if (stopped.state !== "closed" || Number(report.stopFirstMs) >= 5000) throw new Error("Stop did not meet acknowledgement deadline");
  await act(b, { type: "fill", selector: "#message", text: "B works after A stops" });
  await act(b, { type: "click", selector: "button" });
  await readExact(b, "B works after A stops");
  if (submissions.size !== 201 || [...submissions.values()].some(count => count !== 1)) throw new Error("Unexpected submission ledger");
  await call(broker.socket, "session.stop", { sessionId: b });
  Object.assign(report, { status: "passed", verifiedSubmissions: counts, serverSubmissions: submissions.size,
    storageReloadChecks: 20, secondSessionWorksAfterFirstStops: true });
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  await broker.close(); server.stop(true);
  const elapsedMs = performance.now() - started;
  const cpu = await counters("cpu.stat");
  const cpuSeconds = ((cpu.usage_usec ?? 0) - (baseline.usage_usec ?? 0)) / 1000000;
  Object.assign(report, { elapsedMs: Math.round(elapsedMs), cpuSeconds: Number(cpuSeconds.toFixed(3)),
    averageMachineCpuPercent: Number((100 * cpuSeconds / (elapsedMs / 1000) / cpus().length).toFixed(2)),
    peakMemoryMiB: Number((await value("memory.peak") / 1048576).toFixed(1)), swapBytes: await value("memory.swap.current"),
    memoryEvents: await counters("memory.events"), taskEvents: await counters("pids.events"),
    limitations: ["Local fixture, two scripted RPC clients, not model reasoning or all applications.",
      "No host focus telemetry or simultaneous human-work measurement in this probe.",
      "Stop measures acknowledgement, not a separate descendant PID census.",
      "CPU is a run average; memory includes the command, descendants and charged cache."] });
  await Bun.write("output/concurrent-browser.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
