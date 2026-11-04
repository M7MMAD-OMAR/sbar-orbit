import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ReadUsageCoordinator, ReadUsageError, type ReadUsageRecord } from "../src/read-usage-coordinator";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const outcome = <T>(promise: Promise<T>) => promise.then(() => "ok", (error: unknown) => error instanceof ReadUsageError ? error.code : "unexpected");

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
