// Retain runner resource evidence for the supported desktop suite and preserve its exit status.
import { cpus, freemem, totalmem, loadavg, platform, arch } from "node:os";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDirectory = process.env.ORBIT_VERIFICATION_OUTPUT_DIR ?? join(import.meta.dir, "../output");
const output = join(outputDirectory, "verification-resources.jsonl");
mkdirSync(outputDirectory, { recursive: true });
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
  const child = Bun.spawn([process.execPath, "run", "verify", ...process.argv.slice(2)], {
    stdout: "inherit", stderr: "inherit", env: process.env,
  });
  const exitCode = await child.exited;
  sample("end", exitCode);
  process.exitCode = exitCode;
  writeFileSync(join(outputDirectory, "verification-result.json"), JSON.stringify({
    suite: "desktop", exitCode,
    nativeRuntime: process.env.ORBIT_TEST_NATIVE === "1" ? "requested; see test results" : "not measured",
    retiredBrowserFlow: "not run",
  }) + "\n");
} finally {
  clearInterval(timer);
}
