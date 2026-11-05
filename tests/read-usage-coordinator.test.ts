import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { runInNewContext } from "node:vm";
import { ReadUsageCoordinator, ReadUsageError, type ReadUsageRecord } from "../src/read-usage-coordinator";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const outcome = <T>(promise: Promise<T>) => promise.then(() => "ok", (error: unknown) => error instanceof ReadUsageError ? error.code : "unexpected");

type TimerArguments = Parameters<typeof globalThis.setTimeout>;
type TimerResult = ReturnType<typeof globalThis.setTimeout>;
function typedTimer(body: (args: TimerArguments) => TimerResult): typeof globalThis.setTimeout {
  const implementation = (...args: TimerArguments): TimerResult => body(args);
  return Object.assign(implementation, { __promisify__: globalThis.setTimeout.__promisify__ }) as typeof globalThis.setTimeout;
}

test("protected identities start disabled and on requires a durable acknowledgement", async () => {
  const authority = {}, a = {}, b = {}, gate = deferred<void>();
  const writes: { conversation: object; record: ReadUsageRecord }[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(conversation, record) { writes.push({ conversation, record }); await gate.promise; },
  } });
  expect(() => coordinator.register({}, a)).toThrow(ReadUsageError);
  coordinator.register(authority, a);
  coordinator.register(authority, b);
  const initial = await coordinator.usageVersion(a);
  expect(initial).toEqual({ conversation: a, epoch: 1, enabled: false });
  expect(coordinator.usageCurrent(a, initial.epoch)).toBe(false);
  expect(coordinator.usageCurrent({}, initial.epoch)).toBe(false);
  const pending = coordinator.on(authority, a);
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.conversation).toBe(a);
  expect(writes[0]?.record.instance).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.isFrozen(writes[0]?.record)).toBe(true);
  expect((await coordinator.usageVersion(a)).enabled).toBe(false);
  gate.resolve(); await pending;
  const active = await coordinator.usageVersion(a);
  expect(active.enabled).toBe(true);
  expect(coordinator.usageCurrent(a, active.epoch)).toBe(true);
  expect((await coordinator.usageVersion(b)).enabled).toBe(false);
  expect(() => coordinator.off({}, a)).toThrow(ReadUsageError);
  await expect(coordinator.usageVersion({})).rejects.toBeInstanceOf(ReadUsageError);
});

test("off fences immediately, waits for durable commit, and repeated off advances", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>();
  let pause = false;
  const records: ReadUsageRecord[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(_conversation, record) { records.push(record); if (pause) await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  await coordinator.on(authority, conversation);
  const previous = await coordinator.usageVersion(conversation);
  pause = true;
  const off = coordinator.off(authority, conversation);
  expect(coordinator.usageCurrent(conversation, previous.epoch)).toBe(false);
  const disabled = await coordinator.usageVersion(conversation);
  expect(disabled.enabled).toBe(false); expect(disabled.epoch).toBeGreaterThan(previous.epoch);
  let acknowledged = false;
  const settled = off.then(() => { acknowledged = true; });
  await Promise.resolve(); expect(acknowledged).toBe(false);
  gate.resolve(); await settled; expect(acknowledged).toBe(true);
  pause = false;
  await coordinator.off(authority, conversation);
  expect((await coordinator.usageVersion(conversation)).epoch).toBeGreaterThan(disabled.epoch);
  expect(records.map(record => record.enabled)).toEqual([true, false, false]);
});

test("queued off prevents older inflight on from publishing and writes in order", async () => {
  const authority = {}, conversation = {}, started = deferred<void>(), gate = deferred<void>();
  const records: ReadUsageRecord[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(_conversation, record) { records.push(record); if (record.enabled) { started.resolve(); await gate.promise; } },
  } });
  coordinator.register(authority, conversation);
  const pendingOn = outcome(coordinator.on(authority, conversation));
  await started.promise;
  const pendingOff = outcome(coordinator.off(authority, conversation));
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  gate.resolve();
  expect(await pendingOn).toBe("STALE"); expect(await pendingOff).toBe("ok");
  expect(records.map(record => record.enabled)).toEqual([true, false]);
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("store failure is sticky and a later on cannot revive authority", async () => {
  const authority = {}, a = {}, b = {}, secret = "secret backend content";
  let failWrite = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit() { if (failWrite) throw new Error(secret); },
  } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  await coordinator.on(authority, a); await coordinator.on(authority, b);
  const old = await coordinator.usageVersion(a), other = await coordinator.usageVersion(b);
  failWrite = true;
  const pending = coordinator.off(authority, a);
  expect(coordinator.usageCurrent(a, old.epoch)).toBe(false);
  const error = await pending.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ReadUsageError); expect(String(error)).not.toContain(secret);
  failWrite = false;
  expect(await outcome(coordinator.on(authority, a))).toBe("UNCONFIRMED");
  expect((await coordinator.usageVersion(a)).enabled).toBe(false);
  expect(coordinator.usageCurrent(b, other.epoch)).toBe(true);
});

