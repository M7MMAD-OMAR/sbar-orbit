import { expect, test } from "bun:test";
import { admitDebugRecord, continuation, duplicateOwner, requireCoverage, debugDuplicateRights, creatorRootRights, observationRights, rootHandoffOwner, helperDeathAuthority, abortRootSafety, transferBarrier, validateTransferSeal, type DebugRecord } from "./windows-debug-contract";
import { descendantsFromTable } from "../src/process-tree";

const root = { creationTicks: "134357846424501338", image: "bun.exe" };
const record: DebugRecord = { sequence: 0, pid: 3600, handle: 128, identity: root, root,
  session: "private", jobMember: true, immediateParent: "not measured", provenance: "creator-debug-chain" };

test("debug admission rejects the actual older PING identity without a PID opener", () => {
  // This unchanged old numeric ancestry helper still admits the contradictory row.
  expect(descendantsFromTable(["3660 10224", "3596 3660"], 10224)).toContain(3596);
  expect(() => admitDebugRecord({ ...record, identity: { creationTicks: "134357846300522246", image: "PING.EXE" } }, "private", root)).toThrow();
  expect(() => admitDebugRecord({ ...record, session: "unrelated" }, "private", root)).toThrow();
  expect(() => admitDebugRecord({ ...record, jobMember: false }, "private", root)).toThrow();
});
test("plausible birth order cannot substitute for session or job ownership", () => {
  const newer = { ...record, identity: { ...root, creationTicks: "134357846462281851" } };
  expect(() => admitDebugRecord({ ...newer, jobMember: false }, "private", root)).toThrow();
  expect(admitDebugRecord(newer, "private", root).immediateParent).toBe("not measured");
});
test("debug continuation passes genuine faults to normal exception dispatch", () => {
  expect(continuation(1, 0x80000003, true, true)).toBe(0x00010002);
  expect(continuation(1, 0x80000003, false, true)).toBe(0x80010001);
  expect(continuation(1, 0xc0000005, true, false)).toBe(0x80010001);
  expect(continuation(1, 0xc0000005, false, false)).toBe(0x80010001);
  expect(continuation(5, 0, false, false)).toBe(0x00010002);
});
test("failed duplicate closure retains exact ownership and never double closes", () => {
  const calls: number[] = []; let fail = true;
  const owner = duplicateOwner(handle => { calls.push(handle); if (handle === 64 && fail) throw new Error("CloseHandle failure"); });
  owner.add(64); owner.add(128); expect(() => owner.close()).toThrow();
  expect(owner.outstanding()).toEqual([64]); fail = false; owner.close(); owner.close();
  expect(calls).toEqual([64, 128, 64]);
});
test("exited acquired handles cannot close a missing or split stream", () => {
  const complete = { chainSplit: false, missingAcknowledgement: false, deadlineExpired: false, allExited: true };
  for (const key of ["chainSplit", "missingAcknowledgement", "deadlineExpired"] as const)
    expect(() => requireCoverage({ ...complete, [key]: true })).toThrow();
  expect(() => requireCoverage({ ...complete, allExited: false })).toThrow();
});

test("creator root assignment rights do not widen descendant observations", () => {
  expect(debugDuplicateRights("creator-root")).toBe(0x00101101);
  expect(debugDuplicateRights("observation")).toBe(0x00101000);
  expect(creatorRootRights & 0x101).toBe(0x101);
  expect(observationRights & 0x101).toBe(0);
});
test("identity failure retains the exact minimal root handoff before helper death", () => {
  const owner = duplicateOwner(() => {}), handoff = rootHandoffOwner("private", value => owner.add(value));
  const header = { session: "private", role: "creator-root" as const, handle: 64, pid: 3600, rights: creatorRootRights, killPolicyFalse: true };
  let oldRootHandle: number | undefined;
  const failingIdentity = () => { throw new Error("QueryFullProcessImageNameW failure"); };
  expect(() => { failingIdentity(); oldRootHandle = header.handle; }).toThrow();
  expect(oldRootHandle).toBeUndefined();
  handoff.adopt(header);
  expect(failingIdentity).toThrow();
  expect(owner.outstanding()).toEqual([64]);
  expect(helperDeathAuthority(handoff.held() !== undefined, false)).toBe(true);
  expect(() => handoff.adopt({ ...header, handle: 128 })).toThrow();
});
test("missing partial handoff forbids helper-first termination and remains unknown", () => {
  expect(helperDeathAuthority(false, false)).toBe(false);
  expect(abortRootSafety(true, false, false)).toBe("unknown");
  expect(() => rootHandoffOwner("private", () => {}).adopt({ session: "other", role: "creator-root", handle: 64,
    pid: 3600, rights: observationRights, killPolicyFalse: true })).toThrow();
});
test("cooperative abort distinguishes unstarted creation from exact exit or adopted root", () => {
  expect(abortRootSafety(false, false, false)).toBe("root creation never started");
  expect(abortRootSafety(true, true, false)).toBe("exact creator root exited");
  expect(abortRootSafety(true, false, true)).toBe("controller owns exact root");
  expect(helperDeathAuthority(false, true)).toBe(true);
});

test("missing seal cannot authorize helper death despite two observed rows", () => {
  const rows = [{ sequence: 0, handle: 64, pid: 3600 }, { sequence: 1, handle: 128, pid: 3601 }];
  expect(() => validateTransferSeal({ session: "private", nextSequence: 2, noFurtherTransfers: false as true, inventory: rows }, "private", rows)).toThrow();
  expect(() => validateTransferSeal({ session: "other", nextSequence: 2, noFurtherTransfers: true, inventory: rows }, "private", rows)).toThrow();
});
test("same-thread seal refuses inflight delivery until its exact acknowledgement", () => {
  const barrier = transferBarrier("private");
  barrier.begin(); barrier.delivered({ sequence: 0, handle: 64, pid: 3600 }); barrier.acknowledged();
  barrier.begin(); expect(() => barrier.seal("private")).toThrow();
  barrier.delivered({ sequence: 1, handle: 128, pid: 3601 }); expect(() => barrier.seal("private")).toThrow();
  barrier.acknowledged(); const seal = barrier.seal("private");
  expect(validateTransferSeal(seal, "private", seal.inventory).nextSequence).toBe(2);
  expect(() => validateTransferSeal(seal, "private", [{ ...seal.inventory[0], sequence: 0, handle: 256, pid: 3600 },
    { sequence: 1, handle: 128, pid: 3601 }])).toThrow();
});
test("third generation is rejected before duplication both before and after seal", () => {
  const barrier = transferBarrier("private"); let duplicateCalls = 0;
  for (const row of [{ sequence: 0, handle: 64, pid: 3600 }, { sequence: 1, handle: 128, pid: 3601 }]) {
    barrier.begin(); duplicateCalls++; barrier.delivered(row); barrier.acknowledged();
  }
  expect(() => { barrier.begin(); duplicateCalls++; }).toThrow();
  barrier.seal("private"); expect(() => { barrier.begin(); duplicateCalls++; }).toThrow();
  expect(duplicateCalls).toBe(2);
});
