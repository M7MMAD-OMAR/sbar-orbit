import { expect, test } from "bun:test";
import { ReadUsageCoordinator, type ReadUsageRecord } from "../src/read-usage-coordinator";
import { createReadUsageStoreTransport, ReadUsageTransportError, type ReadUsageByteChannel, type ReadUsageTransport } from "../src/read-usage-store-transport";

// In-memory owner-held channel only. No process, socket, filesystem or durable-store qualification.
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const outcome = (promise: Promise<void>) => promise.then(() => "ok", (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "unexpected");
function frame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text), result = new Uint8Array(body.byteLength + 4);
  new DataView(result.buffer).setUint32(0, body.byteLength); result.set(body, 4); return result;
}
const ack = (id: number) => frame(JSON.stringify({ id, ok: true }));
const record = (epoch = 1, enabled = true): ReadUsageRecord => ({ instance: "a".repeat(64), epoch, enabled });
type Request = { id: number; slot: number; record: ReadUsageRecord };
type Events = Parameters<ReadUsageByteChannel["subscribe"]>[0];
function fixture(initialEOF = false) {
  const authority = {}, a = {}, b = {}, writes: Request[] = [], frames: Uint8Array[] = [], revoked: object[] = [];
  const sent = deferred<void>(), timers: { expire(): void; cancelled: boolean }[] = [];
  const state = { autoAck: true, clock: 100, failures: 0, subscriptions: 0,
    writeHook: undefined as undefined | ((request: Request, bytes: Uint8Array) => unknown),
    failureHook: undefined as undefined | (() => unknown), disarmHook: undefined as undefined | (() => unknown),
    clockHook: undefined as undefined | (() => void) };
  let transport: ReadUsageTransport | undefined, events!: Events;
  // Bind poisonAll before subscribe. Even synchronous EOF cannot lose its cohort fence.
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: key => { revoked.push(key); }, store: {
    commit: (key, value) => {
      if (!transport) throw new Error("Owner store is not bound");
      return transport.store.commit(key, value);
    },
  } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  const channel: ReadUsageByteChannel = {
    subscribe(handler) { state.subscriptions++; events = handler; if (initialEOF) handler.eof(); },
    write(bytes) {
      const copy = new Uint8Array(bytes); frames.push(copy);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(copy.subarray(4));
      const request = JSON.parse(text) as Request;
      expect(new DataView(copy.buffer).getUint32(0)).toBe(copy.byteLength - 4);
      expect(text).toBe(JSON.stringify({ id: request.id, slot: request.slot, record: {
        instance: request.record.instance, epoch: request.record.epoch, enabled: request.record.enabled,
      } }));
      writes.push(request); sent.resolve();
      if (state.writeHook) return state.writeHook(request, bytes) as Promise<void>;
      if (state.autoAck) events.data(ack(request.id));
      return Promise.resolve();
    },
  };
  transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }], channel,
    onFailure: () => { state.failures++; coordinator.poisonAll(authority); return state.failureHook?.(); },
    now: () => { state.clockHook?.(); return state.clock; },
    arm: (_milliseconds, expire) => {
      const timer = { expire, cancelled: false }; timers.push(timer);
      return () => { timer.cancelled = true; return state.disarmHook?.(); };
    },
  });
  const peer = { data: (bytes: Uint8Array) => events.data(bytes), ack: (id = writes.at(-1)!.id) => events.data(ack(id)),
    eof: () => events.eof(), error: () => events.error() };
  return { authority, a, b, state, transport, coordinator, writes, frames, revoked, sent, timers, peer, channel };
}

test("actual coordinator enables only after canonical durable ACK and local write completion", async () => {
  const f = fixture();
  await f.coordinator.on(f.authority, f.a); await f.coordinator.on(f.authority, f.b);
  expect(f.writes.map(item => [item.id, item.slot, item.record.enabled])).toEqual([[1, 0, true], [2, 1, true]]);
  expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(true);
  expect((await f.coordinator.usageVersion(f.b)).enabled).toBe(true);
  expect(f.transport.status(f.authority)).toEqual({ failed: false, queued: 0, inFlight: false, uncertain: false });
  expect(f.state.failures).toBe(0); expect(f.state.subscriptions).toBe(1);
});