test("full queue still fences off and cannot acknowledge uncertain writes", async () => {
  const authority = {}, conversation = {}, started = deferred<void>(), gate = deferred<void>();
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit() { started.resolve(); await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  const pending = [outcome(coordinator.on(authority, conversation))];
  await started.promise;
  for (let index = 0; index < 7; index++) pending.push(outcome(coordinator.off(authority, conversation)));
  const extra = outcome(coordinator.off(authority, conversation));
  const current = await coordinator.usageVersion(conversation);
  expect(current.enabled).toBe(false);
  expect(coordinator.usageCurrent(conversation, current.epoch)).toBe(false);
  expect(await extra).toBe("UNCONFIRMED");
  gate.resolve();
  expect(await Promise.all(pending)).toEqual(Array(8).fill("UNCONFIRMED"));
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
});

test("reentrant off is queued after its caller before store callbacks run", async () => {
  const authority = {}, conversation = {};
  const records: ReadUsageRecord[] = [];
  let nested: Promise<string> | undefined, reenter = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: {
    async commit(_conversation, record) { records.push(record); },
  }, onRevoke: key => {
    if (reenter) { reenter = false; nested = outcome(coordinator.off(authority, key)); }
  } });
  coordinator.register(authority, conversation);
  reenter = true;
  const on = outcome(coordinator.on(authority, conversation));
  expect(await on).toBe("STALE"); expect(await nested).toBe("ok");
  expect(records.map(record => record.enabled)).toEqual([true, false]);
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("store reentrancy orders off before explicitly requested on", async () => {
  const authority = {}, conversation = {}, records: ReadUsageRecord[] = [];
  let reenter = false, nested: Promise<string> | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(key, record) {
      records.push(record);
      if (reenter && !record.enabled) { reenter = false; nested = outcome(coordinator.on(authority, key)); }
    },
  } });
  coordinator.register(authority, conversation); await coordinator.on(authority, conversation);
  reenter = true;
  const off = outcome(coordinator.off(authority, conversation));
  expect(await off).toBe("ok"); expect(await nested).toBe("ok");
  expect(records.map(record => record.enabled)).toEqual([true, false, true]);
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(true);
});

test("async notification is not an acknowledgement and cannot enable", async () => {
  const authority = {}, conversation = {};
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() {} },
    onRevoke: async () => { throw new Error("private"); } });
  coordinator.register(authority, conversation);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("store returning no promise does not acknowledge an update", async () => {
  const authority = {}, conversation = {};
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {},
    store: { commit: (() => undefined) as unknown as () => Promise<void> } });
  coordinator.register(authority, conversation);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("throwing notification leaves disabled and redacts raw failure", async () => {
  const authority = {}, conversation = {};
  let shouldThrow = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() {} },
    onRevoke: () => { if (shouldThrow) throw new Error("secret"); } });
  coordinator.register(authority, conversation); await coordinator.on(authority, conversation);
  const previous = await coordinator.usageVersion(conversation);
  shouldThrow = true;
  const off = coordinator.off(authority, conversation);
  expect(coordinator.usageCurrent(conversation, previous.epoch)).toBe(false);
  const error = await off.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ReadUsageError); expect(String(error)).not.toContain("secret");
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
});

test("restart starts disabled and records have distinct broker instance identity", async () => {
  const authority = {}, conversation = {}, records: ReadUsageRecord[] = [];
  const options = { ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(_conversation: object, record: ReadUsageRecord) { records.push(record); },
  } };
  const first = new ReadUsageCoordinator(options);
  first.register(authority, conversation); await first.on(authority, conversation);
  const second = new ReadUsageCoordinator(options);
  second.register(authority, conversation);
  expect((await second.usageVersion(conversation)).enabled).toBe(false);
  const old = await first.usageVersion(conversation);
  await second.on(authority, conversation);
  const current = await second.usageVersion(conversation);
  expect(records[0]?.instance).not.toBe(records[1]?.instance);
  expect(current.epoch).toBe(old.epoch);
  expect(second.usageCurrent(conversation, old.epoch)).toBe(true);
  // Numeric epochs repeat. Broker must discard its old Sessions and grants and must not
  // replace a coordinator while an old write can still affect the same durable store.
});

