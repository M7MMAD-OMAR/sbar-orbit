// Retain resource and owned trace evidence; preserve child failure and fail an otherwise successful run on incomplete capture.
import { cpus, freemem, totalmem, loadavg, platform, arch } from "node:os";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createChromeTraceArtifactWindow, validateChromeTraceArtifact } from "../tests/chrome-trace-artifact";
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
const checkout = join(import.meta.dir, "..");
const window = createChromeTraceArtifactWindow(checkout);
function producer() {
  const hash = (file: string) => createHash("sha256").update(readFileSync(join(checkout, file))).digest("hex");
  const pkg: unknown = JSON.parse(readFileSync(join(checkout, "node_modules/playwright-core/package.json"), "utf8"));
  if (pkg === null || typeof pkg !== "object" || !("version" in pkg) || typeof pkg.version !== "string") throw new Error("chrome-trace-artifact: dependency version");
  return { chrome: hash("src/chrome.ts"), observer: hash("src/chrome-transport-observer.ts"), fixture: hash("tests/adversarial/reaping-and-secrets.test.ts"), lock: hash("bun.lock"), coreBundle: hash("node_modules/playwright-core/lib/coreBundle.js"), dependencyVersion: pkg.version };
}
const expectedProducer = producer();
sample("start");
const timer = setInterval(() => sample("sample"), 1000);
try {
  const child = Bun.spawn([process.execPath, "run", "verify"], { stdout: "inherit", stderr: "inherit", env: { ...process.env, ORBIT_TEST_CHROME_TRACE_ROOT: window.root, ORBIT_TEST_CHROME_TRACE_TOKEN: window.token } });
  const exitCode = await child.exited;
  sample("end", exitCode);
  process.exitCode = exitCode;
  try {
    if (JSON.stringify(expectedProducer) !== JSON.stringify(producer())) throw new Error("chrome-trace-artifact: source changed during suite");
    const capture = validateChromeTraceArtifact(window, { messages: 65, producer: expectedProducer, observerHealthy: true });
    writeFileSync(join(window.root, "validation.json"), JSON.stringify({ ...capture, messages: capture.messages.map(({ value: _value, ...row }) => row), producer: expectedProducer, childExitCode: exitCode }) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    console.error(JSON.stringify({ chromeTraceArtifact: "incomplete", reason: error instanceof Error ? error.message : "validation failed", childExitCode: exitCode }));
    if (exitCode === 0) process.exitCode = 1;
  }
} finally {
  clearInterval(timer);
}
