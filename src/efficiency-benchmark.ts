/** Content-free, caller-recorded measurements only. This module does not collect evidence. */
export const MIN_COMPARISON_SAMPLES_PER_TASK = 20;
export const MAX_BENCHMARK_SAMPLES = 10_000;
const metricNames = ["retries", "interventions", "responseBytes", "tokens"] as const;
type Metric = typeof metricNames[number];
export type EfficiencySample = {
  sampleId: string;
  taskId: string;
  /** Observed task result, never just a delivery acknowledgement. */
  outcome: "success" | "failure";
  outcomeObserved: true;
  /** End-to-end task duration, including retries and interventions. */
  durationMs: number;
} & Partial<Record<Metric, number>>;
export interface EfficiencyRun {
  schemaVersion: 1;
  /** An assertion by the recorder, not independently verified by this evaluator. */
  measured: true;
  execution: "serial";
  runId: string;
  /** Opaque identity pinning exact source revision, build and runtime configuration. */
  configId: string;
  environmentId: string;
  /** Pins task definitions, outcomes, timing boundaries and metric counting rules. */
  protocolId: string;
  tokenMeasurementId?: string;
  /** Full serial observation window, including idle time and failed tasks. */
  elapsedMs: number;
  samples: EfficiencySample[];
}

export class EfficiencyBenchmarkError extends Error {
  constructor(message: string) { super(message); this.name = "EfficiencyBenchmarkError"; }
}
function fail(message: string): never { throw new EfficiencyBenchmarkError(message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected benchmark object");
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) fail("Expected plain benchmark object");
  if (Reflect.ownKeys(record).some(key => typeof key !== "string" || !keys.includes(key))) fail("Unknown benchmark field; content is not accepted");
  return record;
}
function id(value: unknown): string {
  // Opaque labels only. Do not put window titles, URLs, prompts or application text here.
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) fail("Expected opaque benchmark identifier");
  return value;
}
function number(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER ||
      (integer && !Number.isSafeInteger(value))) fail("Invalid benchmark measurement");
  return value;
}
function sum(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) fail("Benchmark aggregate exceeds numeric limit");
  return total;
}

/** Rejects unrecognized fields rather than carrying arbitrary application content into reports. */
export function parseEfficiencyRun(value: unknown): EfficiencyRun {
  const run = object(value, ["schemaVersion", "measured", "execution", "runId", "configId", "environmentId", "protocolId", "tokenMeasurementId", "elapsedMs", "samples"]);
  if (run.schemaVersion !== 1 || run.measured !== true || run.execution !== "serial") fail("Expected measured serial benchmark schema version 1");
  if (!Array.isArray(run.samples) || !run.samples.length || run.samples.length > MAX_BENCHMARK_SAMPLES) fail("Invalid benchmark sample count");
  const ids = new Set<string>();
  const samples = Array.from(run.samples, (value: unknown): EfficiencySample => {
    const sample = object(value, ["sampleId", "taskId", "outcome", "outcomeObserved", "durationMs", ...metricNames]);
    const sampleId = id(sample.sampleId);
    if (ids.has(sampleId)) fail("Duplicate benchmark sample identifier");
    ids.add(sampleId);
    if ((sample.outcome !== "success" && sample.outcome !== "failure") || sample.outcomeObserved !== true) fail("Expected explicitly observed task outcome");
    const durationMs = number(sample.durationMs);
    if (durationMs === 0) fail("Task duration must be positive");
    const result: EfficiencySample = { sampleId, taskId: id(sample.taskId), outcome: sample.outcome, outcomeObserved: true, durationMs };
    for (const metric of metricNames) {
      if (Object.hasOwn(sample, metric)) result[metric] = number(sample[metric], true);
    }
    return result;
  });
  for (const metric of metricNames) {
    const count = samples.filter(sample => sample[metric] !== undefined).length;
    if (count !== 0 && count !== samples.length) fail("Optional metric requires complete sample coverage");
    if (count) sum(samples.map(sample => sample[metric]!));
  }
  const elapsedMs = number(run.elapsedMs);
  // Deliberately conservative: do not forgive fractional sum rounding with an elapsed-time tolerance.
  if (elapsedMs < 1 || elapsedMs < sum(samples.map(sample => sample.durationMs))) fail("Serial elapsed time must cover all task durations and be at least 1 ms");
  const result: EfficiencyRun = {
    schemaVersion: 1, measured: true, execution: "serial", runId: id(run.runId), configId: id(run.configId),
    environmentId: id(run.environmentId), protocolId: id(run.protocolId), elapsedMs, samples,
  };
  const hasTokens = samples[0]?.tokens !== undefined;
  if (hasTokens !== Object.hasOwn(run, "tokenMeasurementId")) fail("Token measurements require exactly one counting definition");
  if (hasTokens) result.tokenMeasurementId = id(run.tokenMeasurementId);
  return result;
}