test("initial synchronous EOF poisons the already bound coordinator and cannot be enabled after binding", async () => {
  const f = fixture(true);
  expect(f.state.failures).toBe(1); expect(f.revoked).toEqual([f.a, f.b]);
  expect(await outcome(f.coordinator.on(f.authority, f.a))).toBe("UNCONFIRMED");
  expect(await outcome(f.coordinator.off(f.authority, f.b))).toBe("UNCONFIRMED");
  expect(f.writes).toEqual([]); expect(f.transport.status(f.authority)).toMatchObject({ failed: true, uncertain: true });
});

test("idle EOF revokes previous success for every conversation synchronously before any promise turn", async () => {
  const f = fixture();
  await f.coordinator.on(f.authority, f.a); await f.coordinator.on(f.authority, f.b);
  const a = await f.coordinator.usageVersion(f.a), b = await f.coordinator.usageVersion(f.b);
  f.revoked.length = 0; f.peer.eof();
  expect(f.coordinator.usageCurrent(f.a, a.epoch)).toBe(false); expect(f.coordinator.usageCurrent(f.b, b.epoch)).toBe(false);
  expect(f.revoked).toEqual([f.a, f.b]); expect(f.state.failures).toBe(1);
  f.peer.eof(); f.peer.error(); f.transport.fail(f.authority); expect(f.state.failures).toBe(1);
  expect(await outcome(f.coordinator.on(f.authority, f.b))).toBe("UNCONFIRMED");
});

test("wrong owner and aliased conversation cannot affect the channel or active coordinator", async () => {
  const f = fixture(); await f.coordinator.on(f.authority, f.a);
  const version = await f.coordinator.usageVersion(f.a);
  expect(() => f.transport.fail({})).toThrow(ReadUsageTransportError);
  expect(() => f.transport.status({})).toThrow(ReadUsageTransportError);
  expect(await outcome(f.transport.store.commit({ ...f.a }, record()))).toBe("DENIED");
  expect(f.coordinator.usageCurrent(f.a, version.epoch)).toBe(true); expect(f.state.failures).toBe(0); expect(f.writes).toHaveLength(1);
});

test("one global FIFO admits at most four entries and never writes the next before exact ACK", async () => {
  const f = fixture(); f.state.autoAck = false;
  const pending = [1, 2, 3, 4].map(epoch => outcome(f.transport.store.commit(f.a, record(epoch))));
  expect(f.writes).toHaveLength(1); expect(f.transport.status(f.authority)).toMatchObject({ queued: 3, inFlight: true });
  expect(await outcome(f.transport.store.commit(f.b, record(5)))).toBe("BUSY"); expect(f.state.failures).toBe(0);
  for (let index = 0; index < pending.length; index++) {
    expect(f.writes.at(-1)!.id).toBe(index + 1); f.peer.ack(index + 1); expect(await pending[index]).toBe("ok");
  }
  expect(f.writes.map(item => item.id)).toEqual([1, 2, 3, 4]); expect(f.transport.status(f.authority).inFlight).toBe(false);
});

test("split ACK fragments are copied before caller aliases can mutate them", async () => {
  const f = fixture(); f.state.autoAck = false;
  const pending = outcome(f.coordinator.on(f.authority, f.a)); await f.sent.promise;
  const bytes = ack(1), first = new Uint8Array(bytes.slice(0, 5));
  f.peer.data(first); first.fill(255); f.peer.data(new Uint8Array(bytes.slice(5)));
  expect(await pending).toBe("ok"); expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(true);
});

test("synchronous ACK followed by write throw cannot become a successful coordinator ACK", async () => {
  const f = fixture();
  f.state.writeHook = request => { f.peer.ack(request.id); throw new Error("private-write-error"); };
  expect(await outcome(f.coordinator.on(f.authority, f.a))).toBe("UNCONFIRMED");
  expect(f.state.failures).toBe(1); expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(false);
  expect(f.transport.status(f.authority)).toMatchObject({ failed: true, inFlight: true, uncertain: true });
});

test("ACK cannot settle while write remains unknown and late settlement never clears tombstone", async () => {
  const f = fixture(), gate = deferred<void>(); let settled = false;
  f.state.writeHook = request => { f.peer.ack(request.id); return gate.promise; };
  const pending = outcome(f.coordinator.on(f.authority, f.a)).then(value => { settled = true; return value; });
  try {
    await f.sent.promise; await Promise.resolve(); expect(settled).toBe(false);
    f.peer.error(); expect(f.state.failures).toBe(1);
    expect(await pending).toBe("UNCONFIRMED");
    gate.resolve(); await Promise.resolve(); await Promise.resolve(); f.peer.ack(1);
    expect(f.transport.status(f.authority)).toMatchObject({ failed: true, inFlight: true, uncertain: true });
    expect(await outcome(f.transport.store.commit(f.b, record()))).toBe("UNCONFIRMED"); expect(f.writes).toHaveLength(1);
  } finally { gate.resolve(); await pending; }
});

