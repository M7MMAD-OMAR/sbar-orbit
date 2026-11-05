import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadUsageCohort, type ReadUsageCohort } from "../src/read-usage-cohort";

// Fixed ACK peer is not a durable service or worker-stop proof. Frame-count
// assertions cover only observed calls, not global no-replay/restart behavior.
const linux = process.platform === "linux" ? test : test.skip;
class UnknownSettlement extends Error {}
type Frame = { id: number; slot: number; record: { instance: string; epoch: number; enabled: boolean } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new UnknownSettlement("Owned cohort fixture settlement unknown")), 2500); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function code(work: () => unknown, expected: string) { let error: unknown; try { work(); } catch (seen) { error = seen; } expect(error).toMatchObject({ code: expected }); }
const retained = new Set<Peer>();
class Peer {
  root?: string;
  server?: Server;
  client?: Socket;
  remote?: Socket;
  cohort?: Readonly<ReadUsageCohort>;
  readonly owner = {};
  readonly a = {};
  readonly b = {};
  readonly frames: Frame[] = [];
  readonly operations = new Set<Promise<unknown>>();
  readonly writes = new Set<Promise<unknown>>();
  readonly socketClosed: Promise<void>[] = [];
  readonly waiters: { count: number; done: ReturnType<typeof deferred<void>> }[] = [];
  readonly connected = deferred<void>();
  autoAck = true;
  closing = false;
  uncertainLifecycle = false;
  listenerState: "none" | "pending" | "listening" | "closed" | "failed" = "none";
  listenerClose?: Promise<void>;
  failure: unknown;
  buffer = Buffer.alloc(0);
  track<T>(set: Set<Promise<unknown>>, p: Promise<T>) { set.add(p); void p.then(() => { set.delete(p); }, () => { set.delete(p); }); return p; }
  watch(socket: Socket) {
    socket.on("error", () => {}); // Observe only, never infer stop from an error.
    this.socketClosed.push(new Promise<void>(resolve => { socket.once("close", () => resolve()); }));
  }
  async setup() {
    this.root = await mkdtemp(join(tmpdir(), "orbit-cohort-")); if (this.closing) throw new Error("Fixture closing");
    const path = join(this.root, "peer.sock");
    const server = createServer(socket => {
      this.remote = socket; this.watch(socket);
      if (this.closing) { socket.end(); return; }
      socket.on("data", bytes => {
        try {
          if (this.closing) return;
          if (this.buffer.length + bytes.length > 8192) throw new Error("Owned frame bound");
          this.buffer = Buffer.concat([this.buffer, bytes]);
          while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32BE(0); if (length < 1 || length > 1024) throw new Error("Owned payload bound");
            if (this.buffer.length < 4+length) break;
            const raw = this.buffer.subarray(4,4+length); this.buffer = this.buffer.subarray(4+length);
            const frame = JSON.parse(raw.toString("ascii")) as Frame;
            expect(frame.id).toBe(this.frames.length+1); expect([0,1]).toContain(frame.slot);
            expect(frame.record.instance).toMatch(/^[0-9a-f]{64}$/); expect(Number.isSafeInteger(frame.record.epoch)).toBe(true);
            expect(typeof frame.record.enabled).toBe("boolean");
            expect(raw.toString("ascii")).toBe(JSON.stringify({ id: frame.id, slot: frame.slot,
              record: { instance: frame.record.instance, epoch: frame.record.epoch, enabled: frame.record.enabled } }));
            this.frames.push(frame);
            for (const waiter of this.waiters) if (this.frames.length >= waiter.count) waiter.done.resolve(undefined);
            if (this.autoAck) void this.ack(frame.id).catch(error => { this.failure = error; });
          }
        } catch (error) { this.failure = error; socket.end(); }
      });
      this.connected.resolve(undefined);
    });
    this.server = server;
    this.listenerState = "pending";
    const listening = this.track(this.operations, new Promise<void>((resolve, reject) => {
      server.once("error", error => { this.listenerState = "failed"; this.uncertainLifecycle = true; reject(error); });
      server.listen(path, () => {
        this.listenerState = "listening"; resolve();
        if (this.closing) void this.stopListener().catch(() => { this.uncertainLifecycle = true; });
      });
    }));
    try { await bounded(listening); } catch (error) { this.uncertainLifecycle = true; throw error; }
    if (this.closing) throw new Error("Fixture closing");
    const client = createConnection({ path }); this.client = client; this.watch(client);
    client.pause();
    // No client data/readable listener or decoding before the actual factory.
    const connecting = this.track(this.operations, new Promise<void>((resolve, reject) => {
      client.once("error", error => { this.uncertainLifecycle = true; reject(error); });
      client.once("connect", () => { client.pause(); resolve(); if (this.closing) client.end(); });
    }));
    try { await bounded(connecting); } catch (error) { this.uncertainLifecycle = true; throw error; }
    await bounded(this.connected.promise);
    if (this.closing) throw new Error("Fixture closing");
  }
  bind(onRevoke: (conversation: object) => void) {
    if (this.closing) throw new Error("Fixture closing");
    const client = this.client; if (!client) throw new Error("Owned socket missing");
    // Actual runtime preconditions, never fabricated Socket properties. These
    // assertions localize a platform mismatch before the cohort masks setup errors.
    expect(Object.getPrototypeOf(client)).toBe(Socket.prototype);
    expect(client.readableEncoding).toBe(null);
    expect(client.readableFlowing).not.toBe(true);
    expect(client.listenerCount("data")).toBe(0); expect(client.listenerCount("readable")).toBe(0);
    expect({ destroyed: client.destroyed, connecting: client.connecting, readable: client.readable, writable: client.writable,
      readableEnded: client.readableEnded, writableEnded: client.writableEnded }).toEqual({ destroyed: false, connecting: false, readable: true, writable: true, readableEnded: false, writableEnded: false });
    const mappings = [{ conversation: this.a, slot: 0 }, { conversation: this.b, slot: 1 }];
    const cohort = createReadUsageCohort({ ownerAuthority: this.owner, socket: client, mappings, onRevoke, deadlineMs: 1500 });
    this.cohort = cohort; return cohort;
  }
  op(promise: Promise<void>) { return this.track(this.operations, promise); }
  async seen(count: number) {
    if (this.failure) throw this.failure;
    if (this.frames.length < count) { const done = deferred<void>(); this.waiters.push({ count, done }); await bounded(done.promise); }
    if (this.failure) throw this.failure;
    const frame = this.frames[count-1]; if (!frame) throw new Error("Expected actual frame missing"); return frame;
  }
  ack(id: number) {
    const socket = this.remote; if (!socket || this.closing) return Promise.reject(new Error("Owned peer unavailable"));
    const payload = Buffer.from(JSON.stringify({ id, ok: true }), "ascii"), frame = Buffer.alloc(4+payload.length);
    frame.writeUInt32BE(payload.length,0); payload.copy(frame,4);
    return this.track(this.writes, new Promise<void>((resolve, reject) => { socket.write(frame, error => error ? reject(error) : resolve()); }));
  }
  stopListener(): Promise<void> {
    if (this.listenerClose) return this.listenerClose;
    const server = this.server;
    if (!server && this.listenerState === "none") return Promise.resolve();
    if (!server || this.listenerState !== "listening") return Promise.reject(new UnknownSettlement("Listener startup not confirmed"));
    const closing = new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) { this.uncertainLifecycle = true; reject(error); }
        else { this.listenerState = "closed"; resolve(); }
      });
    });
    this.listenerClose = closing; void closing.catch(() => {}); return closing;
  }
  async close() {
    this.closing = true;
    try {
      this.cohort?.fail(this.owner); // Logical refusal only, never a writer-stop claim.
      if (this.uncertainLifecycle || this.listenerState === "pending" || this.listenerState === "failed") throw new UnknownSettlement("Startup/work uncertainty is sticky");
      await bounded(Promise.allSettled([...this.operations, ...this.writes]));
      const ended = this.stopListener();
      void ended.catch(() => {});
      // End only our exact sockets and await real close events. No PID/process.
      if (this.client && !this.client.destroyed) this.client.end();
      if (this.remote && !this.remote.destroyed) this.remote.end();
      await bounded(Promise.all(this.socketClosed)); await bounded(ended);
      await bounded(Promise.allSettled([...this.operations, ...this.writes]));
      if (this.uncertainLifecycle || this.listenerState !== "closed") throw new UnknownSettlement("Listener close not confirmed");
    } catch {
      retained.add(this); this.server?.unref(); this.client?.unref(); this.remote?.unref();
      throw new Error("Owned cohort sockets/root retained; cleanup unknown");
    }
    if (this.failure) { if (this.root) await rm(this.root,{recursive:true,force:true}); throw this.failure; }
    if (this.root) await rm(this.root,{recursive:true,force:true});
  }
}
async function fixture(work: (peer: Peer) => Promise<void>) {
  const peer = new Peer(); let primary: unknown, failed = false;
  try { await bounded(peer.track(peer.operations, peer.setup())); await bounded(peer.track(peer.operations, Promise.resolve().then(() => work(peer)))); } catch (error) { primary = error; failed = true; if (error instanceof UnknownSettlement) peer.uncertainLifecycle = true; }
  try { await peer.close(); } catch (cleanup) { if (failed) throw new AggregateError([primary,cleanup],"Cohort fixture and cleanup failed"); throw cleanup; }
  if (failed) throw primary;
}

