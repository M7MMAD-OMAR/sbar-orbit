import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitInstalledStartup, installedStartupProjection, InstalledStartupWriter,
  prepareInstalledStartup, taskEnvironmentMatches, observeInstalledStop, installedTraceRetentionComplete, installedStartupAttribution, installedExecutableIdentity, installedProducerBinding } from "../src/installed-startup-diagnostic";
import { brokerTaskXml } from "../src/windows-autostart";
import { needsSymlink } from "./platform-support";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orbit installed acceptance "))); roots.push(root);
  const source = join(root, "package"), prefix = join(root, "prefix");
  await mkdir(source); await mkdir(prefix);
  const runtime = join(source, "owned-runtime.ts"); await writeFile(runtime, "owned fixture bytes");
  const env = { GITHUB_ACTIONS: "true", ...await prepareInstalledStartup(root, source, prefix) };
  return { root, source, prefix, runtime, env, context: { platform: "win32", runtime } };
}

test("installed trace admits only a canonical bound disposable fixture", async () => {
  const f = await fixture(); expect(admitInstalledStartup(f.env, f.context)).toBe(f.root);
  expect(admitInstalledStartup({}, f.context)).toBeUndefined();
  expect(admitInstalledStartup({ ...f.env, GITHUB_ACTIONS: "false" }, f.context)).toBeUndefined();
  expect(admitInstalledStartup(f.env, { ...f.context, platform: "linux" })).toBeUndefined();
  expect(admitInstalledStartup({ ...f.env, ORBIT_TEST_NATIVE: "1" }, f.context)).toBeUndefined();
});
test("installed trace refuses modified binding and foreign runtime", async () => {
  const f = await fixture();
  expect(admitInstalledStartup({ ...f.env, ORBIT_TEST_INSTALLED_STARTUP_BINDING: "0".repeat(64) }, f.context)).toBeUndefined();
  expect(admitInstalledStartup(f.env, { ...f.context, runtime: import.meta.path })).toBeUndefined();
  await writeFile(join(f.root, "startup-admission.json"), "{}");
  expect(admitInstalledStartup(f.env, f.context)).toBeUndefined();
});
test("installed trace absence cannot be admitted as complete evidence", async () => {
  const f = await fixture(); await rm(join(f.root, "startup-trace-status.json"));
  expect(admitInstalledStartup(f.env, f.context)).toBeUndefined();
});
needsSymlink("owned startup sink must reject a redirected file")("installed trace rejects a symlink sink", async () => {
  const f = await fixture(); const sink = join(f.root, "startup-trace.jsonl");
  await rm(sink); await symlink(f.runtime, sink, "file");
  expect(admitInstalledStartup(f.env, f.context)).toBeUndefined();
});
test("installed preparation refuses a foreign prefix before creating sinks", async () => {
  const f = await fixture();
  await expect(prepareInstalledStartup(f.root, f.source, tmpdir())).rejects.toThrow("Fixture ownership mismatch");
});
test("registered task matching requires exact actual action and environment", async () => {
  const f = await fixture(), launcher = join(f.prefix, "bin/sbar-orbit.cmd");
  const env = { ...f.env, ORBIT_TEST_NATIVE: "0" };
  const xml = brokerTaskXml(launcher, "S-1-5-21-123", env);
  expect(taskEnvironmentMatches(xml, env, launcher)).toBe(true);
  expect(taskEnvironmentMatches(brokerTaskXml(launcher, "S-1-5-21-123"), env, launcher)).toBe(false);
  expect(taskEnvironmentMatches(xml, env, launcher + ".foreign")).toBe(false);
  expect(taskEnvironmentMatches(xml.replace("serve --managed-socket", "serve --managed-socket extra"), env, launcher)).toBe(false);
});
test("typed trace projection excludes private stderr endpoints paths and titles", () => {
  const projected = installedStartupProjection({ phase: "stderr", rootPid: 42, stderrBytes: 12,
    stderrSha256: "a".repeat(64), stderrCategory: "other stderr", stderr: "secret-token",
    endpoint: "ws://private.example/token", path: "/home/example/private-profile", title: "personal title",
    accounting: { activeProcesses: 2, raw: "secret-token" }, cleanup: { confirmed: false, members: [42], raw: "private" } });
  const output = JSON.stringify(projected);
  expect(output).not.toContain("secret-token"); expect(output).not.toContain("private"); expect(output).not.toContain("personal");
  expect(projected.stderrSha256).toBe("a".repeat(64)); expect(projected.stderrBytes).toBe(12);
  expect(projected.accounting).toEqual({ activeProcesses: 2 });
});
test("bounded trace retains every admitted record then reports explicit overflow", () => {
  const rows: string[] = [], statuses: string[] = [];
  const writer = new InstalledStartupWriter(row => rows.push(row), row => statuses.push(row), { records: 2, bytes: 10000 });
  writer.emit({ phase: "assigned", rootPid: 42 }); writer.emit({ phase: "poll", rootPid: 42 }); writer.emit({ phase: "stop confirmed", rootPid: 42 });
  expect(rows.length).toBe(2); expect(JSON.parse(rows[0] ?? "null").installedStartup.phase).toBe("assigned");
  expect(JSON.parse(rows[1] ?? "null").installedStartup.phase).toBe("poll");
  expect(writer.status).toMatchObject({ records: 2, overflow: true, droppedRecords: 1, writeFailed: false });
  expect(JSON.parse(statuses.at(-1) ?? "null").overflow).toBe(true);
  expect(writer.status.collectionElapsedMs).toBeGreaterThanOrEqual(0);
});
test("failed trace observer preserves actual returned value and original error identity", () => {
  const writer = new InstalledStartupWriter(() => { throw new Error("owned sink failed"); }, () => { throw new Error("owned status failed"); });
  const original = new Error("operation failed"), result = {};
  const operation = (fail: boolean) => { try { if (fail) throw original; return result; } finally { writer.emit({ phase: "before stop" }); } };
  expect(operation(false)).toBe(result);
  let caught: unknown; try { operation(true); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(writer.status.writeFailed).toBe(true); expect(writer.status.records).toBe(0);
});

test("installed stop observer keeps the exact owned promise and rejection", async () => {
  const phases: string[] = [], success = Promise.resolve({}), original = new Error("actual stop rejected");
  const fulfilled = observeInstalledStop(() => success, phase => { phases.push(phase); throw new Error("observer failed"); });
  expect(fulfilled()).toBe(success); await success; await Promise.resolve();
  expect(phases).toEqual(["before stop", "stop confirmed"]);
  const rejected = Promise.reject(original);
  const failure = observeInstalledStop(() => rejected, phase => { phases.push(phase); });
  expect(failure()).toBe(rejected);
  let caught: unknown; try { await rejected; } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(phases.at(-1)).toBe("stop incomplete");
});

test("rejected or truncated membership invalidates actual shared retention gate", () => {
  const valid = [7, 9], capped = Array.from({ length: 512 }, (_, i) => i + 1);
  expect(installedStartupProjection({ members: valid }).members).toEqual(valid);
  expect(installedStartupProjection({ cleanup: { members: capped } }).cleanup).toMatchObject({ members: capped, membershipProjection: { invalid: false } });
  for (const value of [{ members: [7, "8", NaN, -1, null, 9] }, { cleanup: { members: [...capped, 513] } }, { members: "not a PID array" }]) {
    const lines: string[] = [], writer = new InstalledStartupWriter(line => lines.push(line), () => {});
    writer.emit(value);
    const row = JSON.parse(lines[0] ?? "null").installedStartup;
    expect(writer.status.invalidMembershipRecords).toBe(1);
    expect(installedTraceRetentionComplete([row], writer.status, writer.status.bytes)).toBe(false);
    // A shortened list cannot become valid merely because a retention counter is missing or altered.
    expect(installedTraceRetentionComplete([row], { ...writer.status, invalidMembershipRecords: 0 }, writer.status.bytes)).toBe(false);
  }
  const malformed = installedStartupProjection({ members: [7, "8", 9] });
  expect(malformed.members).toEqual([7, 9]);
  expect(malformed.membershipProjection).toMatchObject({ inputRows: 3, retainedRows: 2, rejectedRows: 1, truncatedRows: 0, invalid: true });
  const overCap = installedStartupProjection({ members: [...capped, 513] });
  expect(overCap.members).toEqual(capped);
  expect(overCap.membershipProjection).toMatchObject({ inputRows: 513, retainedRows: 512, rejectedRows: 0, truncatedRows: 1, invalid: true });
});

test("runtime-only retention is genuine partial metadata, never startup or cleanup readiness", () => {
  const lines: string[] = [], writer = new InstalledStartupWriter(line => lines.push(line), () => {});
  writer.emit({ phase: "runtime", browserSha256: "a".repeat(64), bunSha256: "b".repeat(64), runtimeSha256: "c".repeat(64) });
  const rows = lines.map(line => JSON.parse(line).installedStartup);
  expect(installedTraceRetentionComplete(rows, writer.status, writer.status.bytes)).toBe(true);
  expect(installedStartupAttribution(rows)).toEqual({ startupAttributionReady: false, cleanupAttemptObserved: false, cleanupAttributionReady: false, cleanupConfirmed: false });
  writer.emit({ phase: "assigned", rootPid: 42 }); writer.emit({ phase: "stop confirmed", rootPid: 42 });
  const incomplete = lines.map(line => JSON.parse(line).installedStartup);
  expect(installedTraceRetentionComplete(incomplete, writer.status, writer.status.bytes)).toBe(true);
  expect(installedStartupAttribution(incomplete)).toEqual({ startupAttributionReady: false, cleanupAttemptObserved: false, cleanupAttributionReady: false, cleanupConfirmed: false });
});

// These protocol controls use the shared writer, never a Windows process or provider.
function startupProtocolRows() {
  const rootPid = 42;
  return [
    { phase: "runtime", browserSha256: "a".repeat(64), bunSha256: "b".repeat(64), runtimeSha256: "c".repeat(64) },
    { phase: "assigned", rootPid, members: [rootPid], budget: { memoryBytes: 2147483648, cpuCycleSharePercent: 100, activeProcesses: 512 },
      accounting: { userMs: 0, kernelMs: 0, activeProcesses: 1, peakJobMemoryBytes: 1024 } },
    { phase: "poll", rootPid, endpointState: "published", elapsedMs: 10, waitMs: 10, polls: 1, maxPollGapMs: 10 },
    { phase: "before stop", origin: "owned stop", stopAttempt: 1, rootPid },
    { phase: "stop confirmed", origin: "owned stop", stopAttempt: 1, rootPid, cleanup: { members: [], confirmed: true, handleClosed: true, rootExitCode: 0 } },
  ];
}
function evaluateProtocol(values: unknown[]) {
  const lines: string[] = [], writer = new InstalledStartupWriter(line => lines.push(line), () => {});
  for (const value of values) writer.emit(value);
  const rows = lines.map(line => JSON.parse(line).installedStartup);
  expect(installedTraceRetentionComplete(rows, writer.status, writer.status.bytes)).toBe(true);
  return installedStartupAttribution(rows);
}
test("ordered assigned endpoint and latest confirmed cleanup provide protocol readiness", () => {
  expect(evaluateProtocol(startupProtocolRows())).toEqual({ startupAttributionReady: true, cleanupAttemptObserved: true, cleanupAttributionReady: true, cleanupConfirmed: true });
});
test("missing endpoint preserves cleanup proof but cannot establish startup readiness", () => {
  expect(evaluateProtocol(startupProtocolRows().filter(row => row.phase !== "poll"))).toEqual({ startupAttributionReady: false, cleanupAttemptObserved: true, cleanupAttributionReady: true, cleanupConfirmed: true });
});
test("query failure and unknown or conflicting process roots cannot establish attribution", () => {
  const values = startupProtocolRows();
  const queryFailed = values.map(row => row.phase === "stop confirmed" ? { ...row, membershipError: "query failed" } : row);
  expect(evaluateProtocol(queryFailed).cleanupAttributionReady).toBe(false);
  expect(evaluateProtocol(queryFailed).cleanupConfirmed).toBe(false);
  for (const altered of [
    [...values, { phase: "stderr", rootPid: 99 }],
    values.map(row => row.phase === "stop confirmed" ? { ...row, rootPid: 99 } : row),
    [...values, { ...values[1], phase: "assigned" }],
  ]) expect(evaluateProtocol(altered)).toEqual({ startupAttributionReady: false, cleanupAttemptObserved: false, cleanupAttributionReady: false, cleanupConfirmed: false });
});
test("poll or stop preceding assignment and overlapping attempts refuse phase attribution", () => {
  const values = startupProtocolRows();
  for (const order of [[0, 2, 1, 3, 4], [0, 3, 1, 2, 4], [1, 0, 2, 3, 4], [0, 1, 2, 3, 3, 4]]) {
    const result = evaluateProtocol(order.map(index => values[index]));
    expect(result.startupAttributionReady).toBe(false);
    expect(result.cleanupAttributionReady).toBe(false);
    expect(result.cleanupConfirmed).toBe(false);
  }
  const overlapping = evaluateProtocol([values[0], values[1], values[2], values[3],
    { ...values[3], stopAttempt: 2 }, { ...values[4], stopAttempt: 2 }, values[4]]);
  expect(overlapping.cleanupAttributionReady).toBe(false); expect(overlapping.cleanupConfirmed).toBe(false);
});
test("latest incomplete or pending stop cannot reuse an earlier confirmed cleanup", () => {
  const values = startupProtocolRows(), before = { phase: "before stop", origin: "owned stop", stopAttempt: 2, rootPid: 42 };
  const pending = evaluateProtocol([...values, before]);
  expect(pending.cleanupAttemptObserved).toBe(true); expect(pending.cleanupAttributionReady).toBe(false); expect(pending.cleanupConfirmed).toBe(false);
  const incomplete = evaluateProtocol([...values, before, { phase: "stop incomplete", origin: "owned stop", stopAttempt: 2, rootPid: 42, cleanup: { members: [42], confirmed: false, handleClosed: false, rootExitCode: null } }]);
  expect(incomplete.cleanupAttributionReady).toBe(true); expect(incomplete.cleanupConfirmed).toBe(false);
  const failedQuery = evaluateProtocol([...values, before, { phase: "stop incomplete", origin: "owned stop", stopAttempt: 2, rootPid: 42, accountingError: "query failed", cleanup: { members: [42], confirmed: false, handleClosed: false, rootExitCode: null } }]);
  expect(failedQuery.cleanupAttributionReady).toBe(false); expect(failedQuery.cleanupConfirmed).toBe(false);
});

test("endpoint failure dual-origin snapshots retain actual stop pairing without duplicate attempts", () => {
  const values = startupProtocolRows();
  const snapshot = { phase: "before stop", origin: "startup snapshot", rootPid: 42, endpointState: "missing", elapsedMs: 15000, waitMs: 15000, polls: 600, maxPollGapMs: 30 };
  const after = { phase: "stop confirmed", origin: "startup snapshot", rootPid: 42, cleanup: { members: [], confirmed: true, handleClosed: true, rootExitCode: 1 } };
  const observed = evaluateProtocol([values[0], values[1], snapshot, values[3], values[4], after]);
  expect(observed).toEqual({ startupAttributionReady: true, cleanupAttemptObserved: true, cleanupAttributionReady: true, cleanupConfirmed: true });
  // A later snapshot cannot convert a genuinely incomplete owned stop into confirmation.
  const incomplete = evaluateProtocol([values[0], values[1], snapshot, values[3],
    { phase: "stop incomplete", origin: "owned stop", stopAttempt: 1, rootPid: 42, cleanup: { members: [42], confirmed: false, handleClosed: false, rootExitCode: null } }, after]);
  expect(incomplete.cleanupAttributionReady).toBe(true); expect(incomplete.cleanupConfirmed).toBe(false);
});
test("actual stop observer emits stable distinct attempt identities and preserves promises", async () => {
  const rows: unknown[] = [], settled = Promise.resolve({});
  const observed = observeInstalledStop(() => settled, (phase, stopAttempt) => rows.push({ phase, origin: "owned stop", stopAttempt }));
  expect(observed()).toBe(settled); await settled; await Promise.resolve();
  expect(observed()).toBe(settled); await settled; await Promise.resolve();
  expect(rows).toEqual([{ phase: "before stop", origin: "owned stop", stopAttempt: 1 }, { phase: "stop confirmed", origin: "owned stop", stopAttempt: 1 },
    { phase: "before stop", origin: "owned stop", stopAttempt: 2 }, { phase: "stop confirmed", origin: "owned stop", stopAttempt: 2 }]);
});

const protocolIdentity = { complete: true, readFailed: false, typeFailed: false, overflow: false, changed: false, closeFailed: false, slow: false,
  sha256: "d".repeat(64), canonicalSha256: "e".repeat(64), bytes: 4, chunks: 1, elapsedMs: 1, maxBytes: 268435456, maxChunks: 256, maxElapsedMs: 1000 };
function producerProtocolRows() {
  return startupProtocolRows().map(row => ({ ...row, launchId: "f".repeat(64), producerPid: 17,
    ...(row.phase === "runtime" || row.phase === "stop confirmed" ? { producerExecutable: protocolIdentity } : {}) }));
}
function projectProducer(values: unknown[]) {
  const lines: string[] = [], writer = new InstalledStartupWriter(line => lines.push(line), () => {});
  for (const row of values) writer.emit(row);
  const records = lines.map(line => JSON.parse(line).installedStartup);
  expect(installedTraceRetentionComplete(records, writer.status, writer.status.bytes)).toBe(true);
  return installedProducerBinding(records);
}
test("selected producer binding accepts stable actual-schema Bun identity independently of collector", () => {
  const collectorBunSha256 = "a".repeat(64);
  expect(protocolIdentity.sha256).not.toBe(collectorBunSha256);
  expect(projectProducer(producerProtocolRows())).toEqual({ producerIdentityBound: true, producerIdentityChanged: false });
});
test("changed selected producer file or canonical identity invalidates its own binding", () => {
  for (const identity of [{ ...protocolIdentity, sha256: "a".repeat(64) }, { ...protocolIdentity, canonicalSha256: "a".repeat(64) },
    { ...protocolIdentity, changed: true, complete: false }]) {
    const rows = producerProtocolRows().map(row => row.phase === "stop confirmed" ? { ...row, producerExecutable: identity } : row);
    expect(projectProducer(rows)).toEqual({ producerIdentityBound: false, producerIdentityChanged: true });
  }
});
test("missing failed overflowing or slow selected producer after proof remains unbound", () => {
  for (const identity of [undefined, { ...protocolIdentity, readFailed: true, complete: false }, { ...protocolIdentity, closeFailed: true, complete: false },
    { ...protocolIdentity, overflow: true, complete: false }, { ...protocolIdentity, elapsedMs: 1001, slow: true, complete: false }]) {
    const rows = producerProtocolRows().map(row => row.phase === "stop confirmed" ? { ...row, producerExecutable: identity } : row);
    expect(projectProducer(rows).producerIdentityBound).toBe(false);
  }
});
test("producer launch and owned root identity must match every retained process row", () => {
  const rows = producerProtocolRows();
  for (const altered of [
    rows.map(row => row.phase === "stop confirmed" ? { ...row, producerPid: 18 } : row),
    rows.map(row => row.phase === "poll" ? { ...row, launchId: "a".repeat(64) } : row),
    rows.map(row => row.phase === "stop confirmed" ? { ...row, rootPid: 99 } : row),
    rows.filter(row => row.phase !== "runtime"),
    [...rows, { phase: "before stop", origin: "owned stop", stopAttempt: 2, launchId: "f".repeat(64), producerPid: 17, rootPid: 42 }],
  ]) expect(projectProducer(altered).producerIdentityBound).toBe(false);
});
test("bounded executable identity hashes owned file with closed handle and no path disclosure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orbit installed acceptance "))); roots.push(root);
  const executable = join(root, "owned-executable.bin"); await writeFile(executable, "four");
  const identity = installedExecutableIdentity(executable);
  expect(identity).toMatchObject({ complete: true, bytes: 4, chunks: 1, readFailed: false, overflow: false, closeFailed: false });
  expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/); expect(identity.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
  const retained = JSON.stringify(installedStartupProjection({ producerExecutable: { ...identity, rawPath: executable, rawError: "private endpoint and token" }, producerPid: 17, launchId: "f".repeat(64) }));
  expect(retained).not.toContain(executable); expect(retained).not.toContain("private endpoint and token");
  // Removing the file after hashing must not be prevented by a leaked Windows handle.
  await rm(executable); expect(installedExecutableIdentity(executable)).toMatchObject({ complete: false, readFailed: true });
});
test("bounded executable hash read absence byte or chunk overflow and observed overhead invalidate identity", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orbit installed acceptance "))); roots.push(root);
  const executable = join(root, "owned-executable.bin"); await writeFile(executable, "four");
  expect(installedExecutableIdentity(join(root, "absent.bin"))).toMatchObject({ complete: false, readFailed: true });
  expect(installedExecutableIdentity(executable, { bytes: 3, chunks: 256, elapsedMs: 1000 })).toMatchObject({ complete: false, overflow: true, closeFailed: false });
  expect(installedExecutableIdentity(executable, { bytes: 268435456, chunks: 0, elapsedMs: 1000 })).toMatchObject({ complete: false, overflow: true, closeFailed: false });
  let observedAt = 0;
  expect(installedExecutableIdentity(executable, undefined, () => { const now = observedAt; observedAt += 1001; return now; }))
    .toMatchObject({ complete: false, slow: true, elapsedMs: 1001, closeFailed: false });
});
