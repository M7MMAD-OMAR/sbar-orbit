import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadUsageUnixChannel } from "../src/read-usage-unix-channel";
import { createReadUsageStoreTransport, type ReadUsageTransport } from "../src/read-usage-store-transport";
import { ReadUsageCoordinator, type ReadUsageRecord } from "../src/read-usage-coordinator";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const outcome = (promise: Promise<void>) => promise.then(() => "ok", (error: unknown) => {
  const code: unknown = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  return typeof code === "string" && ["INVALID", "DENIED", "BUSY", "LIMIT", "STALE", "UNCONFIRMED"].includes(code) ? code : "unexpected";
});
async function withCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value!: T, failed = false, primary: unknown;
  try { value = await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (error) {
    if (failed) throw new AggregateError([primary, error], "Owned fixture execution and cleanup failed");
    throw error;
  }
  if (failed) throw primary;
  return value;
}
test("fixture helpers expose real refusal codes and preserve both execution and cleanup failures", async () => {
  expect(await outcome(Promise.reject({ code: "INVALID", message: "private failure" }))).toBe("INVALID");
  expect(await outcome(Promise.reject(new Error("private unexpected")))).toBe("unexpected");
  const primary = new Error("owned execution failure"), cleanup = new Error("owned cleanup failure");
  const failure: unknown = await withCleanup(async () => { throw primary; }, async () => { throw cleanup; }).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected both failures");
  expect(failure.errors).toEqual([primary, cleanup]);
});
function frame(value: unknown) { const bytes = new TextEncoder().encode(JSON.stringify(value)), result = new Uint8Array(bytes.length + 4); new DataView(result.buffer).setUint32(0, bytes.length); result.set(bytes, 4); return result; }
function mockSocket() {
  const emitter = new EventEmitter(), writes: Uint8Array[] = [];
  const state = { destroyed: 0, ended: 0, paused: 0, resumed: 0,
    write: undefined as undefined | ((bytes: Uint8Array, callback: (error?: Error | null) => void) => boolean) };
  let socket: Socket;
  const values = { destroyed: false, connecting: false, readable: true, writable: true, readableEnded: false, writableEnded: false,
    readableEncoding: null, readableFlowing: false,
    listenerCount: (name: string) => emitter.listenerCount(name),
    on: (name: string, callback: (...args: any[]) => void) => { emitter.on(name, callback); return socket; },
    once: (name: string, callback: (...args: any[]) => void) => { emitter.once(name, callback); return socket; },
    off: (name: string, callback: (...args: any[]) => void) => { emitter.off(name, callback); return socket; },
    prependListener: (name: string, callback: (...args: any[]) => void) => { emitter.prependListener(name, callback); return socket; },
    pause: () => { state.paused++; return socket; }, resume: () => { state.resumed++; return socket; },
    destroy: () => { state.destroyed++; return socket; }, end: () => { state.ended++; return socket; },
    write: (bytes: Uint8Array, callback: (error?: Error | null) => void) => { writes.push(bytes); if (state.write) return state.write(bytes, callback); callback(); return true; } };
  socket = Object.create(Socket.prototype, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, configurable: true, writable: true }])));
  return { socket, emitter, state, writes };
}

test("socket adapter copies bounded Buffer data to an exclusive Uint8Array without closing external socket", () => {
  const f = mockSocket(), channel = createReadUsageUnixChannel(f.socket), received: Uint8Array[] = [];
  channel.subscribe({ data: bytes => { received.push(bytes); }, eof() {}, error() {} });
  const input = Buffer.from([1, 2, 3]); f.emitter.emit("data", input); input.fill(9);
  expect([...received[0]!]).toEqual([1, 2, 3]); expect(Object.getPrototypeOf(received[0]!)).toBe(Uint8Array.prototype);
  expect(received[0]!.buffer.byteLength).toBe(3); expect(f.state.destroyed).toBe(0); expect(f.state.ended).toBe(0);
  expect(f.state.resumed).toBe(1);
});

test("backpressure requires write callback and drain and handles synchronous drain before false return", async () => {
  const f = mockSocket(), channel = createReadUsageUnixChannel(f.socket); let callback!: (error?: Error | null) => void;
  channel.subscribe({ data() {}, eof() {}, error() {} });
  f.state.write = (_bytes, done) => { callback = done; return false; };
  let done = false; const pending = channel.write(frame({ a: 1 })).then(() => { done = true; });
  f.emitter.emit("drain"); await Promise.resolve(); expect(done).toBe(false); callback(); await pending; expect(done).toBe(true);
  f.state.write = (_bytes, complete) => { complete(); f.emitter.emit("drain"); return false; };
  expect(await outcome(channel.write(frame({ a: 2 })))).toBe("ok");
});

