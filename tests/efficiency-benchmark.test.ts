import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareEfficiencyRuns, EfficiencyBenchmarkError, MAX_BENCHMARK_SAMPLES, parseEfficiencyRun,
  summarizeEfficiencyRun, type EfficiencyRun,
} from "../src/efficiency-benchmark";
import { efficiencyBenchmarkCli, MAX_BENCHMARK_FILE_BYTES } from "../scripts/efficiency-benchmark";

// Synthetic arithmetic fixtures only, not evidence of real application performance.
function run(runId = "baseline", count = 20): EfficiencyRun {
  return {
    schemaVersion: 1, measured: true, execution: "serial", runId, configId: "build-a", environmentId: "env-a", protocolId: "protocol-a",
    elapsedMs: count * 100,
    samples: Array.from({ length: count }, (_, index) => ({
      sampleId: "sample-" + index, taskId: "task-a", outcome: "success", outcomeObserved: true, durationMs: (index + 1) * 5,
    })),
  };
}
function rejects(value: unknown) { expect(() => parseEfficiencyRun(value)).toThrow(EfficiencyBenchmarkError); }

describe("strict measured benchmark records", () => {
  test("parses a defensive copy and does not mutate input", () => {
    const input = run(), parsed = parseEfficiencyRun(input);
    parsed.samples[0]!.durationMs = 1;
    expect(input.samples[0]!.durationMs).toBe(5);
  });
  test("requires explicit measurements, serial execution and observed outcomes", () => {
    for (const patch of [{ measured: false }, { schemaVersion: 2 }, { execution: "parallel" }, { elapsedMs: 0 }]) rejects({ ...run(), ...patch });
    for (const patch of [{ outcome: "delivered" }, { outcomeObserved: false }, { outcomeObserved: undefined }]) {
      const input = run(); Object.assign(input.samples[0]!, patch); rejects(input);
    }
  });
  test("rejects missing identities, content fields and unsafe identifiers without echo", () => {
    for (const key of ["runId", "configId", "environmentId", "protocolId"]) rejects({ ...run(), [key]: undefined });
    rejects({ ...run(), prompt: "private-content" });
    const input = run(); Object.assign(input.samples[0]!, { title: "private-content" }); rejects(input);
    expect(() => parseEfficiencyRun({ ...run(), runId: "https://private-content" })).toThrow("Expected opaque benchmark identifier");
  });
  test("rejects nonfinite, negative, zero, coerced and unsafe measurements", () => {
    for (const value of [NaN, Infinity, -1, 0, "5", Number.MAX_SAFE_INTEGER + 1, null]) {
      const input = run(); Object.assign(input.samples[0]!, { durationMs: value }); rejects(input);
    }
    for (const value of [-1, NaN, Infinity, "2000"]) rejects({ ...run(), elapsedMs: value });
  });
  test("rejects empty, oversized, duplicate and incomplete samples", () => {
    rejects({ ...run(), samples: [] });
    rejects({ ...run(), samples: Array(MAX_BENCHMARK_SAMPLES + 1).fill(run().samples[0]) });
    const input = run(); input.samples[1]!.sampleId = input.samples[0]!.sampleId; rejects(input);
    rejects({ ...run(), samples: [{}] });
    rejects({ ...run(), samples: Array(2) });
    rejects(Object.create(run()));
  });
  test("serial elapsed includes all durations and cannot overflow", () => {
    rejects({ ...run(), elapsedMs: 1049 });
    const input = run(); input.samples.forEach(sample => { sample.durationMs = Number.MAX_SAFE_INTEGER; }); rejects(input);
  });
  test("optional counters require full coverage, integer counts and bounded totals", () => {
    const input = run(); input.samples[0]!.retries = 1; rejects(input);
    input.samples.forEach(sample => { sample.retries = 0.5; }); rejects(input);
    input.samples.forEach(sample => { sample.retries = Number.MAX_SAFE_INTEGER; }); rejects(input);
    input.samples.forEach(sample => { sample.retries = 0; }); expect(parseEfficiencyRun(input).samples[0]!.retries).toBe(0);
  });
  test("token counts require their counting identity and vice versa", () => {
    const input = run(); input.samples.forEach(sample => { sample.tokens = 5; }); rejects(input);
    input.tokenMeasurementId = "tokenizer-a"; expect(parseEfficiencyRun(input).tokenMeasurementId).toBe("tokenizer-a");
    rejects({ ...run(), tokenMeasurementId: "tokenizer-a" });
  });
});