linux("actual Unix cohort dense on/off ACKs and synchronous off fence use exact owner", () => fixture(async f => {
  const revoked: object[] = [], c = f.bind(conversation => { revoked.push(conversation); });
  code(() => c.on({},f.a),"DENIED"); code(() => c.off({},f.a),"DENIED"); code(() => c.fail({}),"DENIED");
  expect(f.frames).toHaveLength(0); expect((await c.usageVersion(f.a)).enabled).toBe(false);
  f.autoAck=false; const on = f.op(c.on(f.owner,f.a));
  const first=await f.seen(1); expect(first.slot).toBe(0); expect(first.record.enabled).toBe(true);
  expect((await c.usageVersion(f.a)).enabled).toBe(false);
  await f.ack(first.id); await bounded(on);
  const a=await c.usageVersion(f.a); expect(a.enabled).toBe(true); expect(c.usageCurrent(f.a,a.epoch)).toBe(true);
  f.autoAck=true; await bounded(f.op(c.on(f.owner,f.b)));
  const b=await c.usageVersion(f.b); expect(b.enabled).toBe(true); expect((await f.seen(2)).slot).toBe(1);
  f.autoAck=false; let settled=false; const off=f.op(c.off(f.owner,f.a)); void off.then(()=>{settled=true;},()=>{settled=true;});
  expect(c.usageCurrent(f.a,a.epoch)).toBe(false); expect(revoked.at(-1)).toBe(f.a);
  const third=await f.seen(3); expect(third.slot).toBe(0); expect(third.record.enabled).toBe(false); expect(settled).toBe(false);
  expect(third.record.epoch).toBeGreaterThan(first.record.epoch); expect(third.record.instance).toBe(first.record.instance);
  await f.ack(third.id); await bounded(off); expect((await c.usageVersion(f.a)).enabled).toBe(false);
  expect(c.usageCurrent(f.b,b.epoch)).toBe(true);
}),10000);

