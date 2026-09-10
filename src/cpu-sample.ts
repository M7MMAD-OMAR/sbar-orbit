export type CpuSample = { monotonicMs: number; orbitUsec: number; hostTicks: number[]; logicalCpus: number };

export function parseHostCpu(text: string) {
  const lines = text.trim().split("\n");
  const fields = lines.find(line => /^cpu\s/.test(line))?.trim().split(/\s+/).slice(1, 9).map(Number);
  const logicalCpus = lines.filter(line => /^cpu\d+\s/.test(line)).length;
  if (!fields || fields.length !== 8 || !logicalCpus || fields.some(n => !Number.isSafeInteger(n) || n < 0))
    throw new Error("Invalid host CPU counters");
  // Guest time is already included in user and nice; omit its separate columns.
  return { hostTicks: fields, logicalCpus };
}

export function cpuInterval(before: CpuSample, after: CpuSample) {
  const elapsedMs = after.monotonicMs - before.monotonicMs;
  if (![before, after].every(s => Number.isFinite(s.monotonicMs) && Number.isSafeInteger(s.orbitUsec) && s.orbitUsec >= 0 &&
    Number.isSafeInteger(s.logicalCpus) && s.logicalCpus > 0 && s.hostTicks.length === 8 &&
    s.hostTicks.every(n => Number.isSafeInteger(n) && n >= 0)) ||
    elapsedMs <= 0 || before.logicalCpus !== after.logicalCpus || after.orbitUsec < before.orbitUsec)
    throw new Error("Invalid CPU interval or changed CPU count");
  const ticks = after.hostTicks.map((n, i) => n - (before.hostTicks[i] ?? NaN));
  const total = ticks.reduce((a, b) => a + b, 0);
  // Linux iowait can decrease. Reject such intervals instead of inventing a rate.
  if (ticks.some(n => n < 0) || total <= 0) throw new Error("CPU counters reset or did not advance");
  const idle = ticks[3] ?? 0, iowait = ticks[4] ?? 0;
  const orbitOneCorePercent = (after.orbitUsec - before.orbitUsec) / (elapsedMs * 10);
  return { elapsedMs, logicalCpus: after.logicalCpus, orbitOneCorePercent,
    orbitMachinePercent: orbitOneCorePercent / after.logicalCpus,
    hostBusyPercent: (total - idle - iowait) / total * 100,
    hostIowaitPercent: iowait / total * 100 };
}
