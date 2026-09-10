import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { requireResourceBudget } from "../src/resource-budget";

const budget = await requireResourceBudget();
const entry = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"));
if (!entry) throw new Error("Missing cgroup");
const group = join("/sys/fs/cgroup", entry.slice(3));
const value = async (file: string) => (await readFile(join(group, file), "utf8")).trim();
const counters = async (file: string) => Object.fromEntries((await value(file)).split("\n").map(line => {
  const [key, count] = line.split(/\s+/); return [key, Number(count)];
}));
await mkdir("output", { recursive: true });
const before = await counters("cpu.stat");
const start = performance.now();
const timeoutSeconds = process.env.ORBIT_TEST_NATIVE === "1" ? 180 : 90;
const child = Bun.spawn(["/usr/bin/timeout", "--kill-after=5", String(timeoutSeconds), process.execPath, "test", ...process.argv.slice(2)],
  { stdout: "pipe", stderr: "pipe" });
const stream = async (input: ReadableStream<Uint8Array>) => {
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of input) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    process.stdout.write(text);
  }
  return output + decoder.decode();
};
const [stdout, stderr, code] = await Promise.all([stream(child.stdout), stream(child.stderr), child.exited]);
await Bun.write("output/measured-suite.log", stdout + stderr);
const elapsedMs = performance.now() - start;
const after = await counters("cpu.stat");
const cpuSeconds = ((after.usage_usec ?? 0) - (before.usage_usec ?? 0)) / 1e6;
const report = {
  status: code === 0 ? "passed" : "failed", exitCode: code, args: process.argv.slice(2), budget, timeoutSeconds,
  elapsedMs: Math.round(elapsedMs), cpuSeconds: Number(cpuSeconds.toFixed(3)),
  averageMachineCpuPercent: Number((cpuSeconds / (elapsedMs / 1000) / cpus().length * 100).toFixed(2)),
  peakMemoryBytes: Number(await value("memory.peak")), swapBytes: Number(await value("memory.swap.current")),
  memoryEvents: await counters("memory.events"), taskEvents: await counters("pids.events"),
  nativeEnabled: process.env.ORBIT_TEST_NATIVE === "1",
};
await Bun.write("output/measured-suite.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exitCode = code;