linux("actual Unix delayed ACK then peer EOF poisons the whole cohort without replay", () => fixture(async f => {
  const c=f.bind(()=>{}); await bounded(f.op(c.on(f.owner,f.a))); await bounded(f.op(c.on(f.owner,f.b)));
  const a=await c.usageVersion(f.a), b=await c.usageVersion(f.b);
  f.autoAck=false; const delayed=f.op(c.on(f.owner,f.a)); await f.seen(3);
  expect(c.usageCurrent(f.a,a.epoch)).toBe(false); expect(c.usageCurrent(f.b,b.epoch)).toBe(true);
  const remote=f.remote; if(!remote)throw new Error("Owned peer missing"); remote.end();
  await expect(bounded(delayed)).rejects.toMatchObject({code:"UNCONFIRMED"});
  expect(c.usageCurrent(f.b,b.epoch)).toBe(false); expect((await c.usageVersion(f.b)).enabled).toBe(false);
  await expect(f.op(c.on(f.owner,f.b))).rejects.toMatchObject({code:"UNCONFIRMED"});
  await expect(f.op(c.off(f.owner,f.a))).rejects.toMatchObject({code:"UNCONFIRMED"});
  expect(f.frames).toHaveLength(3);
  // Actual socket EOF, not merely a coordinator-local timer, fences this cohort.
}),10000);