test("deadlocked nested store operation expires without another store write", async () => {
  const authority = {}, conversation = {};
  let writes = 0, nested: Promise<void> | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 20, onRevoke: () => {}, store: {
    async commit(key) { writes++; nested = coordinator.off(authority, key); await nested; },
  } });
  coordinator.register(authority, conversation);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  expect(nested).toBeDefined();
  expect(await outcome(nested!)).toBe("UNCONFIRMED");
  expect(writes).toBe(1);
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
});

test("late store success cannot enable or start queued work after deadline", async () => {
  const authority = {}, conversation = {}, started = deferred<void>(), gate = deferred<void>();
  const writes: ReadUsageRecord[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 20, onRevoke: () => {}, store: {
    async commit(_key, record) { writes.push(record); started.resolve(); await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  const on = outcome(coordinator.on(authority, conversation));
  await started.promise;
  const off = outcome(coordinator.off(authority, conversation));
  expect(await on).toBe("UNCONFIRMED"); expect(await off).toBe("UNCONFIRMED");
  gate.resolve();
  await gate.promise; await Promise.resolve(); await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
});

test("cross-realm rejected notification remains disabled and handled", async () => {
  const authority = {}, conversation = {};
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() {} },
    onRevoke: () => runInNewContext('Promise.reject(new Error("private"))') });
  coordinator.register(authority, conversation);
  expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("registration capacity and object identity are bounded", () => {
  const authority = {}, coordinator = new ReadUsageCoordinator({ ownerAuthority: authority,
    onRevoke: () => {}, store: { async commit() {} } });
  const keys = [{}, {}, {}, {}];
  for (const key of keys) coordinator.register(authority, key);
  expect(() => coordinator.register(authority, {})).toThrow(ReadUsageError);
  expect(() => coordinator.register(authority, keys[0]!)).toThrow(ReadUsageError);
  expect(() => coordinator.register({}, {})).toThrow(ReadUsageError);
});

test("poisonAll requires exact owner authority and unauthorized calls have no effect", async () => {
  const authority = {}, a = {}, b = {}, notifications: object[] = [];
  let writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: key => { notifications.push(key); },
    store: { async commit() { writes++; } } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  await coordinator.on(authority, a); await coordinator.on(authority, b);
  const beforeA = await coordinator.usageVersion(a), beforeB = await coordinator.usageVersion(b);
  notifications.length = 0;
  try { coordinator.poisonAll({}); throw new Error("Expected owner refusal"); }
  catch (error) { expect(error).toMatchObject({ code: "DENIED", message: "Read usage operation refused" }); }
  expect(notifications).toEqual([]); expect(writes).toBe(2);
  expect(await coordinator.usageVersion(a)).toEqual(beforeA); expect(await coordinator.usageVersion(b)).toEqual(beforeB);
  expect(coordinator.usageCurrent(a, beforeA.epoch)).toBe(true); expect(coordinator.usageCurrent(b, beforeB.epoch)).toBe(true);
});

test("cohort poison fences every entry before throwing callbacks and ordinary invalid returns", async () => {
  const authority = {}, keys = [{}, {}, {}, {}], calls: object[] = [], fenced: boolean[] = [];
  let armed = false, effects = 0, writes = 0;
  let versions: { epoch: number }[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() { writes++; } },
    onRevoke: key => {
      if (!armed) return;
      calls.push(key); fenced.push(keys.every((item, index) => !coordinator.usageCurrent(item, versions[index]!.epoch)));
      const index = keys.indexOf(key);
      if (index === 0) throw new Error("private-callback-content");
      if (index === 1) return runInNewContext('Promise.reject(new Error("private-crossrealm-content"))');
      if (index === 2) return Object.defineProperty({}, "then", { get() { effects++; throw new Error("No thenable getter"); } });
      return 7;
    } });
  for (const key of keys) coordinator.register(authority, key);
  for (const key of keys) await coordinator.on(authority, key);
  versions = await Promise.all(keys.map(key => coordinator.usageVersion(key)));
  armed = true; coordinator.poisonAll(authority);
  expect(calls).toEqual(keys); expect(fenced).toEqual([true, true, true, true]); expect(effects).toBe(0);
  const poisoned = await Promise.all(keys.map(key => coordinator.usageVersion(key)));
  expect(poisoned.every((value, index) => !value.enabled && value.epoch > versions[index]!.epoch)).toBe(true);
  coordinator.poisonAll(authority); expect(calls).toEqual(keys);
  expect(await Promise.all(keys.flatMap(key => [outcome(coordinator.on(authority, key)), outcome(coordinator.off(authority, key))])))
    .toEqual(Array(8).fill("UNCONFIRMED"));
  expect(writes).toBe(4); expect(await coordinator.usageVersion(keys[0]!)).toEqual(poisoned[0]!);
  expect(() => coordinator.register(authority, {})).toThrow(ReadUsageError);
  await Promise.resolve(); await Promise.resolve();
});

