import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadViewDelivery, ReadDeliveryError, type AccountedReadObservationLease,
  type DeliveryWriteReceipt, type DeliveryStopReceipt, type ReadDeliveryOptions } from "../src/read-view-delivery";
import { ReadResourceBudget } from "../src/multi-view-read-budget";
import { ReadViewRegistry, type ReadObservationLease, type ReadRecipient } from "../src/multi-view-views";
import { Sessions } from "../src/session";
import { NativeBackend } from "../src/hyprland";
import { internalCaller, type Caller } from "../src/caller";

const secret = "PRIVATE-pixels-command-path-token";
async function flush() { for (let step = 0; step < 10; step++) await Promise.resolve(); }
function fixture(bytes: Uint8Array<ArrayBufferLike> = new Uint8Array([1, 2, 3])) {
  const abort = new AbortController(); let payload: Uint8Array | undefined = bytes;
  const state = { now: 1000, allowed: true, writes: 0, stops: 0, releases: 0, reservations: 0, creditReleases: 0,
    scratch: 0, peakScratch: 0, reads: 0, disarms: 0, creditError: false, releaseError: false,
    wake: undefined as (() => void) | undefined, stop: undefined as Readonly<DeliveryStopReceipt> | undefined,
    loan: undefined as { copy?: Uint8Array; length: number; receipt: Readonly<DeliveryWriteReceipt> } | undefined,
    lengths: [] as number[] };
  let reserveHook = () => {};
  const lease: AccountedReadObservationLease = {
    get bytes() { state.reads++; return payload!; },
    reserveDelivery(count) {
      if (state.scratch !== 0 || count < 1 || count > 65536) throw new Error(secret);
      state.reservations++; state.scratch += count; state.peakScratch = Math.max(state.scratch, state.peakScratch);
      reserveHook(); let released = false;
      return Object.freeze({ release() {
        if (released) return false;
        state.creditReleases++; expect(state.loan?.copy).toBeUndefined();
        if (state.creditError) throw new Error(secret);
        released = true; state.scratch -= count; return true;
      } });
    },
    release() {
      state.releases++; expect(state.scratch).toBe(0); expect(state.loan?.copy).toBeUndefined();
      if (state.releaseError) throw new Error(secret); payload = undefined;
    },
  };
  let writer = () => { const current = state.loan!; current.copy = undefined; current.receipt.complete(current.length); };
  let stopper = () => {};
  const options: ReadDeliveryOptions = { lease, deadline: 2000, signal: abort.signal,
    canDispatch: (deadline, signal) => state.allowed && state.now < deadline && !signal.aborted,
    now: () => state.now, arm: (_ms, wake) => { state.wake = wake; return () => { state.disarms++; state.wake = undefined; }; },
    sink: { write(copy, receipt) {
      state.writes++; state.lengths.push(copy.byteLength); state.loan = { copy, receipt, length: copy.byteLength };
      expect(state.scratch).toBe(copy.buffer.byteLength); writer();
    }, stop(receipt) { state.stops++; state.stop = receipt; stopper(); } },
  };
  const complete = (count = state.loan!.length) => { const loan = state.loan!; loan.copy = undefined; return loan.receipt.complete(count); };
  const stopped = () => { if (state.loan) state.loan.copy = undefined; return state.stop!.stopped(); };
  return { options, lease, state, abort, complete, stopped,
    writer: (callback: () => void) => { writer = callback; }, stopper: (callback: () => void) => { stopper = callback; },
    reserveHook: (callback: () => void) => { reserveHook = callback; } };
}

test("construction is inert and one accounted copy releases scratch then original exactly once", async () => {
  const f = fixture(), delivery = createReadViewDelivery(f.options);
  expect(f.state).toMatchObject({ writes: 0, reservations: 0, releases: 0, reads: 0 });
  expect(await delivery.run()).toEqual({ phase: "released", code: "DELIVERED", acceptedBytes: 3, scratchHeld: false });
  expect(f.state).toMatchObject({ writes: 1, reservations: 1, creditReleases: 1, releases: 1, scratch: 0, disarms: 1 });
  await delivery.run(); await delivery.close(); expect(f.state.releases).toBe(1);
});