linux("actual Unix cohort callback fault synchronously disables every conversation", () => fixture(async f => {
  let fault=false; const c=f.bind(()=>{if(fault)throw new Error("PRIVATE-revocation-fault");});
  await bounded(f.op(c.on(f.owner,f.a))); await bounded(f.op(c.on(f.owner,f.b)));
  const a=await c.usageVersion(f.a), b=await c.usageVersion(f.b); fault=true;
  const off=f.op(c.off(f.owner,f.a)); expect(c.usageCurrent(f.a,a.epoch)).toBe(false); expect(c.usageCurrent(f.b,b.epoch)).toBe(false);
  await expect(off).rejects.toMatchObject({code:"UNCONFIRMED"});
  await expect(f.op(c.on(f.owner,f.b))).rejects.toMatchObject({code:"UNCONFIRMED"});
  expect((await c.usageVersion(f.a)).enabled).toBe(false); expect((await c.usageVersion(f.b)).enabled).toBe(false);
}),10000);

// Pure per-test Socket-shaped boundary, NOT a real descriptor or adoption proof.
function mockSocket(mode: "healthy" | "ended" | "install-error" | "resume-eof" | "resume-error" = "healthy") {
  const emitter = new EventEmitter(), written = deferred<Buffer>(), frames: Buffer[] = [];
  const state = { closed: 0, ended: 0, pauses: 0, resumes: 0, writes: 0 };
  let socket: Socket;
  const values = {
    destroyed: false, connecting: false, readable: mode !== "ended", writable: true,
    readableEnded: mode === "ended", writableEnded: false, readableEncoding: null, readableFlowing: false,
    listenerCount: (name: string) => emitter.listenerCount(name),
    on: (name: string, callback: (...args: unknown[]) => void) => { if (mode === "install-error" && name === "data") throw new Error("PRIVATE-install"); emitter.on(name, callback); return socket; },
    prependListener: (name: string, callback: (...args: unknown[]) => void) => { emitter.prependListener(name, callback); return socket; },
    pause: () => { state.pauses++; return socket; },
    resume: () => { state.resumes++; if (mode === "resume-error") throw new Error("PRIVATE-resume"); if (mode === "resume-eof") emitter.emit("end"); return socket; },
    destroy: () => { state.closed++; return socket; }, end: () => { state.ended++; return socket; },
    write: (bytes: Uint8Array, callback: (error?: Error | null) => void) => { state.writes++; frames.push(Buffer.from(bytes)); written.resolve(Buffer.from(bytes)); callback(); return true; },
  };
  socket = Object.create(Socket.prototype, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, configurable: true, writable: true }])));
  return { socket, emitter, state, written, frames };
}