test("poison callback reentry cannot recurse register or reenable a different conversation", async () => {
  const authority = {}, a = {}, b = {}, calls: object[] = [], nested: Promise<string>[] = [];
  let armed = false, registrationCode = "", writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() { writes++; } }, onRevoke: key => {
    if (!armed) return;
    calls.push(key); coordinator.poisonAll(authority);
    nested.push(outcome(coordinator.on(authority, b)), outcome(coordinator.off(authority, a)));
    try { coordinator.register(authority, {}); } catch (error) { registrationCode = (error as ReadUsageError).code; }
  } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  await coordinator.on(authority, a); await coordinator.on(authority, b);
  armed = true; coordinator.poisonAll(authority);
  expect(calls).toEqual([a, b]); expect(registrationCode).toBe("UNCONFIRMED");
  expect(await Promise.all(nested)).toEqual(Array(4).fill("UNCONFIRMED")); expect(writes).toBe(2);
  expect((await coordinator.usageVersion(b)).enabled).toBe(false);
});

for (const rejectAck of [false, true]) test("cohort poison refuses pending on and off including late ACK, reject=" + rejectAck, async () => {
  const authority = {}, a = {}, b = {}, gate = deferred<void>(), startedA = deferred<void>(), startedB = deferred<void>();
  const writes: { key: object; enabled: boolean }[] = [];
  let paused = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(key, record) {
      writes.push({ key, enabled: record.enabled });
      if (paused) { (key === a ? startedA : startedB).resolve(); await gate.promise; }
    },
  } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  await coordinator.on(authority, b); paused = true;
  const on = outcome(coordinator.on(authority, a)), off = outcome(coordinator.off(authority, b));
  try {
    await Promise.all([startedA.promise, startedB.promise]);
    const queued = outcome(coordinator.off(authority, a));
    const beforeA = await coordinator.usageVersion(a), beforeB = await coordinator.usageVersion(b);
    coordinator.poisonAll(authority);
    expect(coordinator.usageCurrent(a, beforeA.epoch)).toBe(false); expect(coordinator.usageCurrent(b, beforeB.epoch)).toBe(false);
    expect((await coordinator.usageVersion(a)).enabled).toBe(false); expect((await coordinator.usageVersion(b)).enabled).toBe(false);
    if (rejectAck) gate.reject(new Error("private-late-store-error")); else gate.resolve();
    expect(await Promise.all([on, off, queued])).toEqual(["UNCONFIRMED", "UNCONFIRMED", "UNCONFIRMED"]);
    expect(writes).toHaveLength(3);
    expect(await outcome(coordinator.on(authority, a))).toBe("UNCONFIRMED");
    expect(await outcome(coordinator.off(authority, b))).toBe("UNCONFIRMED");
  } finally { gate.resolve(); await Promise.all([on, off]); }
});

test("poison before queued work starts never invokes the store", async () => {
  const authority = {}, a = {}, b = {}; let writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  const first = outcome(coordinator.on(authority, a)), second = outcome(coordinator.off(authority, b));
  coordinator.poisonAll(authority);
  expect(await Promise.all([first, second])).toEqual(["UNCONFIRMED", "UNCONFIRMED"]); expect(writes).toBe(0);
});

test("reentrant notification poison precedes asynchronous on acknowledgement", async () => {
  const authority = {}, a = {}, b = {}; let armed = false, writes = 0, notifications = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() { writes++; } }, onRevoke: () => {
    if (armed) { notifications++; coordinator.poisonAll(authority); }
  } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  armed = true;
  expect(await outcome(coordinator.on(authority, a))).toBe("UNCONFIRMED");
  expect(notifications).toBe(3); expect(writes).toBe(0);
  expect((await coordinator.usageVersion(a)).enabled).toBe(false); expect((await coordinator.usageVersion(b)).enabled).toBe(false);
});

test("off acknowledgement rechecks cohort poison after timer cleanup", async () => {
  const authority = {}, conversation = {}; let armed = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: { async commit() {} } });
  coordinator.register(authority, conversation); await coordinator.on(authority, conversation);
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    Reflect.apply(original, globalThis, [timer]);
    if (!armed) { armed = true; coordinator.poisonAll(authority); }
  });
  try { expect(await outcome(coordinator.off(authority, conversation))).toBe("UNCONFIRMED"); }
  finally { clear.mockRestore(); }
  expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
});

test("on acknowledgement refuses a newer off reentered during timer cleanup while off still acknowledges durably", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>();
  const records: boolean[] = [];
  let fired = false, off: Promise<string> | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => {}, store: {
    async commit(_key, record) { records.push(record.enabled); if (!record.enabled) await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    Reflect.apply(original, globalThis, [timer]);
    if (!fired) { fired = true; off = outcome(coordinator.off(authority, conversation)); }
  });
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("STALE");
    expect(fired).toBe(true); expect(off).toBeDefined();
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
    gate.resolve(); expect(await off).toBe("ok");
    expect(records).toEqual([true, false]);
  } finally { clear.mockRestore(); gate.resolve(); await off; }
});

