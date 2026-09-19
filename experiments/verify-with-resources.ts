// Keep resource evidence beside a real verification run without changing its result.
import { cpus, freemem, totalmem, loadavg, platform, arch } from "node:os";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const output = join(import.meta.dir, "../output/verification-resources.jsonl");
mkdirSync(join(import.meta.dir, "../output"), { recursive: true });
const started = performance.now();
let previous = cpus();
function sample(event: string, exitCode?: number) {
  const current = cpus();
  let idle = 0, elapsed = 0;
  for (let index = 0; index < current.length; index++) {
    const before = previous[index]?.times, after = current[index]?.times;
    if (!before || !after) continue;
    idle += after.idle - before.idle;
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) elapsed += after[key] - before[key];
  }
  previous = current;
  appendFileSync(output, JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started),
    timestamp: new Date().toISOString(), platform: platform(), arch: arch(), bun: Bun.version,
    logicalCPUs: current.length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
    hostCPUBusyFraction: elapsed > 0 ? 1 - idle / elapsed : null,
    hostLoadAverage: process.platform === "win32" ? null : loadavg(), exitCode,
    scope: "whole runner, not attributed to Orbit; CPU throttling and guest steal time not measured",
  }) + "\n");
}
sample("start");
const timer = setInterval(() => sample("sample"), 1000);
try {
  const child = Bun.spawn([process.execPath, "run", "verify"], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  sample("end", exitCode);
  process.exitCode = exitCode;
} finally {
  clearInterval(timer);
}
