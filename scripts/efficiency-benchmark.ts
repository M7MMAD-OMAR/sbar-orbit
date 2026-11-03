import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { compareEfficiencyRuns, EfficiencyBenchmarkError, summarizeEfficiencyRun } from "../src/efficiency-benchmark";

export const MAX_BENCHMARK_FILE_BYTES = 2 * 1024 * 1024;
async function readRun(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BENCHMARK_FILE_BYTES) throw new EfficiencyBenchmarkError("Benchmark input must be a regular JSON file of at most 2 MiB");
    // Read a bounded buffer, even if the file grows after stat.
    const buffer = Buffer.alloc(MAX_BENCHMARK_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_BENCHMARK_FILE_BYTES) throw new EfficiencyBenchmarkError("Benchmark input exceeds 2 MiB");
    try { return JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
    catch { throw new EfficiencyBenchmarkError("Benchmark input must be valid JSON"); }
  } finally { await file.close(); }
}

/** No desktop, broker, network or account operations. Errors never echo paths or input content. */
export async function efficiencyBenchmarkCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [command, first, second] = args;
  if (!first || (command !== "summary" && command !== "compare") || args.length !== (command === "summary" ? 2 : 3) || (command === "compare" && !second)) {
    return { exitCode: 2, stdout: "", stderr: "Usage: bun scripts/efficiency-benchmark.ts summary RUN.json | compare BASE.json CANDIDATE.json\n" };
  }
  try {
    const baseline = await readRun(first);
    const result = command === "summary" ? summarizeEfficiencyRun(baseline) : compareEfficiencyRuns(baseline, await readRun(second!));
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n", stderr: "" };
  } catch (error) {
    const message = error instanceof EfficiencyBenchmarkError ? error.message : "Unable to read benchmark input";
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
if (import.meta.main) {
  const result = await efficiencyBenchmarkCli(process.argv.slice(2));
  if (result.stdout) await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr) await Bun.write(Bun.stderr, result.stderr);
  process.exitCode = result.exitCode;
}