test("poisoning an empty coordinator permanently rejects future registration", async () => {
  const authority = {}; let calls = 0, writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: () => { calls++; }, store: { async commit() { writes++; } } });
  coordinator.poisonAll(authority); coordinator.poisonAll(authority);
  expect(() => coordinator.register(authority, {})).toThrow(ReadUsageError);
  expect(await outcome(coordinator.on(authority, {}))).toBe("UNCONFIRMED");
  expect(await outcome(coordinator.off(authority, {}))).toBe("UNCONFIRMED");
  expect(calls).toBe(0); expect(writes).toBe(0);
});

for (const operation of ["on", "off"] as const) test(operation + " final ACK refuses a deadline crossed only during timer cleanup", async () => {
  const authority = {}, conversation = {}, records: boolean[] = []; let clock = 100;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 50, onRevoke() {}, store: {
    async commit(_key, value) { records.push(value.enabled); },
  } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  let restoreClear: (() => void) | undefined;
  try {
    if (operation === "off") await coordinator.on(authority, conversation);
    const original = globalThis.clearTimeout;
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { Reflect.apply(original, globalThis, [timer]); clock = 150; });
    restoreClear = () => clear.mockRestore();
    expect(await outcome(coordinator[operation](authority, conversation))).toBe("UNCONFIRMED");
    const version = await coordinator.usageVersion(conversation);
    expect(version.enabled).toBe(false); expect(coordinator.usageCurrent(conversation, version.epoch)).toBe(false);
    clock = 100; expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
    expect(records).toEqual(operation === "on" ? [true] : [true, false]);
  } finally { restoreClear?.(); now.mockRestore(); }
});

for (const fault of ["backwards", "nan", "infinity", "throw"] as const) test("final ACK clock " + fault + " is fixed unconfirmed and sticky", async () => {
  const authority = {}, conversation = {}; let clock = 100, broken = false, writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 50, onRevoke() {}, store: {
    async commit() { writes++; clock = 120; },
  } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => { if (broken) throw new Error("private-clock-secret"); return clock; });
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    Reflect.apply(original, globalThis, [timer]);
    if (fault === "throw") broken = true;
    else clock = fault === "backwards" ? 110 : fault === "nan" ? NaN : Infinity;
  });
  try {
    const error: unknown = await coordinator.on(authority, conversation).catch(error => error);
    expect(error).toBeInstanceOf(ReadUsageError); expect(error).toMatchObject({ code: "UNCONFIRMED" });
    expect(String(error)).not.toContain("private-clock-secret"); expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
    broken = false; clock = 120;
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED"); expect(writes).toBe(1);
  } finally { clear.mockRestore(); now.mockRestore(); }
});

for (const action of ["off", "poison"] as const) test("final clock callback reentry " + action + " is checked before public on ACK", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>(); let finalSample = false, reentered = false, nested: Promise<string> | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 50, onRevoke() {}, store: {
    async commit(_key, value) { if (!value.enabled) await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => {
    if (finalSample && !reentered) {
      reentered = true;
      if (action === "off") nested = outcome(coordinator.off(authority, conversation));
      else coordinator.poisonAll(authority);
    }
    return 100;
  });
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { Reflect.apply(original, globalThis, [timer]); finalSample = true; });
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe(action === "off" ? "STALE" : "UNCONFIRMED");
    expect(reentered).toBe(true); expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
    gate.resolve(); if (nested) expect(await nested).toBe("ok");
  } finally { gate.resolve(); await nested; clear.mockRestore(); now.mockRestore(); }
});

test("clock failure before store dispatch is fixed content-free refusal without a store call", async () => {
  const authority = {}, conversation = {}; let writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => { throw new Error("private-initial-clock"); });
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false); expect(writes).toBe(0);
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  } finally { now.mockRestore(); }
});

test("deterministic deadline rejects a late ACK and blocks already queued work without cancelling the store", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>(), started = deferred<void>(); let clock = 100, writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 50, onRevoke() {}, store: {
    async commit() { writes++; started.resolve(); await gate.promise; },
  } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const on = outcome(coordinator.on(authority, conversation)); let off: Promise<string> | undefined;
  try {
    await started.promise; off = outcome(coordinator.off(authority, conversation));
    clock = 150; gate.resolve();
    expect(await on).toBe("UNCONFIRMED"); expect(await off).toBe("UNCONFIRMED"); expect(writes).toBe(1);
    clock = 100; expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { gate.resolve(); await on; await off; now.mockRestore(); }
});