test("latched EOF before subscription poisons the actual coordinator and cannot admit future writes", async () => {
  const f = mockSocket(), channel = createReadUsageUnixChannel(f.socket), authority = {}, a = {}, b = {};
  f.emitter.emit("end"); let transport!: ReadUsageTransport, failures = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { commit: (key, record) => transport.store.commit(key, record) } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }], channel,
    onFailure() { failures++; coordinator.poisonAll(authority); } });
  expect(await outcome(coordinator.on(authority, a))).toBe("UNCONFIRMED"); expect(await outcome(coordinator.on(authority, b))).toBe("UNCONFIRMED");
  expect(failures).toBe(1); expect(f.writes).toHaveLength(0); expect(f.state.destroyed).toBe(0); expect(f.state.ended).toBe(0);
});

test("socket error after synchronous write callback fences before rejecting and oversized inbound is never copied", async () => {
  const f = mockSocket(), channel = createReadUsageUnixChannel(f.socket), events: string[] = [];
  channel.subscribe({ data() { events.push("data"); }, eof() { events.push("poison"); }, error() { events.push("poison"); } });
  f.state.write = (_bytes, done) => { done(); f.emitter.emit("error", new Error("private socket error")); throw new Error("private after callback"); };
  const pending = channel.write(frame({ a: 1 })).then(() => "ok", () => { events.push("reject"); return "failed"; });
  expect(await pending).toBe("failed"); expect(events).toEqual(["poison", "reject"]);
  expect(f.state.destroyed).toBe(0); expect(f.state.ended).toBe(0);
  const large = mockSocket(), bounded = createReadUsageUnixChannel(large.socket); let copies = 0, failures = 0;
  bounded.subscribe({ data() { copies++; }, eof() {}, error() { failures++; } });
  large.emitter.emit("data", Buffer.alloc(1029)); expect(copies).toBe(0); expect(failures).toBe(1);
});

test("error observer installation failure throws before claiming a channel or pausing the owner socket", () => {
  const f = mockSocket();
  Object.defineProperty(f.socket, "prependListener", { value: () => { throw new Error("fixture install failure"); } });
  expect(() => createReadUsageUnixChannel(f.socket)).toThrow(); expect(f.state.paused).toBe(0); expect(f.state.resumed).toBe(0);
  // No channel was transferred. The original owner must manage future socket errors.
  let handled = 0; f.emitter.on("error", () => { handled++; }); f.emitter.emit("error", new Error("owned later error"));
  expect(handled).toBe(1); expect(f.state.destroyed).toBe(0);
});

test("remaining partial setup failures retain the first error observer and stay failed on subscribe", async () => {
  for (const stage of ["pause", "end"] as const) {
    const f = mockSocket();
    if (stage === "pause") Object.defineProperty(f.socket, "pause", { value: () => { throw new Error("fixture pause failure"); } });
    else Object.defineProperty(f.socket, "prependListener", { value: (name: string, callback: (...args: any[]) => void) => {
      if (name === "end") throw new Error("fixture end listener failure"); f.emitter.prependListener(name, callback); return f.socket;
    } });
    const channel = createReadUsageUnixChannel(f.socket); let failures = 0;
    expect(() => f.emitter.emit("error", new Error("owned later error"))).not.toThrow();
    channel.subscribe({ data() { throw new Error("No reads"); }, eof() {}, error() { failures++; } });
    expect(failures).toBe(1); expect(await outcome(channel.write(frame({ a: 1 })))).toBe("UNCONFIRMED");
    expect(f.state.resumed).toBe(0); expect(f.state.destroyed).toBe(0);
  }
});