test("each <=64KiB sink buffer is a distinct isolated copy, not a view into the original frame", async () => {
  const original = new Uint8Array(65537); original[65536] = 253;
  const f = fixture(original); f.writer(() => {
    const copy = f.state.loan!.copy!;
    expect(copy.buffer).not.toBe(original.buffer); expect(copy.byteOffset).toBe(0);
    expect(copy.buffer.byteLength).toBe(copy.byteLength); expect(copy.byteLength).toBeLessThanOrEqual(65536);
    if (f.state.writes === 1) expect(new Uint8Array(copy.buffer)).toHaveLength(65536);
    else expect([...copy]).toEqual([253]);
    f.complete();
  });
  expect((await createReadViewDelivery(f.options).run()).code).toBe("DELIVERED");
  expect(f.state.lengths).toEqual([65536, 1]); expect(f.state.peakScratch).toBe(65536);
});

test("one MiB uses exactly sixteen sequential charged copies", async () => {
  const f = fixture(new Uint8Array(1048576));
  expect((await createReadViewDelivery(f.options).run()).acceptedBytes).toBe(1048576);
  expect(f.state).toMatchObject({ writes: 16, reservations: 16, creditReleases: 16, releases: 1, scratch: 0 });
});

test("backpressure retains exactly one loan and its credit until terminal receipt", async () => {
  const f = fixture(new Uint8Array(65537)); f.writer(() => {});
  const delivery = createReadViewDelivery(f.options), pending = delivery.run();
  expect(f.state).toMatchObject({ writes: 1, reservations: 1, scratch: 65536, releases: 0 });
  await flush(); expect(f.state.writes).toBe(1);
  f.complete(); await flush(); expect(f.state).toMatchObject({ writes: 2, reservations: 2, creditReleases: 1, scratch: 1 });
  f.complete(); expect((await pending).phase).toBe("released");
});

test("same lease cannot get duplicate controllers before or after completion", async () => {
  const f = fixture(), delivery = createReadViewDelivery(f.options);
  expect(() => createReadViewDelivery(f.options)).toThrow(ReadDeliveryError);
  await delivery.run(); expect(() => createReadViewDelivery(f.options)).toThrow(ReadDeliveryError);
});

test("ownership is claimed before a reentrant constructor clock callback", async () => {
  const f = fixture(); let calls = 0;
  f.options.now = () => { calls++; expect(() => createReadViewDelivery(f.options)).toThrow(ReadDeliveryError); return 1000; };
  const delivery = createReadViewDelivery(f.options); expect(calls).toBe(1);
  f.options.now = () => 1000; expect((await delivery.run()).phase).toBe("released");
});

test("failed constructor clock validation rolls back ownership without releasing caller lease", async () => {
  const f = fixture(); f.options.now = () => { throw new Error(secret); };
  expect(() => createReadViewDelivery(f.options)).toThrow(ReadDeliveryError); expect(f.state.releases).toBe(0);
  f.options.now = () => 1000; expect((await createReadViewDelivery(f.options).run()).code).toBe("DELIVERED");
});

test("options sink lease accessors and proxies are refused without invoking getters or traps", () => {
  for (const site of ["options", "sink", "lease"]) {
    const f = fixture(); let calls = 0;
    const value = site === "options" ? f.options : site === "sink" ? f.options.sink : f.lease;
    const key = site === "options" ? "canDispatch" : site === "sink" ? "write" : "reserveDelivery";
    Object.defineProperty(value, key, { get() { calls++; throw new Error(secret); } });
    expect(() => createReadViewDelivery(f.options)).toThrow(ReadDeliveryError); expect(calls).toBe(0);
  }
  const f = fixture(); let traps = 0;
  const options = new Proxy(f.options, { ownKeys() { traps++; return []; } });
  expect(() => createReadViewDelivery(options)).toThrow(ReadDeliveryError); expect(traps).toBe(0);
});

test("constructor dependency snapshots cannot be redirected from the scheduling callback", async () => {
  const f = fixture(); let redirected = 0;
  f.options.now = () => { f.options.sink.write = () => { redirected++; }; f.options.canDispatch = () => false; return 1000; };
  expect((await createReadViewDelivery(f.options).run()).code).toBe("DELIVERED");
  expect(f.state.writes).toBe(1); expect(redirected).toBe(0);
});