for (const action of ["on", "off"] as const) test("initial unreserved clock mutation " + action + " poisons rather than reordering store operations", async () => {
  const authority = {}, conversation = {}; let entered = false, writes = 0, nested: Promise<string> | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => {
    if (!entered) { entered = true; nested = outcome(coordinator[action](authority, conversation)); }
    return 100;
  });
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
    expect(await nested).toBe("UNCONFIRMED"); expect(writes).toBe(0);
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { await nested; now.mockRestore(); }
});

test("initial clock registration reentry cannot publish a new conversation after poisoning", async () => {
  const authority = {}, conversation = {}, injected = {}; let entered = false, code = "", writes = 0, fences = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, onPoisonFenced() { fences++; }, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => {
    if (!entered) { entered = true; try { coordinator.register(authority, injected); } catch (error) { code = (error as ReadUsageError).code; } }
    return 100;
  });
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED"); expect(code).toBe("UNCONFIRMED"); expect(writes).toBe(0); expect(fences).toBe(1);
    await expect(coordinator.usageVersion(injected)).rejects.toMatchObject({ code: "DENIED" });
  } finally { now.mockRestore(); }
});

test("unrepresentable deadline addition fails closed before store or timer dispatch", async () => {
  const authority = {}, conversation = {}; let writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockReturnValue(Number.MAX_VALUE);
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED"); expect(writes).toBe(0);
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { now.mockRestore(); }
});

test("on remains disabled through timer cleanup and publishes only at final ACK", async () => {
  const authority = {}, conversation = {}, observed: boolean[] = [];
  const versions: Promise<{ enabled: boolean }>[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() {} } });
  coordinator.register(authority, conversation);
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    Reflect.apply(original, globalThis, [timer]);
    observed.push(coordinator.usageCurrent(conversation, 2)); versions.push(coordinator.usageVersion(conversation));
  });
  try {
    await coordinator.on(authority, conversation);
    expect(observed).toEqual([false]); expect((await Promise.all(versions)).every(version => !version.enabled)).toBe(true);
    const accepted = await coordinator.usageVersion(conversation);
    expect(accepted.enabled).toBe(true); expect(coordinator.usageCurrent(conversation, accepted.epoch)).toBe(true);
  } finally { clear.mockRestore(); }
});

test("queued on never dispatches before preceding off final ACK deadline fence", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>(), started = deferred<void>();
  const records: boolean[] = []; let clock = 100, hold = false;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, deadlineMs: 50, onRevoke() {}, store: {
    async commit(_key, record) { records.push(record.enabled); if (hold) { started.resolve(); await gate.promise; } },
  } });
  coordinator.register(authority, conversation);
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  let restoreClear: (() => void) | undefined, first: Promise<string> | undefined, second: Promise<string> | undefined;
  try {
    await coordinator.on(authority, conversation); hold = true;
    first = outcome(coordinator.off(authority, conversation)); await started.promise;
    second = outcome(coordinator.on(authority, conversation));
    const original = globalThis.clearTimeout;
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { Reflect.apply(original, globalThis, [timer]); clock = 150; });
    restoreClear = () => clear.mockRestore();
    gate.resolve(); expect(await first).toBe("UNCONFIRMED"); expect(await second).toBe("UNCONFIRMED");
    expect(records).toEqual([true, false]); expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { gate.resolve(); await first; await second; restoreClear?.(); now.mockRestore(); }
});

test("throwing timer cleanup rejects fixed unconfirmed and blocks the next queued on", async () => {
  const authority = {}, conversation = {}, gate = deferred<void>(), started = deferred<void>();
  let hold = false; const records: boolean[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: {
    async commit(_key, value) { records.push(value.enabled); if (hold) { started.resolve(); await gate.promise; } },
  } });
  coordinator.register(authority, conversation); await coordinator.on(authority, conversation); hold = true;
  const first = outcome(coordinator.off(authority, conversation)); await started.promise;
  const second = outcome(coordinator.on(authority, conversation));
  const original = globalThis.clearTimeout;
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { Reflect.apply(original, globalThis, [timer]); throw new Error("private-timer-cleanup"); });
  try {
    gate.resolve(); expect(await first).toBe("UNCONFIRMED"); expect(await second).toBe("UNCONFIRMED");
    expect(records).toEqual([true, false]); expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
  } finally { gate.resolve(); await first; await second; clear.mockRestore(); }
});

