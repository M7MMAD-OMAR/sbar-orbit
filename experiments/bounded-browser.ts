import { createWorkspaceDirectory } from "../src/workspace-storage";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { Sessions } from "../src/session";
import { requireResourceBudget } from "../src/resource-budget";

const budget = await requireResourceBudget();
const entry = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(v => v.startsWith("0::"));
if (!entry) throw new Error("Missing cgroup");
const group = join("/sys/fs/cgroup", entry.slice(3));
const counters = async (file: string) => Object.fromEntries((await readFile(join(group, file), "utf8")).trim().split("\n").map(line => {
  const [key, value] = line.split(/\s+/); return [key, Number(value)];
}));
const value = async (file: string) => Number((await readFile(join(group, file), "utf8")).trim());
const root = await createWorkspaceDirectory("budget-browser");
const sessions = new Sessions(root);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<h1>Orbit bounded test</h1><input id="message"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Waiting</output>', { headers: { "Content-Type": "text/html" } }) });
const started = performance.now();
const baseline = await counters("cpu.stat");
const report: Record<string, unknown> = { status: "running", budget, concurrentBrowsers: 1 };
await mkdir("output", { recursive: true });
await Bun.write("output/bounded-browser.json", JSON.stringify(report));
try {
  const session = await sessions.dispatch({ method: "session.create", params: { backend: "browser" } }) as { sessionId: string };
  report.startupMs = Math.round(performance.now() - started);
  const act = (action: unknown) => sessions.dispatch({ method: "session.act", params: { ...session, requestId: crypto.randomUUID(), action } });
  await act({ type: "navigate", url: `http://127.0.0.1:${server.port}` });
  await act({ type: "fill", selector: "#message", text: "Bounded Orbit works" });
  await act({ type: "click", selector: "button" });
  const result = await act({ type: "read", selector: "output" }) as { text: string };
  if (result.text !== "Bounded Orbit works") throw new Error("Incorrect form result");
  report.formResult = result.text;
  const frame = await sessions.dispatch({ method: "session.observe", params: session }) as { image: string };
  await Bun.write("output/bounded-browser.jpg", Buffer.from(frame.image, "base64"));
  // The owner record goes with the profile when the session stops, so the pid is read first.
  const profiles = await Array.fromAsync(new Bun.Glob("profile-*/owner.json").scan(root));
  if (profiles.length !== 1) throw new Error(`Expected one owned Chrome, found ${profiles.length}`);
  const owner = JSON.parse(await readFile(join(root, profiles[0]!), "utf8")) as { pid: number };
  const stopping = performance.now();
  await sessions.dispatch({ method: "session.stop", params: session });
  report.stopMs = Math.round(performance.now() - stopping);
  if (await Bun.file(`/proc/${owner.pid}/stat`).exists()) throw new Error("Owned Chrome process survived stop");
  if ((await Array.fromAsync(new Bun.Glob("profile-*").scan({ cwd: root, onlyFiles: false }))).length) throw new Error("Profile survived stop");
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await sessions.close(); server.stop(true);
  const elapsedMs = performance.now() - started;
  const cpu = await counters("cpu.stat");
  const cpuSeconds = ((cpu.usage_usec ?? 0) - (baseline.usage_usec ?? 0)) / 1000000;
  Object.assign(report, { elapsedMs: Math.round(elapsedMs), cpuSeconds: Number(cpuSeconds.toFixed(3)),
    averageCpuCores: Number((cpuSeconds / (elapsedMs / 1000)).toFixed(3)),
    averageMachineCpuPercent: Number((100 * cpuSeconds / (elapsedMs / 1000) / cpus().length).toFixed(2)),
    peakMemoryMiB: Number((await value("memory.peak") / 1048576).toFixed(1)), swapBytes: await value("memory.swap.current"),
    memoryEvents: await counters("memory.events"), taskEvents: await counters("pids.events"),
    limitations: ["One local page and one browser, not sustained or concurrent performance.", "Cgroup memory includes the command, descendants and charged cache.", "CPU figures are averages across this run, not instantaneous peaks."] });
  await Bun.write("output/bounded-browser.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