test("close before run and already aborted admission never allocate copies or write", async () => {
  for (const mode of ["close", "abort"]) {
    const f = fixture(); if (mode === "abort") f.abort.abort();
    const delivery = createReadViewDelivery(f.options), outcome = await (mode === "close" ? delivery.close() : delivery.run());
    expect(outcome).toMatchObject({ phase: "released", code: "CANCELLED", scratchHeld: false });
    expect(f.state).toMatchObject({ writes: 0, reservations: 0, releases: 1 });
  }
});

test("strict deadline and byte caps refuse before any sink allocation", async () => {
  for (const deadline of [NaN, Infinity, 4001, true]) {
    const f = fixture(); expect(() => createReadViewDelivery({ ...f.options, deadline: deadline as number })).toThrow(ReadDeliveryError);
  }
  for (const bytes of [new Uint8Array(0), new Uint8Array(1048577), new Uint8Array(new SharedArrayBuffer(3)), new Uint8Array(new ArrayBuffer(7), 1, 3)]) {
    const f = fixture(bytes); expect((await createReadViewDelivery(f.options).run()).code).toBe("INVALID");
    expect(f.state.reservations).toBe(0); expect(f.state.writes).toBe(0);
  }
});

test("combined dispatch guard denies revoked expired or aborted state after copy and before write", async () => {
  for (const mode of ["revoke", "expire", "abort"]) {
    const f = fixture(); f.reserveHook(() => {
      if (mode === "revoke") f.state.allowed = false;
      if (mode === "expire") f.state.now = 2000;
      if (mode === "abort") f.abort.abort();
    });
    const outcome = await createReadViewDelivery(f.options).run();
    expect(outcome.code).not.toBe("DELIVERED"); expect(f.state).toMatchObject({ writes: 0, reservations: 1, creditReleases: 1, releases: 1, scratch: 0 });
  }
});

test("scheduling clock revocation is checked by combined boundary before dispatch", async () => {
  const f = fixture(); let armed = false;
  f.options.now = () => { if (armed) f.state.allowed = false; return 1000; };
  const delivery = createReadViewDelivery(f.options); armed = true;
  expect((await delivery.run()).code).toBe("DENIED"); expect(f.state.writes).toBe(0);
});

test("reentrant guard close and repeated run cannot create a duplicate write", async () => {
  const f = fixture(); let delivery: ReturnType<typeof createReadViewDelivery>, armed = false;
  f.options.canDispatch = () => { if (armed) { expect(delivery.run()).toBe(delivery.close()); } return true; };
  delivery = createReadViewDelivery(f.options); armed = true;
  expect((await delivery.run()).code).toBe("CANCELLED"); expect(f.state.writes).toBe(0);
});

test("copy failure before sink visibility returns scratch credit safely", async () => {
  const original = new Uint8Array([1, 2, 3]), f = fixture(original);
  f.reserveHook(() => { structuredClone(original.buffer, { transfer: [original.buffer] }); });
  expect((await createReadViewDelivery(f.options).run()).phase).toBe("released");
  expect(f.state).toMatchObject({ reservations: 1, creditReleases: 1, writes: 0, releases: 1, scratch: 0 });
});

test("reservation callback cannot redirect copying by replacing mutable Uint8Array.set", async () => {
  const f = fixture(), original = Uint8Array.prototype.set;
  f.reserveHook(() => { Uint8Array.prototype.set = (() => { throw new Error(secret); }) as typeof original; });
  try { expect((await createReadViewDelivery(f.options).run()).code).toBe("DELIVERED"); }
  finally { Uint8Array.prototype.set = original; }
  expect(f.state).toMatchObject({ reservations: 1, creditReleases: 1, releases: 1 });
});

test("reservation failure has no uncharged copy or sink loan", async () => {
  const f = fixture(); f.lease.reserveDelivery = () => { throw new Error(secret); };
  const outcome = await createReadViewDelivery(f.options).run();
  expect(JSON.stringify(outcome)).not.toContain(secret); expect(f.state).toMatchObject({ writes: 0, reservations: 0, releases: 1 });
});

test("abort in a pending write retains both frame and scratch until terminal stop proof", async () => {
  const f = fixture(); f.writer(() => {}); const delivery = createReadViewDelivery(f.options), run = delivery.run();
  f.abort.abort(); const snapshot = await run;
  expect(snapshot).toEqual({ phase: "quarantined", code: "CANCELLED", acceptedBytes: 0, scratchHeld: true });
  expect(f.state).toMatchObject({ releases: 0, creditReleases: 0, scratch: 3, stops: 1 });
  f.stopped(); await flush(); expect(delivery.status()).toEqual({ phase: "released", code: "CANCELLED", acceptedBytes: 0, scratchHeld: false });
  expect(f.state).toMatchObject({ releases: 1, creditReleases: 1, scratch: 0 }); expect(snapshot.phase).toBe("quarantined");
});