test("timer setup mutation reentry poisons before an ordering tail or store write can escape", async () => {
  const authority = {}, conversation = {}; let entered = false, nested: Promise<string> | undefined, writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const original = globalThis.setTimeout;
  const implementation = typedTimer(args => {
    if (!entered) { entered = true; nested = outcome(coordinator.off(authority, conversation)); }
    return Reflect.apply(original, globalThis, args) as TimerResult;
  });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(implementation);
  try {
    expect(await outcome(coordinator.on(authority, conversation))).toBe("UNCONFIRMED");
    expect(await nested).toBe("UNCONFIRMED"); expect(writes).toBe(0);
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { await nested; timer.mockRestore(); }
});

test("timer setup exception is content-free unconfirmed with no store dispatch", async () => {
  const authority = {}, conversation = {}; let writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() { writes++; } } });
  coordinator.register(authority, conversation);
  const implementation = typedTimer(() => { throw new Error("private-timer-setup"); });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(implementation);
  try {
    const error: unknown = await coordinator.on(authority, conversation).catch(error => error);
    expect(error).toBeInstanceOf(ReadUsageError); expect(error).toMatchObject({ code: "UNCONFIRMED" });
    expect(String(error)).not.toContain("private-timer-setup"); expect(writes).toBe(0);
    expect((await coordinator.usageVersion(conversation)).enabled).toBe(false);
  } finally { timer.mockRestore(); }
});

for (const mode of ["throw", "return"] as const) test("uncleared stale timer is inactive after ACK cleanup " + mode, async () => {
  const authority = {}, a = {}, b = {}, callbacks: (() => void)[] = [], handles: TimerResult[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { async commit() {} } });
  coordinator.register(authority, a); coordinator.register(authority, b); await coordinator.on(authority, b);
  const other = await coordinator.usageVersion(b), nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const implementation = typedTimer(args => {
    callbacks.push(() => { Reflect.apply(args[0], undefined, []); });
    const handle = Reflect.apply(nativeSet, globalThis, args) as TimerResult; handles.push(handle); return handle;
  });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(implementation);
  // Deliberately do not call native clear: its runtime resource stays live until fixture cleanup.
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => { if (mode === "throw") throw new Error("private-uncleared-timer"); });
  try {
    expect(await outcome(coordinator.on(authority, a))).toBe(mode === "throw" ? "UNCONFIRMED" : "ok");
    const before = await coordinator.usageVersion(a);
    callbacks[0]!(); expect(await coordinator.usageVersion(a)).toEqual(before);
    expect(coordinator.usageCurrent(b, other.epoch)).toBe(true);
    if (mode === "return") {
      await coordinator.off(authority, a); await coordinator.on(authority, a);
      const fresh = await coordinator.usageVersion(a); callbacks[0]!();
      expect(coordinator.usageCurrent(a, fresh.epoch)).toBe(true);
    } else expect(await outcome(coordinator.on(authority, a))).toBe("UNCONFIRMED");
  } finally {
    clear.mockRestore(); timer.mockRestore();
    for (const handle of handles) Reflect.apply(nativeClear, globalThis, [handle]);
  }
});

test("counter exhaustion uses the same complete cohort poison without wrapping or callback recursion", async () => {
  // Private counter seeding is confined to this compiled test copy, not a production seam.
  const raw = readFileSync(new URL("../src/read-usage-coordinator.ts", import.meta.url), "utf8");
  expect(raw.split("#counter = 0;")).toHaveLength(2);
  const seeded = raw.split("\n").filter(line => !line.startsWith("import ")).join("\n")
    .replaceAll("export ", "").replace("#counter = 0;", "#counter = Number.MAX_SAFE_INTEGER - 2;");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(seeded + "\nglobalThis.__FixtureCoordinator = ReadUsageCoordinator;");
  const context: Record<string, unknown> = { randomBytes, nodeTypes, performance, setTimeout, clearTimeout, Promise };
  runInNewContext(compiled, context);
  const Coordinator = context.__FixtureCoordinator as typeof ReadUsageCoordinator;
  expect(typeof Coordinator).toBe("function");
  const authority = {}, a = {}, b = {}, notifications: object[] = [], phases: string[] = [];
  const coordinator = new Coordinator({ ownerAuthority: authority, onPoisonFenced: () => { phases.push("fence"); }, onRevoke: key => { phases.push("revoke"); notifications.push(key); coordinator.poisonAll(authority); }, store: { async commit() { throw new Error("No store work"); } } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  let code = ""; try { coordinator.on(authority, a); } catch (error) { code = (error as ReadUsageError).code; }
  expect(code).toBe("LIMIT"); expect(notifications).toEqual([a, b]); expect(phases).toEqual(["fence", "revoke", "revoke"]);
  const versions = await Promise.all([coordinator.usageVersion(a), coordinator.usageVersion(b)]);
  expect(versions.every(value => !value.enabled && Number.isSafeInteger(value.epoch) && value.epoch === Number.MAX_SAFE_INTEGER)).toBe(true);
  const result = await coordinator.off(authority, b).catch((error: { code: string }) => error.code);
  expect(result).toBe("UNCONFIRMED"); expect(notifications).toEqual([a, b]);
});


test("poison fence hook validates own synchronous callback without running it during construction", async () => {
  const owner = {}, key = {}, store = { async commit() {} };
  for (const value of [null, false, 1, {}, new Proxy(() => {}, {})]) {
    expect(() => new ReadUsageCoordinator({ ownerAuthority: owner, store, onRevoke() {}, onPoisonFenced: value as never })).toThrow(ReadUsageError);
  }
  let getters = 0;
  const accessor = Object.defineProperty({ ownerAuthority: owner, store, onRevoke() {} }, "onPoisonFenced", {
    get() { getters++; return () => {}; },
  });
  expect(() => new ReadUsageCoordinator(accessor)).toThrow(ReadUsageError);
  expect(getters).toBe(0);
  let hooks = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: owner, store, onRevoke() {}, onPoisonFenced() { hooks++; } });
  coordinator.register(owner, key); await coordinator.on(owner, key);
  expect(hooks).toBe(0);
  coordinator.poisonAll(owner); coordinator.poisonAll(owner);
  expect(hooks).toBe(1);
  expect((await coordinator.usageVersion(key)).enabled).toBe(false);
});