for (const extra of ["complete", "partial"] as const) test("a valid ACK plus extra " + extra + " bytes in one input event poisons before ACK publication", async () => {
  const f = fixture(); f.state.autoAck = false;
  const pending = outcome(f.coordinator.on(f.authority, f.a)); await f.sent.promise;
  const first = ack(1), tail = extra === "complete" ? ack(1) : new Uint8Array([0]);
  const batch = new Uint8Array(first.byteLength + tail.byteLength); batch.set(first); batch.set(tail, first.byteLength);
  f.peer.data(batch);
  expect(f.state.failures).toBe(1); expect(await pending).toBe("UNCONFIRMED");
  expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(false);
});

test("malformed noncanonical duplicate-key stale and wrong ACKs fail without echoing private input", async () => {
  for (const text of ['{"id":1,"ok":false}', '{"id":2,"ok":true}', '{"id":0,"ok":true}',
    '{"id":1,"id":1,"ok":true}', '{ "id":1,"ok":true}', '{"ok":true,"id":1}',
    '{"id":1,"ok":true,"secret":"private-ack"}', 'not-json-private-ack']) {
    const f = fixture(); f.state.autoAck = false;
    const pending = outcome(f.coordinator.on(f.authority, f.a)); await f.sent.promise; f.peer.data(frame(text));
    expect(await pending).toBe("UNCONFIRMED"); expect(f.state.failures).toBe(1);
    const error = await f.transport.store.commit(f.a, record()).catch((value: unknown) => value);
    expect(String(error)).toBe("ReadUsageTransportError: Private usage channel refused");
    expect(String(error)).not.toContain("private-ack");
  }
});

test("invalid framing bounds and unsolicited idle ACKs permanently poison", async () => {
  for (const length of [0, 1025, 0xffffffff]) {
    const f = fixture(); f.state.autoAck = false;
    const pending = outcome(f.coordinator.on(f.authority, f.a)); await f.sent.promise;
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, length); f.peer.data(prefix);
    expect(await pending).toBe("UNCONFIRMED"); expect(f.state.failures).toBe(1);
  }
  const f = fixture(); f.peer.data(ack(1));
  expect(f.state.failures).toBe(1); expect(f.writes).toHaveLength(0);
});

test("timeout of queued work poisons the global channel before any later or duplicate ACK", async () => {
  const f = fixture(); f.state.autoAck = false;
  const a = outcome(f.coordinator.on(f.authority, f.a)), b = outcome(f.coordinator.on(f.authority, f.b));
  await f.sent.promise; await Promise.resolve();
  expect(f.timers).toHaveLength(2); f.timers[1]!.expire();
  expect(f.state.failures).toBe(1); expect(f.revoked.slice(-2)).toEqual([f.a, f.b]);
  f.peer.ack(1);
  expect(await Promise.all([a, b])).toEqual(["UNCONFIRMED", "UNCONFIRMED"]);
  expect(f.writes).toHaveLength(1); expect(f.transport.status(f.authority)).toEqual({ failed: true, queued: 0, inFlight: true, uncertain: true });
});

test("old disarmed timers cannot poison a later healthy operation", async () => {
  const f = fixture(); await f.coordinator.on(f.authority, f.a);
  expect(f.timers[0]!.cancelled).toBe(true); f.state.autoAck = false;
  const pending = outcome(f.coordinator.off(f.authority, f.a)); await Promise.resolve();
  f.timers[0]!.expire(); expect(f.state.failures).toBe(0); f.peer.ack(2); expect(await pending).toBe("ok");
});

test("failure poisons every coordinator entry before timer disarm callbacks can reenter", async () => {
  const f = fixture(); await f.coordinator.on(f.authority, f.a); await f.coordinator.on(f.authority, f.b);
  const a = await f.coordinator.usageVersion(f.a), b = await f.coordinator.usageVersion(f.b), observed: boolean[] = [];
  f.state.autoAck = false;
  const pending = outcome(f.coordinator.off(f.authority, f.a)); await Promise.resolve();
  f.state.disarmHook = () => { observed.push(!f.coordinator.usageCurrent(f.a, a.epoch) && !f.coordinator.usageCurrent(f.b, b.epoch)); };
  f.peer.eof(); expect(observed).toEqual([true]); expect(await pending).toBe("UNCONFIRMED");
});