test("absolute timeout is not a sink stop receipt", async () => {
  const f = fixture(); f.writer(() => {}); const delivery = createReadViewDelivery(f.options), run = delivery.run();
  f.state.now = 2000; f.state.wake!(); expect((await run).phase).toBe("quarantined");
  expect(f.state).toMatchObject({ scratch: 3, releases: 0, creditReleases: 0 });
  f.stopped(); await flush(); expect(f.state.releases).toBe(1);
});

test("late acceptance updates eventual status only and cannot resume cancelled delivery", async () => {
  const f = fixture(new Uint8Array(65537)); f.writer(() => {});
  const delivery = createReadViewDelivery(f.options), run = delivery.run(); f.abort.abort(); const old = await run;
  expect(f.complete()).toBe(true); await flush();
  expect(delivery.status()).toEqual({ phase: "quarantined", code: "CANCELLED", acceptedBytes: 65536, scratchHeld: true });
  expect(f.state).toMatchObject({ releases: 0, creditReleases: 0 });
  f.stopped(); await flush();
  expect(delivery.status()).toEqual({ phase: "released", code: "CANCELLED", acceptedBytes: 65536, scratchHeld: false });
  expect(old.acceptedBytes).toBe(0); expect(f.state.writes).toBe(1); expect(await delivery.run()).toBe(old);
  expect(f.complete()).toBe(false); expect(f.state.releases).toBe(1);
});

test("write completion cannot settle aliases captured by an asynchronous stop operation", async () => {
  const f = fixture(); f.writer(() => {}); let stopAlias: Uint8Array | undefined;
  f.stopper(() => { stopAlias = f.state.loan!.copy; });
  const delivery = createReadViewDelivery(f.options), running = delivery.run(); f.abort.abort(); await running;
  expect(stopAlias?.byteLength).toBe(3); f.complete(); await flush();
  expect(delivery.status()).toMatchObject({ phase: "quarantined", scratchHeld: true, acceptedBytes: 3 });
  expect(f.state).toMatchObject({ scratch: 3, releases: 0, creditReleases: 0 });
  stopAlias = undefined; f.stopped(); await flush();
  expect(delivery.status()).toMatchObject({ phase: "released", scratchHeld: false });
  expect(f.state).toMatchObject({ scratch: 0, releases: 1, creditReleases: 1 });
});

test("duplicate late callbacks cannot release twice or revive writes", async () => {
  const f = fixture(); f.writer(() => {}); const delivery = createReadViewDelivery(f.options), run = delivery.run();
  f.abort.abort(); await run; const receipt = f.state.loan!.receipt;
  expect(f.stopped()).toBe(true); expect(f.state.stop!.stopped()).toBe(false);
  expect(receipt.complete(3)).toBe(false); expect(receipt.unknown()).toBe(false);
  await flush(); await delivery.close(); expect(f.state).toMatchObject({ writes: 1, releases: 1, creditReleases: 1, stops: 1 });
});

test("partial completion is not retried and drained copy is released", async () => {
  const f = fixture(); f.writer(() => { f.complete(1); });
  expect(await createReadViewDelivery(f.options).run()).toMatchObject({ phase: "released", code: "SINK", acceptedBytes: 1, scratchHeld: false });
  expect(f.state).toMatchObject({ writes: 1, releases: 1, creditReleases: 1 });
});

test("sink throw invalid receipt or explicit unknown cannot release live copies", async () => {
  for (const mode of ["throw", "invalid", "unknown"]) {
    const f = fixture(); f.writer(() => {
      if (mode === "throw") throw new Error(secret);
      if (mode === "invalid") f.state.loan!.receipt.complete(4); else f.state.loan!.receipt.unknown();
    });
    const delivery = createReadViewDelivery(f.options), outcome = await delivery.run();
    expect(outcome.phase).toBe("quarantined"); expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(f.state).toMatchObject({ releases: 0, creditReleases: 0, scratch: 3 }); f.stopped(); await flush();
  }
});

