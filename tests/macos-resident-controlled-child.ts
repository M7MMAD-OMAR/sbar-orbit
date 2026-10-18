import { expect, mock, test } from "bun:test";

// Only this child registry replaces the macOS kernel boundary. No kernel/provider evidence claimed.
const state = {
  pids: [11, 22], failed: false, complete: true, own: true, leader: 1000,
  starts: new Map([[11, 1100], [22, 2200]]), groups: new Map([[11, 100], [22, 100]]),
  resident: 2048, missing: 0, reads: [] as number[], lists: 0,
  duringRead: (_pid: number) => {}, finalLeaderChange: false,
  startFault: "unexpected-size" as "unexpected-size" | "invalid-seconds", startReturnBytes: 0, groupReads: [] as number[], startErrno: 3,
  stateReads: [] as number[], stateThrows: false, relistPids: undefined as number[] | undefined,
  relistComplete: undefined as boolean | undefined,
  stateResult: { returnBytes: 136, errno: 0, pid: 11, pgid: 100, status: 5, startedAtMs: 1100 } as import("../src/macos").ProcessMemberStateDiagnostic,
};
mock.module("../src/macos", () => ({
  processGroupMembers: (pgid: number) => {
    expect(pgid).toBe(100); state.lists++;
    return { pids: [...(state.lists > 1 ? state.relistPids ?? state.pids : state.pids)], complete: state.lists > 1 ? state.relistComplete ?? state.complete : state.complete, failed: state.failed };
  },
  groupIsStillOurs: (pgid: number, identity: { startedAtMs: number; executable: string }) => {
    expect(pgid).toBe(100); expect(identity.startedAtMs).toBe(1000); expect(identity.executable).toBe("/owned/bun");
    return state.own;
  },
  processStartedAtMs: (pid: number, diagnostic?: import("../src/macos").ProcessStartDiagnostic) => {
    const value = pid === 100 ? state.leader : state.starts.get(pid) ?? null;
    if (diagnostic) {
      diagnostic.errno = value === null ? state.startErrno : 0;
      diagnostic.returnBytes = value === null ? state.startReturnBytes : 136;
      diagnostic.reason = value === null ? state.startFault : "valid";
    }
    return value;
  },
  processMemberStateDiagnostic: (pid: number) => { state.stateReads.push(pid); if (state.stateThrows) throw new Error("controlled optional diagnostic fault"); return { ...state.stateResult }; },
  processGroupOf: (pid: number) => { state.groupReads.push(pid); return state.groups.get(pid) ?? null; },
  processUsage: (pid: number) => {
    state.reads.push(pid); state.duringRead(pid);
    if (state.finalLeaderChange) state.leader = 1001;
    return state.missing === pid ? null : { pid, residentBytes: state.resident, footprintBytes: 999999, cpuMachTicks: 7 };
  },
}));
const { sampleRecordedGroup } = await import("../src/owned-process-resident");
const identity = { pgid: 100, startedAtMs: 1000, executable: "/owned/bun" };
function reset() {
  state.pids = [11, 22]; state.failed = false; state.complete = true; state.own = true; state.leader = 1000;
  state.starts = new Map([[11, 1100], [22, 2200]]); state.groups = new Map([[11, 100], [22, 100]]);
  state.resident = 2048; state.missing = 0; state.reads = []; state.lists = 0;
  state.duringRead = () => {}; state.finalLeaderChange = false;
  state.startFault = "unexpected-size"; state.startReturnBytes = 0; state.groupReads = []; state.startErrno = 3;
  state.stateReads = []; state.stateThrows = false; state.relistPids = undefined; state.relistComplete = undefined;
  state.stateResult = { returnBytes: 136, errno: 0, pid: 11, pgid: 100, status: 5, startedAtMs: 1100 };
}
test("actual group sampler sums resident bytes, never footprint and only enumerated owned members", async () => {
  reset(); expect(await sampleRecordedGroup(identity, false)).toEqual({ pids: [11, 22], rssKiB: 4,
    source: "owned macOS process group resident memory" }); expect(state.reads).toEqual([11, 22]);
});
test("invalid recorded group identity rejects before kernel observation", async () => {
  for (const patch of [{ pgid: 1 }, { pgid: 1.5 }, { startedAtMs: NaN }, { startedAtMs: 0 }, { executable: "" }]) {
    reset(); await expect(sampleRecordedGroup({ ...identity, ...patch }, true)).rejects.toThrow("identity is invalid");
    expect(state.lists).toBe(0); expect(state.reads).toEqual([]);
  }
});
test("wrong leader executable/identity or exact changed start time fails before resident read", async () => {
  reset(); state.own = false; await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("no longer verifiable");
  expect(state.reads).toEqual([]);
  reset(); state.leader = 1001; await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("no longer verifiable");
  expect(state.reads).toEqual([]);
});
test("unavailable, truncated and oversized group enumeration reject", async () => {
  for (const fault of ["failed", "truncated", "oversized"]) {
    reset(); if (fault === "failed") state.failed = true;
    if (fault === "truncated") state.complete = false;
    if (fault === "oversized") state.pids = Array.from({ length: 513 }, (_, i) => i + 1);
    await expect(sampleRecordedGroup(identity, false)).rejects.toThrow(); expect(state.reads).toEqual([]);
  }
});
test("still-listed member with missing start or wrong group rejects before reading it", async () => {
  reset(); state.starts.delete(11); await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("identity is unreadable");
  expect(state.reads).toEqual([]);
  reset(); state.groups.set(11, 999); await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("identity is unreadable");
  expect(state.reads).toEqual([]);
});
test("still-listed unreadable resident memory rejects", async () => {
  reset(); state.missing = 11; await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("resident memory or identity");
});
test("member start identity change or group change during resident read rejects reused pid", async () => {
  for (const kind of ["start", "group"]) {
    reset(); state.duringRead = pid => { if (kind === "start") state.starts.set(pid, 9999); else state.groups.set(pid, 999); };
    await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("resident memory or identity");
  }
});
test("vanished member omission requires a fresh complete membership query", async () => {
  reset(); state.missing = 11; state.duringRead = pid => {
    if (pid === 11) { state.pids = [22]; state.starts.delete(11); state.groups.delete(11); }
  };
  expect((await sampleRecordedGroup(identity, false)).pids).toEqual([22]); expect(state.lists).toBe(2);
  reset(); state.missing = 11; state.duringRead = () => { state.complete = false; };
  await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("unavailable or truncated");
});
test("negative, noninteger, NaN and unsafe resident or aggregate bytes reject", async () => {
  for (const value of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    reset(); state.resident = value; await expect(sampleRecordedGroup(identity, false)).rejects.toThrow();
  }
});
test("group leader identity must remain exact through the end of the sample", async () => {
  reset(); state.finalLeaderChange = true; await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("changed during sampling");
});
test("poststop zero requires exited supervisor and a fresh complete kernel-empty group", async () => {
  reset(); state.pids = []; expect((await sampleRecordedGroup(identity, true)).rssKiB).toBe(0);
  expect(state.lists).toBe(1); expect(state.reads).toEqual([]);
  await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("unexpectedly empty");
  reset(); state.own = false; await expect(sampleRecordedGroup(identity, true)).rejects.toThrow("no longer verifiable");
  reset(); state.pids = []; state.failed = true; await expect(sampleRecordedGroup(identity, true)).rejects.toThrow();
  reset(); state.pids = []; state.complete = false; await expect(sampleRecordedGroup(identity, true)).rejects.toThrow();
});