test("failure callback throws or reenters only after its real coordinator cohort is already poisoned", async () => {
  for (const mode of ["throw", "reenter", "promise"] as const) {
    const f = fixture(); await f.coordinator.on(f.authority, f.a); await f.coordinator.on(f.authority, f.b);
    let nested: Promise<string> | undefined;
    f.state.failureHook = () => {
      if (mode === "throw") throw new Error("private-callback");
      if (mode === "promise") return Promise.reject(new Error("ordinary-private-promise"));
      f.transport.fail(f.authority); nested = outcome(f.transport.store.commit(f.a, record())); f.peer.ack(1);
    };
    f.peer.error(); expect(f.state.failures).toBe(1);
    expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(false); expect((await f.coordinator.usageVersion(f.b)).enabled).toBe(false);
    if (nested) expect(await nested).toBe("UNCONFIRMED");
    expect(f.writes).toHaveLength(2); await Promise.resolve();
  }
});

test("clock callback cannot pre-authorize an ACK before any frame was sent", async () => {
  const f = fixture(); let once = false;
  f.state.clockHook = () => { if (!once) { once = true; f.peer.ack(1); } };
  expect(await outcome(f.coordinator.on(f.authority, f.a))).toBe("UNCONFIRMED");
  expect(f.state.failures).toBe(1); expect(f.writes).toHaveLength(0);
});

test("nonfinite or backward clock failures are sticky and cannot revive the channel", async () => {
  for (const invalid of [99, NaN, Infinity]) {
    const f = fixture(); await f.coordinator.on(f.authority, f.a); await f.coordinator.on(f.authority, f.b);
    f.state.clock = invalid;
    expect(await outcome(f.coordinator.off(f.authority, f.a))).toBe("UNCONFIRMED");
    f.state.clock = 100;
    expect(await outcome(f.coordinator.on(f.authority, f.b))).toBe("UNCONFIRMED");
    expect(f.state.failures).toBe(1); expect(f.writes).toHaveLength(2);
  }
});

test("record and configuration snapshots reject accessors sparse mappings and unknown aliases without work", async () => {
  const f = fixture(); let effects = 0;
  const getter = Object.defineProperty({ instance: "a".repeat(64), enabled: true }, "epoch", { enumerable: true, get() { effects++; return 1; } });
  expect(await outcome(f.transport.store.commit(f.a, getter as ReadUsageRecord))).toBe("INVALID");
  expect(await outcome(f.transport.store.commit(f.a, { ...record(), secret: "private" } as ReadUsageRecord))).toBe("INVALID");
  const mutable = { ...record() }; const pending = outcome(f.transport.store.commit(f.a, mutable));
  mutable.enabled = false; mutable.epoch = 999;
  expect(await pending).toBe("ok"); expect(f.writes[0]!.record).toEqual(record()); expect(effects).toBe(0);
  let subscriptions = 0;
  const base = { ownerAuthority: {}, channel: { subscribe() { subscriptions++; }, write: async () => {} }, onFailure() {} };
  for (const mappings of [[{ conversation: {}, slot: 3 }], [{ conversation: {}, slot: 0 }, { conversation: {}, slot: 0 }], new Array(1)])
    expect(() => createReadUsageStoreTransport({ ...base, mappings })).toThrow(ReadUsageTransportError);
  expect(subscriptions).toBe(0);
});

test("incoming shared buffers and own getter aliases cannot become acknowledgements", async () => {
  for (const shared of [false, true]) {
    const f = fixture(); f.state.autoAck = false; let effects = 0;
    const pending = outcome(f.coordinator.on(f.authority, f.a)); await f.sent.promise;
    const bytes = shared ? new Uint8Array(new SharedArrayBuffer(16)) : Object.defineProperty(new Uint8Array(16), "buffer", { get() { effects++; return new ArrayBuffer(16); } });
    f.peer.data(bytes); expect(await pending).toBe("UNCONFIRMED"); expect(effects).toBe(0); expect(f.state.failures).toBe(1);
  }
});

test("disarm-time EOF refuses a previously staged ACK instead of reporting durable on", async () => {
  const f = fixture(); f.state.disarmHook = () => { f.peer.eof(); };
  expect(await outcome(f.coordinator.on(f.authority, f.a))).toBe("UNCONFIRMED");
  expect(f.state.failures).toBe(1); expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(false);
});