test("invalid subscription latches failure without executing callback getters or later resuming reads", () => {
  const f = mockSocket(), channel = createReadUsageUnixChannel(f.socket); let getters = 0, failures = 0;
  const invalid = Object.defineProperty({ data() {}, eof() {} }, "error", { enumerable: true, get() { getters++; return () => {}; } });
  expect(() => channel.subscribe(invalid as unknown as Parameters<typeof channel.subscribe>[0])).toThrow();
  channel.subscribe({ data() {}, eof() {}, error() { failures++; } });
  expect(getters).toBe(0); expect(failures).toBe(1); expect(f.state.resumed).toBe(0);
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error("Owned socket fixture deadline")), 2000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function ownedLifetime(server: Server, removeRoot: () => Promise<void>, wait: <T>(promise: Promise<T>) => Promise<T> = bounded) {
  const ready = deferred<void>(), accepted = deferred<Socket>(), sockets = new Map<Socket, Promise<void>>();
  let closed = deferred<void>(), closing = false, started = false, startFailed = false, stopped = false, closeAsked = false, removed = false;
  function askClose() {
    if (!started || stopped || closeAsked) return;
    closeAsked = true;
    try { server.close(() => {}); } catch { /* Only the observed close event proves closure. */ }
  }
  function track(socket: Socket) {
    if (sockets.has(socket)) return;
    const ended = deferred<void>(); sockets.set(socket, ended.promise);
    socket.on("error", () => {}); // Installed inside accept/creation, before any await.
    const lateConnect = () => { if (closing) socket.destroy(); };
    socket.on("connect", lateConnect);
    socket.once("close", () => { socket.off("connect", lateConnect); ended.resolve(); });
    if (closing) socket.destroy();
  }
  server.on("listening", () => {
    if (stopped) closed = deferred<void>();
    stopped = false; closeAsked = false; started = true; ready.resolve();
    if (closing) askClose();
  });
  server.on("error", () => { if (!started) { started = true; startFailed = true; ready.resolve(); } });
  server.on("close", () => { stopped = true; closed.resolve(); });
  server.on("connection", socket => { track(socket); if (!closing) accepted.resolve(socket); });
  return { ready: ready.promise, accepted: accepted.promise, track,
    failed: () => startFailed,
    startFailed() { if (!started) { started = true; startFailed = true; ready.resolve(); } },
    async close() {
      closing = true;
      for (const socket of sockets.keys()) socket.destroy();
      try {
        await wait(ready.promise); // Never infer !listening means a pending listen is gone.
        askClose();
        // An error event alone is not terminal listen proof. Keep the private root
        // permanently when startup failed, even if close appears to acknowledge.
        if (startFailed) throw new Error("Startup failure remains unqualified");
        await wait(closed.promise);
        // Closing the listener precedes the final accepted-socket snapshot.
        for (let pass = 0; ; pass++) {
          const count = sockets.size;
          await wait(Promise.all([...sockets.values()]));
          if (count === sockets.size) break;
          if (pass >= 3) throw new Error("Late socket cleanup remains uncertain");
        }
        if (!removed) { await removeRoot(); removed = true; }
      } catch {
        try { server.unref(); } catch { /* Root stays owned and intact when proof is unknown. */ }
        throw new Error("Owned socket startup or close remains uncertain; root retained");
      }
    },
  };
}
function fakeServer() {
  const server = new EventEmitter() as unknown as Server;
  const state = { closes: 0, unrefs: 0 };
  Object.defineProperty(server, "close", { value: (callback?: () => void) => { state.closes++; server.emit("close"); callback?.(); return server; } });
  Object.defineProperty(server, "unref", { value: () => { state.unrefs++; return server; } });
  return { server, state };
}
function closingMockSocket() {
  const f = mockSocket();
  Object.defineProperty(f.socket, "destroy", { value: () => { f.state.destroyed++; f.emitter.emit("close"); return f.socket; } });
  return f;
}

test("fixture cleanup observes delayed listen and destroys late accepted sockets before deleting its root", async () => {
  const f = fakeServer(), late = closingMockSocket(); let removed = 0;
  const life = ownedLifetime(f.server, async () => { removed++; });
  const pending = life.close(); expect(removed).toBe(0);
  f.server.emit("connection", late.socket); expect(late.state.destroyed).toBe(1);
  expect(() => late.emitter.emit("error", new Error("late owned socket error"))).not.toThrow();
  f.server.emit("listening"); await pending;
  expect(f.state.closes).toBe(1); expect(removed).toBe(1); expect(late.emitter.listenerCount("connect")).toBe(0);
});

test("uncertain fixture startup retains root and auto-closes late listener without falsely deleting", async () => {
  const f = fakeServer(); let removed = 0, calls = 0;
  const wait: typeof bounded = async promise => { if (++calls === 1) throw new Error("deterministic startup uncertainty"); return await promise; };
  const life = ownedLifetime(f.server, async () => { removed++; }, wait);
  await expect(life.close()).rejects.toThrow("root retained");
  expect(removed).toBe(0); expect(f.state.unrefs).toBe(1);
  f.server.emit("listening"); expect(f.state.closes).toBe(1); expect(removed).toBe(0);
  // Only an explicit second owner cleanup, after observed close, may remove the root.
  await life.close(); expect(removed).toBe(1);
  const failed = fakeServer(); let failedRemoved = 0;
  const failedLife = ownedLifetime(failed.server, async () => { failedRemoved++; });
  failed.server.emit("error", new Error("startup error does not prove termination"));
  await expect(failedLife.close()).rejects.toThrow("root retained");
  expect(failedRemoved).toBe(0); expect(failed.state.closes).toBe(1);
  failed.server.emit("listening");
  expect(failed.state.closes).toBe(2); expect(failedRemoved).toBe(0);
});

async function realFixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-owned-usage-unix-")), path = join(root, "private.sock");
  const records: { id: number; slot: number; record: ReadUsageRecord }[] = [], third = deferred<void>();
  const state = { hold: false, failures: 0 };
  let client: Socket | undefined, peer: Socket | undefined;
  const server = createServer({ pauseOnConnect: true });
  const life = ownedLifetime(server, () => rm(root, { recursive: true, force: true }));
  const cleanup = () => life.close();
  try {
    try { server.listen(path); } catch (error) { life.startFailed(); throw error; }
    await bounded(life.ready); if (life.failed()) throw new Error("Owned listener startup failed");
    await chmod(path, 0o600);
    client = createConnection({ path }); life.track(client);
    const connected = new Promise<boolean>(yes => {
      const clear = () => { client!.off("connect", onConnect); client!.off("error", onError); client!.off("close", onError); };
      const onConnect = () => { client!.pause(); clear(); yes(true); };
      const onError = () => { clear(); yes(false); };
      client!.once("connect", onConnect); client!.once("error", onError); client!.once("close", onError);
    });
    if (!await bounded(connected)) throw new Error("Owned connection startup failed");
    peer = await bounded(life.accepted); peer.pause();
    let incoming = Buffer.alloc(0);
    peer.on("data", (bytes: Buffer) => {
      try {
        if (incoming.length + bytes.length > 1028) throw new Error("Fixture frame bound");
        incoming = Buffer.concat([incoming, bytes]); if (incoming.length < 4) return;
        const length = incoming.readUInt32BE(0); if (length < 1 || length > 1024) throw new Error("Fixture invalid length");
        if (incoming.length < length + 4) return; if (incoming.length !== length + 4) throw new Error("Fixture extra frame");
        const request = JSON.parse(incoming.subarray(4).toString("ascii")) as typeof records[number]; incoming = Buffer.alloc(0); records.push(request);
        if (records.length >= 3) third.resolve();
        if (!state.hold) peer!.write(Buffer.from(frame({ id: request.id, ok: true })));
      } catch { peer!.destroy(); }
    });
    const channel = createReadUsageUnixChannel(client), authority = {}, a = {}, b = {};
    let transport!: ReadUsageTransport;
    const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { commit: (key, record) => transport.store.commit(key, record) } });
    coordinator.register(authority, a); coordinator.register(authority, b);
    transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }], channel,
      onFailure() { state.failures++; coordinator.poisonAll(authority); } });
    peer.resume();
    return { coordinator, authority, a, b, transport, state, records, third, peer, client, close: cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Owned fixture startup and cleanup failed"); }
    throw error;
  }
}