describe("honest descriptive summaries", () => {
  test("nearest-rank percentiles include failures, throughput uses full window", () => {
    const input = run(); input.samples[19]!.outcome = "failure";
    const result = summarizeEfficiencyRun(input);
    expect(result.latency).toEqual({ p50Ms: 50, p95Ms: 95 });
    expect(result.successfulLatency).toEqual({ p50Ms: 50, p95Ms: 95 });
    expect(result.successThroughputPerSecond).toBe(9.5);
    expect(result.failures).toBe(1); expect(result.failureRate).toBeCloseTo(0.05);
    expect(result.metrics).toEqual({}); expect(result.tasks[0]!.sampleCount).toBe(20);
  });
  test("all failed samples have no successful latency or invented throughput", () => {
    const input = run(); input.samples.forEach(sample => { sample.outcome = "failure"; });
    const result = summarizeEfficiencyRun(input);
    expect(result.successfulLatency).toBeNull(); expect(result.successThroughputPerSecond).toBe(0);
    expect(result.successRateWilson95.low).toBeCloseTo(0);
    expect(result.successRateWilson95.high).toBeGreaterThan(0);
  });
  test("all success remains uncertain and single observation summaries are allowed", () => {
    const result = summarizeEfficiencyRun(run("single", 1));
    expect(result.successRateWilson95.low).toBeLessThan(1);
    expect(result.successRateWilson95.high).toBeCloseTo(1);
    expect(result.uncertainty.kind).toBe("descriptive-only");
    expect(result.uncertainty.notes.join(" ")).toContain("independent Bernoulli");
    expect(result.uncertainty.notes.join(" ")).toContain("No latency or throughput confidence interval");
  });
  test("uncertainty mutation cannot affect sibling or future reports", () => {
    const original = summarizeEfficiencyRun(run()).uncertainty;
    const expectedNotes = [...original.notes];
    original.notes.splice(0);
    Reflect.set(original, "kind", "tampered");
    const comparison = compareEfficiencyRuns(run(), run("candidate"));
    expect(comparison.uncertainty).toEqual({ kind: "descriptive-only", notes: expectedNotes });
    comparison.uncertainty.notes.push("tampered");
    comparison.baseline.uncertainty.notes.splice(0);
    Reflect.set(comparison.candidate.uncertainty, "kind", "tampered");
    expect(comparison.candidate.uncertainty.notes).toEqual(expectedNotes);
    expect(summarizeEfficiencyRun(run()).uncertainty).toEqual({ kind: "descriptive-only", notes: expectedNotes });
    const later = compareEfficiencyRuns(run(), run("candidate"));
    for (const warning of [later.uncertainty, later.baseline.uncertainty, later.candidate.uncertainty]) {
      expect(warning).toEqual({ kind: "descriptive-only", notes: expectedNotes });
    }
  });
  test("reports measured counters, rates, bytes and tokens only when supplied", () => {
    const input = run(); input.tokenMeasurementId = "tokenizer-a";
    input.samples.forEach((sample, index) => Object.assign(sample, { retries: index === 0 ? 2 : 0, interventions: 0, responseBytes: 10, tokens: 3 }));
    const result = summarizeEfficiencyRun(input);
    expect(result.metrics.retries).toEqual({ total: 2, meanPerSample: 0.1, nonzeroSampleRate: 0.05 });
    expect(result.metrics.responseBytes!.total).toBe(200); expect(result.metrics.tokens!.total).toBe(60);
  });
  test("task groups are deterministic and raw samples are not copied into reports", () => {
    const input = run(); input.samples[0]!.taskId = "task-b";
    const result = summarizeEfficiencyRun(input);
    expect(result.tasks.map(task => task.taskId)).toEqual(["task-a", "task-b"]);
    expect(JSON.stringify(result)).not.toContain("sample-0");
  });
});

