import { expect, test } from "bun:test";
import { toArrayBuffer, type Pointer } from "bun:ffi";
import { WindowsJob } from "../src/windows-job";
import { confirmedWindowsStop, type StopEvidence } from "../src/owned-cleanup";
import * as residentHelpers from "../src/owned-process-resident";

// Actual WindowsJob methods with owned fake handles and real Bun pointer-backed buffers.
// No constructor/native job or provider measurement is claimed.
function fixture() {
  const state = { members: [11, 22], assigned: undefined as number | undefined,
    listed: undefined as number | undefined, queries: 0, opens: [] as number[], reads: [] as number[], checks: [] as number[],
    assignments: [] as number[], expectedRights: 0x410,
    closes: [] as number[], openFault: 0, wrongJob: 0, membershipFault: 0, readFault: 0,
    closeFault: 0, vanished: 0, queryFault: false, memory: 2048n,
    openHandle: undefined as number | bigint | null | undefined };
  const view = (pointer: Pointer, bytes: number) => new DataView(toArrayBuffer(pointer, 0, bytes));
  const api = {
    QueryInformationJobObject: (handle: number, kind: number, buffer: Pointer, size: number) => {
      expect(handle).toBe(700); expect(kind).toBe(3); state.queries++;
      if (state.queryFault) return false;
      const block = view(buffer, size);
      block.setUint32(0, state.assigned ?? state.members.length, true);
      block.setUint32(4, state.listed ?? state.members.length, true);
      state.members.slice(0, (size - 8) / 8).forEach((pid, index) => block.setBigUint64(8 + index * 8, BigInt(pid), true));
      return true;
    },
    OpenProcess: (rights: number, inherit: boolean, pid: number) => {
      expect(rights).toBe(state.expectedRights); expect(inherit).toBe(false); state.opens.push(pid);
      if (state.vanished === pid) state.members = state.members.filter(value => value !== pid);
      return state.openFault === pid ? 0 : state.openHandle !== undefined ? state.openHandle : pid + 1000;
    },
    IsProcessInJob: (handle: number, job: number, buffer: Pointer) => {
      state.checks.push(handle);
      expect(job).toBe(700);
      view(buffer, 4).setUint32(0, handle - 1000 === state.wrongJob ? 0 : 1, true);
      return handle - 1000 !== state.membershipFault;
    },
    K32GetProcessMemoryInfo: (handle: number, buffer: Pointer, size: number) => {
      const block = view(buffer, size);
      expect(size).toBe(80); expect(block.getUint32(0, true)).toBe(80);
      state.reads.push(handle - 1000);
      block.setBigUint64(16, state.memory, true);
      return handle - 1000 !== state.readFault;
    },
    CloseHandle: (handle: number) => { state.closes.push(handle - 1000); return handle - 1000 !== state.closeFault; },
    GetLastError: () => 5,
    AssignProcessToJobObject: (job: number, handle: number) => {
      expect(job).toBe(700); state.assignments.push(handle); return true;
    },
  };
  const job = Object.assign(Object.create(WindowsJob.prototype), { api, handle: 700, closed: false }) as WindowsJob;
  return { state, job };
}