const posix = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
posix("real owned private Unix sockets compose the actual byte adapter transport and coordinator", async () => {
  const f = await realFixture();
  await withCleanup(async () => {
    await bounded(f.coordinator.on(f.authority, f.a)); await bounded(f.coordinator.on(f.authority, f.b));
    expect((await f.coordinator.usageVersion(f.a)).enabled).toBe(true); expect((await f.coordinator.usageVersion(f.b)).enabled).toBe(true);
    await bounded(f.coordinator.off(f.authority, f.a));
    expect(f.records.map(record => [record.id, record.slot, record.record.enabled])).toEqual([[1, 0, true], [2, 1, true], [3, 0, false]]);
    expect(f.transport.status(f.authority)).toEqual({ failed: false, queued: 0, inFlight: false, uncertain: false });
    // This peer is a protocol fixture, NOT Python durability, FD provenance or writer-stop proof.
  }, f.close);
});

posix("real owned peer disconnect poisons both conversations before a pending off can acknowledge", async () => {
  const f = await realFixture();
  await withCleanup(async () => {
    await bounded(f.coordinator.on(f.authority, f.a)); await bounded(f.coordinator.on(f.authority, f.b));
    const previous = await f.coordinator.usageVersion(f.b); f.state.hold = true;
    const pending = outcome(f.coordinator.off(f.authority, f.a));
    await bounded(f.third.promise); expect(f.coordinator.usageCurrent(f.b, previous.epoch)).toBe(true);
    f.peer.destroy(); expect(await bounded(pending)).toBe("UNCONFIRMED");
    expect(f.coordinator.usageCurrent(f.b, previous.epoch)).toBe(false); expect(f.state.failures).toBe(1);
    expect(f.transport.status(f.authority)).toMatchObject({ failed: true, uncertain: true, inFlight: true });
    expect(await outcome(f.coordinator.on(f.authority, f.b))).toBe("UNCONFIRMED");
  }, f.close);
});