test("fence hook runs after all authority is disabled and before any revocation including reentry", async () => {
  const owner = {}, keys = [{}, {}, {}], stages: string[] = [], observations: boolean[][] = [];
  let armed = false, coordinator!: ReadUsageCoordinator;
  let versions: { epoch: number }[] = [], hookCalls = 0;
  const nested: Promise<string>[] = [];
  coordinator = new ReadUsageCoordinator({ ownerAuthority: owner, store: { async commit() {} },
    onPoisonFenced() {
      hookCalls++; stages.push("hook");
      observations.push(keys.map((key, index) => coordinator.usageCurrent(key, versions[index]!.epoch)));
      coordinator.poisonAll(owner);
      nested.push(outcome(coordinator.on(owner, keys[0]!)));
    },
    onRevoke() {
      if (!armed) return;
      stages.push("revoke");
      observations.push(keys.map((key, index) => coordinator.usageCurrent(key, versions[index]!.epoch)));
    } });
  for (const key of keys) { coordinator.register(owner, key); await coordinator.on(owner, key); }
  versions = await Promise.all(keys.map(key => coordinator.usageVersion(key)));
  expect(keys.every((key, index) => coordinator.usageCurrent(key, versions[index]!.epoch))).toBe(true);
  armed = true; coordinator.poisonAll(owner);
  expect(stages).toEqual(["hook", "revoke", "revoke", "revoke"]);
  expect(observations).toEqual(Array.from({ length: 4 }, () => [false, false, false]));
  expect(hookCalls).toBe(1);
  expect(await Promise.all(nested)).toEqual(["UNCONFIRMED"]);
});

test("throwing nonvoid and ordinary rejected-promise fence hooks never skip revocation or restore authority", async () => {
  for (const mode of ["throw", "value", "promise", "thenable"] as const) {
    const owner = {}, a = {}, b = {}, notified: object[] = [];
    let calls = 0, thenReads = 0, armed = false;
    const coordinator = new ReadUsageCoordinator({ ownerAuthority: owner, store: { async commit() {} },
      onRevoke(key) { if (armed) notified.push(key); },
      onPoisonFenced() {
        calls++;
        if (mode === "throw") throw new Error("PRIVATE-hook-fault");
        if (mode === "value") return 1 as never;
        if (mode === "promise") return Promise.reject(new Error("PRIVATE-hook-rejection")) as never;
        return Object.defineProperty({}, "then", { get() { thenReads++; throw new Error("Not a promise"); } }) as never;
      } });
    coordinator.register(owner, a); coordinator.register(owner, b);
    await coordinator.on(owner, a); await coordinator.on(owner, b);
    armed = true;
    expect(() => coordinator.poisonAll(owner)).not.toThrow();
    expect(notified).toEqual([a, b]); expect(calls).toBe(1); expect(thenReads).toBe(0);
    expect((await coordinator.usageVersion(a)).enabled).toBe(false);
    expect((await coordinator.usageVersion(b)).enabled).toBe(false);
    expect(await outcome(coordinator.on(owner, a))).toBe("UNCONFIRMED");
    coordinator.poisonAll(owner); expect(calls).toBe(1); expect(notified).toEqual([a, b]);
    // Logical poison is certain; a bad trusted hook is not an external gate ACK.
  }
});