test("promise resolution without callback proof is not terminal sink drain", async () => {
  const f = fixture(); f.options.sink.write = (() => Promise.resolve()) as unknown as typeof f.options.sink.write;
  const delivery = createReadViewDelivery(f.options), outcome = await delivery.run();
  expect(outcome).toMatchObject({ phase: "quarantined", code: "SINK", scratchHeld: true });
  expect(f.state.creditReleases).toBe(0); f.state.stop!.stopped(); await flush(); expect(f.state.releases).toBe(1);
});

test("stop throw and unknown receipt hold aliases and never retry stop", async () => {
  for (const mode of ["throw", "unknown"]) {
    const f = fixture(); f.writer(() => {}); f.stopper(() => { if (mode === "throw") throw new Error(secret); f.state.stop!.unknown(); });
    const delivery = createReadViewDelivery(f.options), run = delivery.run(); f.abort.abort(); await run; await delivery.close();
    expect(f.state).toMatchObject({ scratch: 3, stops: 1, releases: 0 }); f.stopped(); await flush();
  }
});

test("late credit cleanup failure remains quarantined and visible in eventual status", async () => {
  const f = fixture(); f.writer(() => {}); const delivery = createReadViewDelivery(f.options), run = delivery.run();
  f.abort.abort(); const old = await run; f.state.creditError = true; f.stopped(); await flush();
  expect(delivery.status()).toMatchObject({ phase: "quarantined", code: "CLEANUP", scratchHeld: true });
  expect(old.code).toBe("CANCELLED"); expect(f.state.releases).toBe(0); expect(f.state.creditReleases).toBe(1);
  await delivery.close(); expect(f.state.creditReleases).toBe(1);
});

test("native abort during disarm after listener removal cannot become DELIVERED", async () => {
  const f = fixture(); f.options.arm = () => () => { f.abort.abort(); };
  expect((await createReadViewDelivery(f.options).run()).code).toBe("CANCELLED"); expect(f.state.releases).toBe(1);
});

test("actual registry result charges frame plus copy and preserves both through revoke until stop", async () => {
  const owner = {}, budget = new ReadResourceBudget();
  const recipient: ReadRecipient = { owner: {}, connector: {}, instance: {}, conversation: {}, channel: {}, pid: 123, birth: "456" };
  const registry = new ReadViewRegistry({ ownerAuthority: owner, budget, now: () => 1000, backend: {
    admissionReady: () => true, recipientCurrent: () => true, bindingCurrent: () => true,
    prepare: () => ({ cost: { scratchBytes: 8, retainedBytes: 8 }, capture: async context => {
      context.lifecycle.confirmStopped(true); return new Uint8Array([1, 2, 3]);
    } }),
  } });
  registry.setEnabled(owner, true); const grant = registry.enroll(owner, { recipient, consentEpoch: 1, expiresAt: 2000,
    views: [{ binding: {}, bindingEpoch: 1, formats: ["image"] }] });
  const lease = await registry.read(recipient, grant.grant, grant.views[0]!.id, "image"), f = fixture();
  f.options.lease = lease; f.options.sink.write = (_copy, receipt) => { f.state.loan = { receipt, length: 3 }; };
  const delivery = createReadViewDelivery(f.options), pending = delivery.run();
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 11, retainedReferences: 1 });
  f.abort.abort(); expect((await pending).phase).toBe("quarantined"); registry.revoke(owner, grant.grant);
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 11 });
  f.state.stop!.stopped(); await flush(); expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, views: 0 });
});