test("cohort synchronous channel setup/subscription failure never publishes or closes owner socket", () => {
  for (const mode of ["ended", "install-error", "resume-eof", "resume-error"] as const) {
    const f = mockSocket(mode), owner = {}, a = {}, b = {}, revoked: object[] = [];
    code(() => createReadUsageCohort({ ownerAuthority: owner, socket: f.socket,
      mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }], onRevoke(value) { revoked.push(value); } }), "UNCONFIRMED");
    expect(revoked).toEqual([a,b]); expect(revoked[0]).toBe(a); expect(revoked[1]).toBe(b);
    expect(f.state.closed).toBe(0); expect(f.state.ended).toBe(0); expect(f.state.writes).toBe(0);
    f.emitter.emit("error", new Error("PRIVATE-late-owner-error")); f.emitter.emit("end");
    expect(revoked).toHaveLength(2); // Sticky, exact once per registered identity.
  }
});

test("invalid mapping and accessor snapshots refuse before touching any socket member", () => {
  const owner = {}, a = {}, b = {}; let touched = 0, getters = 0;
  const socket = new Proxy({}, { get() { touched++; throw new Error("Socket touched before validation"); } });
  const entryGetter = Object.defineProperty({ conversation: a }, "slot", { enumerable: true, get() { getters++; return 0; } });
  const arrayGetter = Object.defineProperty(new Array(1), "0", { enumerable: true, get() { getters++; return { conversation: a, slot: 0 }; } });
  for (const mappings of [
    [{ conversation: a, slot: 0 }, { conversation: a, slot: 1 }],
    [{ conversation: a, slot: 0 }, { conversation: b, slot: 0 }],
    [{ conversation: a, slot: 1 }], [entryGetter], arrayGetter,
  ]) {
    code(() => Reflect.apply(createReadUsageCohort, undefined, [{ ownerAuthority: owner, socket, mappings, onRevoke() {} }]), "INVALID");
  }
  const topGetter = Object.defineProperty({ ownerAuthority: owner, socket, mappings: [{ conversation: a, slot: 0 }] }, "onRevoke", {
    enumerable: true, get() { getters++; return () => {}; },
  });
  code(() => Reflect.apply(createReadUsageCohort, undefined, [topGetter]), "INVALID");
  expect(touched).toBe(0); expect(getters).toBe(0);
});

test("constructor snapshots exact owner/mapping/callback identities without changing caller objects", async () => {
  const f = mockSocket(), owner = {}, a = {}, b = {}, revoked: object[] = []; let replacedCalls = 0;
  const mappings = [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }];
  const options = { ownerAuthority: owner, socket: f.socket, mappings, onRevoke(value: object) { revoked.push(value); } };
  const c = createReadUsageCohort(options);
  try {
    mappings[0]!.conversation = {}; mappings[0]!.slot = 1; mappings.reverse();
    options.ownerAuthority = {}; options.onRevoke = () => { replacedCalls++; };
    code(() => c.on(options.ownerAuthority,a), "DENIED"); code(() => c.off({},a), "DENIED"); code(() => c.fail({}), "DENIED");
    expect(f.state.writes).toBe(0);
    const pending = c.on(owner,a); void pending.catch(() => {});
    const bytes = await bounded(f.written.promise), request = JSON.parse(bytes.subarray(4).toString("ascii")) as Frame;
    expect(request.slot).toBe(0); expect(request.record.enabled).toBe(true);
    const body = Buffer.from(JSON.stringify({ id: request.id, ok: true }), "ascii"), ack = Buffer.alloc(body.length+4);
    ack.writeUInt32BE(body.length,0); body.copy(ack,4); f.emitter.emit("data",ack);
    await bounded(pending); const version = await c.usageVersion(a);
    expect(version.conversation).toBe(a); expect(version.enabled).toBe(true); expect(c.usageCurrent(a,version.epoch)).toBe(true);
    expect(revoked[0]).toBe(a); expect(replacedCalls).toBe(0);
    await expect(c.usageVersion({})).rejects.toMatchObject({code:"DENIED"});
  } finally { c.fail(owner); }
  expect(f.state.closed).toBe(0); expect(f.state.ended).toBe(0);
});