// These are controlled diagnostic distinctions, not native failure measurements.
test("unreadable start diagnostics retain the existing native result without an extra group read", async () => {
  for (const [reason, bytes] of [["unexpected-size", 0], ["unexpected-size", 120], ["invalid-seconds", 136]] as const) {
    reset(); state.starts.delete(11); state.startFault = reason; state.startReturnBytes = bytes;
    let error: unknown;
    try { await sampleRecordedGroup(identity, false); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("memberPid=11, ownedPgid=100, start=unknown");
    expect(message).toContain(`startReason=${reason}, startReturnBytes=${bytes}, group=not-read`);
    expect(message).toContain("relist=complete-present, relistCount=2");
    expect(state.groupReads).toEqual([]); expect(state.reads).toEqual([]); expect(state.lists).toBe(2);
  }
});
test("unreadable group diagnostics distinguish null from mismatch using one existing group read", async () => {
  for (const group of [null, 999]) {
    reset(); if (group === null) state.groups.delete(11); else state.groups.set(11, group);
    let error: unknown;
    try { await sampleRecordedGroup(identity, false); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("start=valid, startReason=valid, startReturnBytes=136");
    expect(message).toContain(`group=${group === null ? "unknown" : group}, relist=complete-present`);
    expect(state.groupReads).toEqual([11]); expect(state.reads).toEqual([]); expect(state.lists).toBe(2);
  }
});

// A later state observation is diagnostic only, including zombie and PID reuse outcomes.
test("later state and errno never admit unknown original start identity", async () => {
  for (const result of [
    { returnBytes: 136, errno: 0, pid: 11, pgid: 100, status: 5, startedAtMs: 1100 },
    { returnBytes: 136, errno: 0, pid: 11, pgid: 999, status: 2, startedAtMs: 9999 },
    { returnBytes: 0, errno: 3, pid: null, pgid: null, status: null, startedAtMs: null },
    { returnBytes: 0, errno: 1, pid: null, pgid: null, status: null, startedAtMs: null },
  ]) {
    reset(); state.starts.delete(11); state.stateResult = result;
    let error: unknown;
    try { await sampleRecordedGroup(identity, false); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain("startErrno=3");
    expect(error instanceof Error ? error.message : "").toContain(`stateReturnBytes=${result.returnBytes}, stateErrno=${result.errno}`);
    expect(state.stateReads).toEqual([11]); expect(state.reads).toEqual([]);
  }
});
test("state diagnostic never queries a member absent from a fresh complete relist", async () => {
  reset(); state.starts.delete(11); state.relistPids = [22];
  expect((await sampleRecordedGroup(identity, false)).pids).toEqual([22]);
  expect(state.stateReads).toEqual([]); expect(state.reads).toEqual([22]);
});
test("incomplete relist fails before optional member state diagnostic", async () => {
  reset(); state.starts.delete(11); state.relistComplete = false;
  await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("unavailable or truncated");
  expect(state.stateReads).toEqual([]); expect(state.reads).toEqual([]);
});
test("known wrong member group rejects without an optional state lookup", async () => {
  reset(); state.groups.set(11, 999);
  await expect(sampleRecordedGroup(identity, false)).rejects.toThrow("identity is unreadable");
  expect(state.stateReads).toEqual([]); expect(state.reads).toEqual([]);
});

test("optional state lookup failure preserves original unavailable error and never reads RSS", async () => {
  reset(); state.starts.delete(11); state.stateThrows = true;
  let error: unknown;
  try { await sampleRecordedGroup(identity, false); } catch (value) { error = value; }
  expect(error).toMatchObject({ code: "RESOURCE_STATUS_UNAVAILABLE" });
  expect(error instanceof Error ? error.message : "").toContain("Owned browser group member identity is unreadable");
  expect(error instanceof Error ? error.message : "").toContain("stateObservation=unavailable, stateReturnBytes=not-measured");
  expect(error instanceof Error ? error.message : "").not.toContain("controlled optional diagnostic fault");
  expect(state.stateReads).toEqual([11]); expect(state.groupReads).toEqual([]);
  expect(state.reads).toEqual([]); expect(state.lists).toBe(2);
});