test("real lease reentrant release during bytes or delivery reservation cannot use surviving internal reference", async () => {
  for (const mode of ["bytes", "reserve"]) {
    const owner = {}, budget = new ReadResourceBudget();
    const recipient: ReadRecipient = { owner: {}, connector: {}, instance: {}, conversation: {}, channel: {}, pid: 123, birth: "456" };
    let lease: ReadObservationLease | undefined, armed = false;
    let reservation: ReturnType<ReadResourceBudget["reserve"]> | undefined;
    const original = ReadResourceBudget.prototype.reserve;
    const reserve = spyOn(ReadResourceBudget.prototype, "reserve").mockImplementation(function (this: ReadResourceBudget,
      view: Parameters<ReadResourceBudget["reserve"]>[0], cost: Parameters<ReadResourceBudget["reserve"]>[1]) {
      const handle = original.call(this, view, cost); if (this === budget) reservation = handle; return handle;
    });
    const registry = new ReadViewRegistry({ ownerAuthority: owner, budget, now: () => 1000, backend: {
      admissionReady: () => true, recipientCurrent: () => true,
      bindingCurrent: () => { if (armed && lease) { armed = false; lease.release(); } return true; },
      prepare: () => ({ cost: { scratchBytes: 8, retainedBytes: 8 }, capture: async context => {
        context.lifecycle.confirmStopped(true); return new Uint8Array([1, 2, 3]);
      } }),
    } });
    try {
      registry.setEnabled(owner, true); const grant = registry.enroll(owner, { recipient, consentEpoch: 1, expiresAt: 2000,
        views: [{ binding: {}, bindingEpoch: 1, formats: ["image"] }] });
      lease = await registry.read(recipient, grant.grant, grant.views[0]!.id, "image");
      budget.retain(reservation!); // A surviving internal ref must not revive a released consumer lease.
      const f = fixture(); let reads = 0;
      const wrapped: AccountedReadObservationLease = {
        get bytes() { const bytes = lease!.bytes; reads++; if (mode === "reserve" && reads === 2) armed = true; return bytes; },
        reserveDelivery: count => lease!.reserveDelivery(count), release: () => lease!.release(),
      };
      if (mode === "bytes") armed = true;
      f.options.lease = wrapped;
      expect((await createReadViewDelivery(f.options).run()).code).not.toBe("DELIVERED");
      expect(f.state.writes).toBe(0); expect(budget.status()).toMatchObject({ entries: 1, bytes: 8, retainedReferences: 1 });
      budget.release(reservation!); expect(budget.status()).toMatchObject({ entries: 0, bytes: 0 });
      registry.revoke(owner, grant.grant);
    } finally { reserve.mockRestore(); }
  }
});

test("prototype descriptor pollution cannot run constructor callbacks or steal lease ownership", async () => {
  for (const missing of ["bytes", "get", "value"]) {
    const f = fixture(), malformed = fixture();
    if (missing === "bytes") Reflect.deleteProperty(malformed.lease, "bytes");
    if (missing === "get") Object.defineProperty(malformed.lease, "bytes", { value: new Uint8Array([1]), configurable: true });
    if (missing === "value") Object.defineProperty(malformed.lease, "release", { get() { throw new Error(secret); }, configurable: true });
    const saved = ["bytes", "get", "value"].map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
    let callbacks = 0, nested: ReturnType<typeof createReadViewDelivery> | undefined, valid: ReturnType<typeof createReadViewDelivery> | undefined;
    let refused = false;
    try {
      for (const key of ["bytes", "get", "value"]) Object.defineProperty(Object.prototype, key, Object.assign(Object.create(null), {
        configurable: true, get() { callbacks++; if (!nested) nested = createReadViewDelivery(f.options); return undefined; },
      }));
      try { createReadViewDelivery(malformed.options); } catch { refused = true; }
      try { valid = createReadViewDelivery(f.options); } catch { /* Assert after restoring native prototype. */ }
    } finally {
      for (const [key] of saved) Reflect.deleteProperty(Object.prototype, key);
      for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(Object.prototype, key, Object.assign(Object.create(null), descriptor));
    }
    if (nested) await nested.close();
    expect(refused).toBe(true); expect(callbacks).toBe(0); expect(valid).toBeDefined();
    expect((await valid!.run()).phase).toBe("released");
  }
});

test("preexisting owner byte aliases are not revoked by a consumer release: exclusive transfer is required", async () => {
  const f = fixture(); let alias: Uint8Array | undefined = f.lease.bytes;
  expect((await createReadViewDelivery(f.options).run()).phase).toBe("released");
  expect([...alias]).toEqual([1, 2, 3]); // This intentionally violates the documented owner contract.
  alias = undefined;
});

