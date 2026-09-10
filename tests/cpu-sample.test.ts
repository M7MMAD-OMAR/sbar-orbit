import { expect, test } from "bun:test";
import { cpuInterval, parseHostCpu, type CpuSample } from "../src/cpu-sample";

const before: CpuSample = { monotonicMs: 1000, orbitUsec: 100, logicalCpus: 4, hostTicks: [0, 0, 0, 0, 0, 0, 0, 0] };
const after: CpuSample = { monotonicMs: 3000, orbitUsec: 1000100, logicalCpus: 4, hostTicks: [100, 0, 50, 600, 40, 0, 10, 0] };

test("CPU rates distinguish one-core usage, machine usage and iowait", () => {
  expect(cpuInterval(before, after)).toEqual({ elapsedMs: 2000, logicalCpus: 4,
    orbitOneCorePercent: 50, orbitMachinePercent: 12.5, hostBusyPercent: 20, hostIowaitPercent: 5 });
  expect(parseHostCpu("cpu 100 0 50 600 40 0 10 0 90 0\ncpu0 1\ncpu1 1\n")).toEqual({
    hostTicks: after.hostTicks, logicalCpus: 2 });
});

test("invalid intervals and counter resets produce no misleading percentage", () => {
  for (const change of [{ monotonicMs: 1000 }, { orbitUsec: 0 }, { logicalCpus: 3 },
    { logicalCpus: NaN }, { hostTicks: [] }, { hostTicks: Array(8).fill(0) }, { orbitUsec: Infinity }])
    expect(() => cpuInterval(before, { ...after, ...change })).toThrow();
  expect(() => cpuInterval({ ...before, hostTicks: [0, 0, 0, 0, 41, 0, 0, 0] }, after)).toThrow();
  expect(() => parseHostCpu("cpu 1 2\ncpu0 1")).toThrow();
  expect(() => parseHostCpu("cpu 1 2 3 4 5 6 7 8")).toThrow();
});