test("reentrant owner fail fences both entries before pending commit rejection", async () => {
  const f = mockSocket(), owner = {}, a = {}, b = {};
  let cohort: Readonly<ReadUsageCohort> | undefined, reenter = false;
  const seen: object[] = [];
  cohort = createReadUsageCohort({ ownerAuthority: owner, socket: f.socket,
    mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }],
    onRevoke(conversation) {
      if (!reenter) return;
      seen.push(conversation);
      expect(cohort!.usageCurrent(a, 1)).toBe(false);
      expect(cohort!.usageCurrent(b, 2)).toBe(false);
      cohort!.fail(owner);
    } });
  const pending = cohort.on(owner, a);
  void pending.catch(() => {});
  await bounded(f.written.promise);
  reenter = true; cohort.fail(owner);
  expect(seen).toEqual([a, b]);
  await expect(bounded(pending)).rejects.toMatchObject({ code: "UNCONFIRMED" });
  expect((await cohort.usageVersion(a)).enabled).toBe(false);
  expect((await cohort.usageVersion(b)).enabled).toBe(false);
  expect(f.state.closed).toBe(0); expect(f.state.ended).toBe(0);
});


test("poison gates current ACK before revoke callback can pump a queued second conversation", async () => {
  const f = mockSocket(), owner = {}, a = {}, b = {}, active = {};
  let cohort!: Readonly<ReadUsageCohort>, armed = false, activeEpoch = 0, aEpoch = 0, bEpoch = 0;
  let currentId = 0;
  const observations: { allDisabled: boolean; before: number; after: number }[] = [];
  const emitAck = (id: number) => {
    const body = Buffer.from(JSON.stringify({ id, ok: true }), "ascii"), ack = Buffer.alloc(body.length + 4);
    ack.writeUInt32BE(body.length, 0); body.copy(ack, 4); f.emitter.emit("data", ack);
  };
  cohort = createReadUsageCohort({ ownerAuthority: owner, socket: f.socket,
    mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }, { conversation: active, slot: 2 }],
    onRevoke() {
      if (!armed) return;
      const allDisabled = !cohort.usageCurrent(a, aEpoch) && !cohort.usageCurrent(b, bEpoch)
        && !cohort.usageCurrent(active, activeEpoch);
      const before = f.state.writes;
      emitAck(currentId); // Exact valid current ACK, synchronously inside user code.
      cohort.fail(owner); // Reentrant failure must not recurse or bypass the gate.
      observations.push({ allDisabled, before, after: f.state.writes });
    } });
  try {
    const enabled = cohort.on(owner, active);
    await bounded(f.written.promise); await Promise.resolve(); await Promise.resolve();
    emitAck((JSON.parse(f.frames[0]!.subarray(4).toString("ascii")) as Frame).id);
    await bounded(enabled);
    const version = await cohort.usageVersion(active); activeEpoch = version.epoch;
    expect(cohort.usageCurrent(active, activeEpoch)).toBe(true);
    const first = cohort.on(owner, a), second = cohort.on(owner, b);
    const settlements = Promise.allSettled([first, second]);
    // No sleeps: these ordinary promise turns let both coordinator ordering
    // tails enter the real transport and its synchronous mock write settle.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(f.frames).toHaveLength(2); expect(f.state.writes).toBe(2);
    const current = JSON.parse(f.frames[1]!.subarray(4).toString("ascii")) as Frame;
    expect(current.slot).toBe(0); currentId = current.id;
    aEpoch = (await cohort.usageVersion(a)).epoch; bEpoch = (await cohort.usageVersion(b)).epoch;
    armed = true; cohort.fail(owner);
    expect(observations).toEqual(Array.from({ length: 3 }, () => ({ allDisabled: true, before: 2, after: 2 })));
    expect(f.state.writes).toBe(2); // Queued b was never written during callback ACK.
    for (const result of await bounded(settlements)) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "UNCONFIRMED" });
    }
    emitAck(currentId); expect(f.state.writes).toBe(2);
    expect(f.state.closed).toBe(0); expect(f.state.ended).toBe(0);
    // Exact synchronous JS composition evidence, not real socket/stop/durability proof.
  } finally { cohort.fail(owner); }
});