test("last original lease release with copy outstanding keeps actual frame and scratch charged", async () => {
  const owner = {}, budget = new ReadResourceBudget();
  const recipient: ReadRecipient = { owner: {}, connector: {}, instance: {}, conversation: {}, channel: {}, pid: 123, birth: "456" };
  const registry = new ReadViewRegistry({ ownerAuthority: owner, budget, now: () => 1000, backend: {
    admissionReady: () => true, recipientCurrent: () => true, bindingCurrent: () => true,
    prepare: () => ({ cost: { scratchBytes: 8, retainedBytes: 8 }, capture: async context => {
      context.lifecycle.confirmStopped(true); return new Uint8Array([1, 2, 3]);
    } }),
  } });
  registry.setEnabled(owner, true); const grant = registry.enroll(owner, { recipient, consentEpoch: 1, expiresAt: 2000,
    views: [{ binding: {}, bindingEpoch: 1, formats: ["image"] }] });
  const lease = await registry.read(recipient, grant.grant, grant.views[0]!.id, "image"), f = fixture();
  f.options.lease = lease; f.options.sink.write = (_copy, receipt) => { f.state.loan = { receipt, length: 3 }; };
  const delivery = createReadViewDelivery(f.options), pending = delivery.run(); lease.release();
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 11, retainedReferences: 0 });
  f.abort.abort(); await pending; registry.revoke(owner, grant.grant);
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 11 });
  f.state.stop!.stopped(); await flush(); expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, views: 0 });
});

test("actual protected Sessions lease supports accounted copy delivery without native fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-copy-delivery-")), ownerIdentity = {}, ownerChannel = {}, channel = {};
  const caller: Caller = { id: "conv:delivery", label: "fixture", role: "agent", kind: "adapter", verified: true, pid: 123, start: "456" };
  const recipient: ReadRecipient = { owner: ownerIdentity, connector: {}, instance: {}, conversation: {}, channel, pid: 123, birth: "456" };
  const sessions = new Sessions(root, undefined, undefined, { planPath: "/fixture/host.json", controlDirectory: join(root, "control") }, join(root, "update"), {
    alive: () => true, readViews: { ownerIdentity, ownerChannel, channels: [{ key: "fixture", channel, recipient, callerId: caller.id }],
      liveProcess: () => true, usageCurrent: () => true, usageVersion: async conversation => ({ conversation, epoch: 1, enabled: true }), now: () => 1000,
      backend: { admissionReady: () => true, recipientCurrent: () => true, bindingCurrent: () => true,
        prepare: () => ({ cost: { scratchBytes: 8, retainedBytes: 8 }, capture: async context => {
          context.lifecycle.confirmStopped(true); return new Uint8Array([4, 5, 6]);
        } }) } },
  });
  const legacy = mock(() => { throw new Error("No native or legacy fallback"); });
  const native = Object.create(NativeBackend.prototype, Object.fromEntries(Object.entries({ capabilities: ["observe"], surface: {},
    handoff: { workspace: 23, appId: "app", selectedWindowId: "window", scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 0, y: 0 },
      windows: [{ appId: "app", windowId: "window", title: secret, width: 200, height: 100 }] },
    onClose: () => {}, close: async () => {}, pauseLease: async () => {}, resumeLease: async () => {}, observe: legacy, observePassive: legacy,
  }).map(([key, value]) => [key, { value, writable: true, configurable: true, enumerable: true }])));
  const create = spyOn(NativeBackend, "create").mockResolvedValue(native);
  try {
    const made = await sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 23, address: "0xa1", stableId: "a1" } } }, caller) as { sessionId: string };
    await sessions.dispatch({ method: "views.enable", params: { enabled: true } }, internalCaller, ownerChannel);
    const grant = await sessions.dispatch({ method: "views.enroll", params: { channelKey: "fixture", expiresAt: 2000,
      views: [{ sessionId: made.sessionId, appId: "app", windowId: "window", formats: ["image"] }] } }, internalCaller, ownerChannel) as { views: { id: string }[] };
    const lease = await sessions.dispatch({ method: "views.read", params: { viewId: grant.views[0]!.id, format: "image" } }, caller, channel) as ReadObservationLease;
    const f = fixture(); f.options.lease = lease;
    // This fake sink's independent ledger belongs to the actual registry, not fixture scratch counters.
    f.options.sink.write = (copy, receipt) => { expect([...copy]).toEqual([4, 5, 6]); expect(copy.buffer.byteLength).toBe(3); receipt.complete(3); };
    expect(await createReadViewDelivery(f.options).run()).toMatchObject({ phase: "released", code: "DELIVERED", acceptedBytes: 3, scratchHeld: false });
    expect(() => lease.bytes).toThrow(); expect(legacy).not.toHaveBeenCalled();
  } finally { create.mockRestore(); await sessions.close(); await sessions.diagnostics.flush(); await rm(root, { recursive: true, force: true }); }
});