describe("compatible measured-run comparisons", () => {
  test("descriptive deltas do not become a target or confidence verdict", () => {
    const before = run(), after = run("candidate"); after.configId = "build-b";
    after.samples.forEach(sample => { sample.durationMs /= 2; }); after.elapsedMs /= 2;
    const result = compareEfficiencyRuns(before, after);
    expect(result.deltas.p50Ms.relativePercent).toBe(-50);
    expect(result.deltas.successThroughputPerSecond.relativePercent).toBe(100);
    expect(result.observedRegressions.p50Latency).toBe(false);
    expect(result).not.toHaveProperty("targetPassed"); expect(result).not.toHaveProperty("significant");
  });
  test("flags observed latency, failure and throughput regressions without inference", () => {
    const before = run(), after = run("candidate");
    after.elapsedMs *= 2; after.samples.forEach(sample => { sample.durationMs *= 2; }); after.samples[0]!.outcome = "failure";
    expect(compareEfficiencyRuns(before, after).observedRegressions).toEqual({ p50Latency: true, p95Latency: true, successThroughput: true, failureRate: true });
  });
  test("rejects same run, different environment, protocol and metric coverage", () => {
    const before = run();
    for (const patch of [{ runId: "baseline" }, { environmentId: "other" }, { protocolId: "other" }]) {
      expect(() => compareEfficiencyRuns(before, { ...run("candidate"), ...patch })).toThrow(EfficiencyBenchmarkError);
    }
    const after = run("candidate"); after.samples.forEach(sample => { sample.retries = 0; });
    expect(() => compareEfficiencyRuns(before, after)).toThrow("coverage differs");
  });
  test("rejects changed token definition", () => {
    const before = run(), after = run("candidate");
    for (const input of [before, after]) { input.samples.forEach(sample => { sample.tokens = 1; }); }
    before.tokenMeasurementId = "a"; after.tokenMeasurementId = "b";
    expect(() => compareEfficiencyRuns(before, after)).toThrow("incompatible");
  });
  test("requires equal task counts and 20 samples per task, not just total", () => {
    expect(() => compareEfficiencyRuns(run("a", 19), run("b", 19))).toThrow("at least 20");
    const before = run(), after = run("candidate"); before.samples[0]!.taskId = "task-b"; after.samples[0]!.taskId = "task-b";
    expect(() => compareEfficiencyRuns(before, after)).toThrow("at least 20");
    expect(() => compareEfficiencyRuns(run(), after)).toThrow("task mixes differ");
    expect(() => compareEfficiencyRuns(run(), run("candidate", 21))).toThrow("task mixes differ");
  });
  test("zero baseline rates use null relative deltas and retain absolute changes", () => {
    const after = run("candidate"); after.samples[0]!.outcome = "failure";
    const result = compareEfficiencyRuns(run(), after);
    expect(result.deltas.failureRate.relativePercent).toBeNull(); expect(result.deltas.failureRate.absolute).toBeCloseTo(0.05);
  });
});

describe("bounded local JSON CLI", () => {
  test("usage and IO errors do not echo owner paths", async () => {
    expect((await efficiencyBenchmarkCli([])).exitCode).toBe(2);
    expect((await efficiencyBenchmarkCli(["summary", "a", "extra"])).exitCode).toBe(2);
    const result = await efficiencyBenchmarkCli(["summary", "/missing/private-owner-path"]);
    expect(result.exitCode).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("private-owner-path");
  });
  test("summary and comparison return JSON, malformed/content/oversized inputs fail privately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbit-efficiency-test-"));
    try {
      const first = join(directory, "a.json"), second = join(directory, "b.json");
      await writeFile(first, JSON.stringify(run())); await writeFile(second, JSON.stringify(run("candidate")));
      const summary = await efficiencyBenchmarkCli(["summary", first]);
      expect(summary.exitCode).toBe(0); expect(JSON.parse(summary.stdout).sampleCount).toBe(20);
      const comparison = await efficiencyBenchmarkCli(["compare", first, second]);
      expect(comparison.exitCode).toBe(0); expect(JSON.parse(comparison.stdout).uncertainty.kind).toBe("descriptive-only");
      await writeFile(first, '{"private-content":');
      let invalid = await efficiencyBenchmarkCli(["summary", first]); expect(invalid.exitCode).toBe(1); expect(invalid.stderr).not.toContain("private-content");
      await writeFile(first, JSON.stringify({ ...run(), prompt: "private-content" }));
      invalid = await efficiencyBenchmarkCli(["summary", first]); expect(invalid.exitCode).toBe(1); expect(invalid.stderr).not.toContain("private-content");
      await writeFile(first, " ".repeat(MAX_BENCHMARK_FILE_BYTES + 1));
      expect((await efficiencyBenchmarkCli(["summary", first])).exitCode).toBe(1);
      expect((await efficiencyBenchmarkCli(["summary", directory])).exitCode).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