test("actual method reads only pinned job members, sums EX WorkingSetSize and closes every handle", () => {
  const { state, job } = fixture();
  expect(job.residentSample()).toEqual({ pids: [11, 22], rssKiB: 4, source: "owned Windows job working set" });
  expect(state.opens).toEqual([11, 22]); expect(state.reads).toEqual([11, 22]); expect(state.closes).toEqual([11, 22]);
});
test("member churn omits a vanished member only after a fresh kernel list", () => {
  const { state, job } = fixture(); state.openFault = 11; state.vanished = 11;
  expect(job.residentSample().pids).toEqual([22]); expect(state.queries).toBe(2); expect(state.closes).toEqual([22]);
});
for (const fault of ["openFault", "wrongJob", "membershipFault", "readFault", "closeFault"] as const) {
  test(`actual sampler rejects still-listed ${fault} and closes opened handles`, () => {
    const { state, job } = fixture(); state[fault] = 11;
    expect(() => job.residentSample()).toThrow();
    expect(state.closes).toEqual(fault === "openFault" ? [] : [11]);
    if (fault === "wrongJob" || fault === "membershipFault") expect(state.reads).toEqual([]);
  });
}
test("reused pid outside the job is never read even when it vanishes from the refreshed job list", () => {
  const { state, job } = fixture(); state.wrongJob = 11; state.vanished = 11;
  expect(job.residentSample().pids).toEqual([22]); expect(state.reads).toEqual([22]); expect(state.closes).toEqual([11, 22]);
});
test("membership query failure and truncated terminal list are unavailable", () => {
  const failed = fixture(); failed.state.queryFault = true;
  expect(() => failed.job.residentSample()).toThrow("Could not read"); expect(failed.state.opens).toEqual([]);
  const truncated = fixture(); truncated.state.assigned = 5000; truncated.state.listed = 2;
  expect(() => truncated.job.residentSample()).toThrow("truncated"); expect(truncated.state.queries).toBe(3);
});
test("invalid listed pid, unsafe handle, oversized membership and unsafe RSS reject before a false reading", () => {
  const invalid = fixture(); invalid.state.members = [0]; expect(() => invalid.job.residentSample()).toThrow("id is invalid");
  const unsafeHandle = fixture(); unsafeHandle.state.openHandle = 9007199254740992n;
  expect(() => unsafeHandle.job.residentSample()).toThrow("safe integer"); expect(unsafeHandle.state.reads).toEqual([]);
  const oversized = fixture(); oversized.state.members = Array.from({ length: 513 }, (_, i) => i + 1);
  expect(() => oversized.job.residentSample()).toThrow("sampling bound"); expect(oversized.state.opens).toEqual([]);
  const unsafeRSS = fixture(); unsafeRSS.state.memory = 9007199254740992n;
  expect(() => unsafeRSS.job.residentSample()).toThrow("working set is invalid"); expect(unsafeRSS.state.closes).toEqual([11]);
  const unsafeSum = fixture(); unsafeSum.state.memory = 9007199254740991n;
  expect(() => unsafeSum.job.residentSample()).toThrow("aggregate"); expect(unsafeSum.state.closes).toEqual([11, 22]);
});
test("closed actual job method refuses reads", () => {
  const { state, job } = fixture(); Object.assign(job, { closed: true });
  expect(() => job.residentSample()).toThrow(); expect(state.queries).toBe(0);
});
test("unsafe numeric and negative bigint handles never reach membership, memory or close FFI", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, Infinity, -Infinity, -1n, 9007199254740992n]) {
    const { state, job } = fixture(); state.openHandle = value;
    expect(() => job.residentSample()).toThrow("safe integer");
    expect(state.opens).toEqual([11]); expect(state.checks).toEqual([]);
    expect(state.reads).toEqual([]); expect(state.closes).toEqual([]);
  }
});
test("zero, null, zero bigint and NaN follow failed-open recheck and never reach later FFI", () => {
  for (const value of [0, null, 0n, NaN]) {
    const { state, job } = fixture(); state.openHandle = value;
    expect(() => job.residentSample()).toThrow("could not be opened");
    expect(state.queries).toBe(2); expect(state.checks).toEqual([]);
    expect(state.reads).toEqual([]); expect(state.closes).toEqual([]);
  }
});
test("NaN failed-open may omit only a freshly observed vanished member, never return fabricated zero", () => {
  const { state, job } = fixture(); state.members = [11]; state.openHandle = NaN;
  expect(() => job.residentSample()).toThrow("could not be opened");
  expect(state.checks).toEqual([]); expect(state.reads).toEqual([]); expect(state.closes).toEqual([]);
  state.vanished = 11;
  expect(job.residentSample()).toEqual({ pids: [], rssKiB: 0, source: "owned Windows job working set" });
  expect(state.members).toEqual([]); expect(state.queries).toBe(4);
  expect(state.checks).toEqual([]); expect(state.reads).toEqual([]); expect(state.closes).toEqual([]);
});
test("positive safe bigint observation handles convert and retain finally closure", () => {
  const { state, job } = fixture(); state.members = [11]; state.openHandle = 1011n;
  expect(job.residentSample()).toEqual({ pids: [11], rssKiB: 2, source: "owned Windows job working set" });
  expect(state.checks).toEqual([1011]); expect(state.reads).toEqual([11]); expect(state.closes).toEqual([11]);
});
test("actual assignment caller shares validation before assign or close FFI", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, Infinity, -1n, 9007199254740992n, 0, null, NaN]) {
    const { state, job } = fixture(); state.expectedRights = 0x1101; state.openHandle = value;
    expect(() => job.assign(11)).toThrow(); expect(state.opens).toEqual([11]);
    expect(state.assignments).toEqual([]); expect(state.closes).toEqual([]);
  }
  const { state, job } = fixture(); state.expectedRights = 0x1101; state.openHandle = 1011n;
  job.assign(11); expect(state.assignments).toEqual([1011]); expect(state.closes).toEqual([11]);
});
test("actual confirmed stop supplies exact postclose zero evidence", async () => {
  const evidence: StopEvidence = { rootExitCode: null, confirmed: false, handleClosed: false };
  let members = [11], rootExit: number | null = null, clock = 0, closed = false;
  const events: string[] = [];
  const stop = confirmedWindowsStop({ terminate: () => { events.push("terminate"); },
    processIds: () => { events.push(`members:${members.length}`); return [...members]; },
    close: () => { events.push("close"); closed = true; } }, { exitCode: () => rootExit }, evidence,
  () => clock, async () => { clock += 25; members = []; rootExit = 0; });
  expect(() => residentHelpers.sampleConfirmedClosedJob(evidence)).toThrow();
  await stop(); expect(closed).toBe(true);
  expect(events).toEqual(["terminate", "members:1", "members:0", "close"]);
  expect(residentHelpers.sampleConfirmedClosedJob(evidence).rssKiB).toBe(0);
  for (const patch of [{ confirmed: false }, { handleClosed: false }, { rootExitCode: null }, { members: undefined }, { members: [11] }])
    expect(() => residentHelpers.sampleConfirmedClosedJob({ ...evidence, ...patch })).toThrow("absence evidence");
});
test("stop timeout or close failure never yields admissible absence", async () => {
  for (const closeFault of [false, true]) {
    const evidence: StopEvidence = { rootExitCode: null, confirmed: false, handleClosed: false };
    let clock = 0;
    const stop = confirmedWindowsStop({ terminate() {}, processIds: () => closeFault ? [] : [11],
      close: () => { throw new Error("controlled close failure"); } }, { exitCode: () => closeFault ? 0 : null },
    evidence, () => clock, async () => { clock += 1000; });
    await expect(stop()).rejects.toThrow(); expect(() => residentHelpers.sampleConfirmedClosedJob(evidence)).toThrow();
  }
});