function latency(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return { p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1]!, p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]! };
}
function successInterval(successes: number, count: number) {
  const z = 1.959963984540054, p = successes / count, denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
function summarizeSamples(samples: EfficiencySample[]) {
  const successes = samples.filter(sample => sample.outcome === "success");
  const metrics: Partial<Record<Metric, { total: number; meanPerSample: number; nonzeroSampleRate: number }>> = {};
  for (const metric of metricNames) {
    if (samples[0]?.[metric] !== undefined) {
      const values = samples.map(sample => sample[metric]!);
      const total = sum(values);
      metrics[metric] = { total, meanPerSample: total / samples.length, nonzeroSampleRate: values.filter(value => value > 0).length / samples.length };
    }
  }
  return {
    sampleCount: samples.length, successes: successes.length, failures: samples.length - successes.length,
    successRate: successes.length / samples.length, failureRate: 1 - successes.length / samples.length,
    successRateWilson95: successInterval(successes.length, samples.length),
    latency: latency(samples.map(sample => sample.durationMs))!,
    successfulLatency: latency(successes.map(sample => sample.durationMs)), metrics,
  };
}
const uncertainty = {
  kind: "descriptive-only" as const,
  notes: [
    "Measurements are supplied by the caller, not independently verified.",
    "Wilson 95% success intervals assume independent Bernoulli observations; repeated tasks may violate this assumption.",
    "Latency percentiles use nearest rank, not confidence bounds. No latency or throughput confidence interval is estimated.",
    "No causal, statistical significance, generalization or performance target claim is established.",
    "Relative percent deltas are null for a zero baseline or an unrepresentable numeric ratio.",
    "The 20-sample comparison gate is a policy floor, not a guarantee of precision; p95 may be unstable.",
  ],
};
function uncertaintyReport() {
  // Never expose shared warning state to callers, including nested comparison summaries.
  return { ...uncertainty, notes: [...uncertainty.notes] };
}
function summarize(run: EfficiencyRun) {
  const groups = new Map<string, EfficiencySample[]>();
  for (const sample of run.samples) {
    const group = groups.get(sample.taskId) ?? [];
    group.push(sample); groups.set(sample.taskId, group);
  }
  const tasks = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([taskId, samples]) => ({
    taskId, ...summarizeSamples(samples),
  }));
  const summary = summarizeSamples(run.samples);
  return {
    schemaVersion: 1 as const, runId: run.runId, configId: run.configId, environmentId: run.environmentId,
    protocolId: run.protocolId, ...(run.tokenMeasurementId ? { tokenMeasurementId: run.tokenMeasurementId } : {}),
    elapsedMs: run.elapsedMs, ...summary,
    successThroughputPerSecond: summary.successes * 1000 / run.elapsedMs,
    tasks, uncertainty: uncertaintyReport(),
  };
}
export function summarizeEfficiencyRun(value: unknown) { return summarize(parseEfficiencyRun(value)); }
function delta(baseline: number, candidate: number) {
  const relative = baseline === 0 ? NaN : (candidate - baseline) / baseline * 100;
  return { absolute: candidate - baseline, relativePercent: Number.isFinite(relative) ? relative : null };
}

/** Compatibility is necessary, not sufficient evidence of an improvement. No target verdict is emitted. */
export function compareEfficiencyRuns(baselineValue: unknown, candidateValue: unknown) {
  const baselineRun = parseEfficiencyRun(baselineValue), candidateRun = parseEfficiencyRun(candidateValue);
  if (baselineRun.runId === candidateRun.runId) fail("Comparison requires distinct run identifiers");
  for (const key of ["environmentId", "protocolId", "tokenMeasurementId"] as const) {
    if (baselineRun[key] !== candidateRun[key]) fail("Benchmark measurement contexts are incompatible");
  }
  for (const metric of metricNames) {
    if ((baselineRun.samples[0]?.[metric] !== undefined) !== (candidateRun.samples[0]?.[metric] !== undefined)) fail("Benchmark metric coverage differs");
  }
  const baseline = summarize(baselineRun), candidate = summarize(candidateRun);
  if (baseline.tasks.length !== candidate.tasks.length) fail("Benchmark task mixes differ");
  baseline.tasks.forEach((task, index) => {
    const other = candidate.tasks[index];
    if (!other || task.taskId !== other.taskId || task.sampleCount !== other.sampleCount) fail("Benchmark task mixes differ");
    if (task.sampleCount < MIN_COMPARISON_SAMPLES_PER_TASK) fail("Comparison requires at least 20 samples per task in each run");
  });
  const metrics: Partial<Record<Metric, ReturnType<typeof delta>>> = {};
  for (const metric of metricNames) {
    const before = baseline.metrics[metric], after = candidate.metrics[metric];
    if (before && after) metrics[metric] = delta(before.meanPerSample, after.meanPerSample);
  }
  return {
    schemaVersion: 1 as const, baseline, candidate,
    minimumSamplesPerTask: MIN_COMPARISON_SAMPLES_PER_TASK,
    observedRegressions: {
      p50Latency: candidate.latency.p50Ms > baseline.latency.p50Ms,
      p95Latency: candidate.latency.p95Ms > baseline.latency.p95Ms,
      successThroughput: candidate.successThroughputPerSecond < baseline.successThroughputPerSecond,
      failureRate: candidate.failureRate > baseline.failureRate,
    },
    deltas: {
      p50Ms: delta(baseline.latency.p50Ms, candidate.latency.p50Ms),
      p95Ms: delta(baseline.latency.p95Ms, candidate.latency.p95Ms),
      successThroughputPerSecond: delta(baseline.successThroughputPerSecond, candidate.successThroughputPerSecond),
      failureRate: delta(baseline.failureRate, candidate.failureRate), metrics,
    },
    uncertainty: uncertaintyReport(),
  };
}
