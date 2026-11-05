import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer, Socket, type Server } from "node:net";
import { createReadUsageCohort, type ReadUsageCohort } from "../src/read-usage-cohort";

// Actual cross-language transport, not provenance/authentication or a production supervisor.
const linux = process.platform === "linux" ? test : test.skip;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, no) => { timer = setTimeout(() => no(new Error("Owned interop settlement unknown")), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const retained = new Set<Interop>();
class Interop {
  root?: string; store?: string; server?: Server; child?: Bun.Subprocess<"pipe", "pipe", "pipe">; socket?: Socket;
  cohort?: Readonly<ReadUsageCohort>; readonly owner = {}; readonly a = {}; readonly b = {};
  readonly events = new Map(["ready", "step1", "step2", "step3", "closed"].map(key => [key, deferred<boolean>()]));
  readonly operations = new Set<Promise<unknown>>(); readonly sockets = new Map<Socket, Promise<void>>();
  readonly accepted = deferred<Socket>(); readonly eof = deferred<void>();
  closing = false; unknown = false; listenReady = false; stdoutEof = false; stderrEof = false; exited = false;
  exitCode?: number; stderr = ""; inputEnd?: Promise<void>; serverClose?: Promise<void>;
  track<T>(p: Promise<T>): Promise<T> { this.operations.add(p); void p.then(() => { this.operations.delete(p); }, () => { this.operations.delete(p); }); return p; }
  open() { if (this.closing) throw new Error("Owned interop admission closed"); }
  async wait(name: string) { const event = this.events.get(name); if (!event || !await bounded(event.promise)) throw new Error("Owned interop event missing"); }
  async collect(stream: ReadableStream<Uint8Array>, protocol: boolean) {
    const reader = stream.getReader(), bytes = new Uint8Array(4096); let used = 0, parsed = 0, overflow = false;
    const seen = new Set<string>();
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        if (next.value.byteLength > bytes.length - used) { overflow = true; this.unknown = true; }
        if (overflow) continue; bytes.set(next.value, used); used += next.value.byteLength;
        if (protocol) { const lines = new TextDecoder().decode(bytes.subarray(0, used)).split("\n");
          for (const line of lines.slice(parsed, -1)) { const event = this.events.get(line); if (!event || seen.has(line)) { this.unknown = true; continue; } seen.add(line); event.resolve(true); }
          parsed = lines.length - 1;
        }
      }
      if (protocol) { this.stdoutEof = true; if (used > 0 && bytes[used - 1] !== 10) this.unknown = true; } else { this.stderrEof = true; this.stderr = new TextDecoder().decode(bytes.subarray(0, used)); }
      if (overflow) throw new Error("Owned interop output exceeded cap");
    } catch (error) { this.unknown = true; throw error; }
    finally { if (protocol) for (const event of this.events.values()) event.resolve(false); reader.releaseLock(); }
  }
  async setup() {
    // Store rejects world-writable ancestors such as /tmp. Parent fixture is private.
    const home = await realpath(homedir()); this.open();
    this.root = await mkdtemp(join(home, ".orbit-usage-interop-")); this.open();
    this.store = join(this.root, "store"); await mkdir(this.store, { mode: 0o700 }); this.open();
    const endpoint = join(this.root, "c.sock");
    if (Buffer.byteLength(endpoint) > 107) throw new Error("Owned interop socket path too long");
    const server = createServer(socket => {
      socket.pause(); socket.on("error", () => {});
      const closed = new Promise<void>(yes => socket.once("close", () => yes())); this.sockets.set(socket, closed);
      if (this.closing || this.socket) { this.unknown = true; socket.destroy(); return; }
      this.socket = socket; socket.once("end", () => this.eof.resolve()); this.accepted.resolve(socket);
    }); this.server = server;
    const listening = new Promise<void>((yes, no) => { server.once("error", no); server.once("listening", () => { this.listenReady = true; if (this.closing) void this.stopServer(); yes(); }); });
    this.track(listening); server.listen(endpoint); await bounded(listening); this.open();
    const child = Bun.spawn(["/usr/bin/python3", "-I", join(import.meta.dir, "fixtures/read_usage_interop.py"), this.store, endpoint],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: this.root, env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" } });
    this.child = child;
    this.track(child.exited.then(code => { this.exited = true; this.exitCode = code; }));
    this.track(this.collect(child.stdout, true)); this.track(this.collect(child.stderr, false));
    const socket = await bounded(this.accepted.promise); await this.wait("ready"); this.open();
    socket.pause(); // Bun may mark accepted sockets flowing during setup; no protocol bytes were sent yet.
    expect(Object.getPrototypeOf(socket)).toBe(Socket.prototype);
    expect(socket.readableEncoding).toBe(null);
    expect(socket.readableFlowing).not.toBe(true);
    expect(socket.listenerCount("data")).toBe(0); expect(socket.listenerCount("readable")).toBe(0);
    expect({ readable: socket.readable, writable: socket.writable, connecting: socket.connecting, destroyed: socket.destroyed }).toEqual({ readable: true, writable: true, connecting: false, destroyed: false });
    this.cohort = createReadUsageCohort({ ownerAuthority: this.owner, socket,
      mappings: [{ conversation: this.a, slot: 0 }, { conversation: this.b, slot: 1 }], onRevoke() {} });
  }
  stopServer() {
    if (!this.serverClose) { const server = this.server; if (!server || !this.listenReady) return Promise.reject(new Error("Listener startup unknown"));
      this.serverClose = new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); void this.serverClose.catch(() => {}); }
    return this.serverClose;
  }
  endInput() { if (!this.inputEnd) this.inputEnd = this.track(this.child ? Promise.resolve(this.child.stdin.end()).then(() => {}) : Promise.resolve()); return this.inputEnd; }
  async closeService() {
    this.open(); const child = this.child; if (!child) throw new Error("Child missing");
    const count = await child.stdin.write("close\n"); if (count !== 6) { this.unknown = true; throw new Error("Owned close instruction was partial"); }
    await this.endInput(); await this.wait("closed"); await bounded(this.eof.promise);
  }
  async settle() { const limit = performance.now() + 6000; while (this.operations.size) await bounded(Promise.allSettled([...this.operations]), Math.max(1, limit - performance.now())); }
  async cleanup() {
    this.closing = true;
    try {
      this.cohort?.fail(this.owner);
      // Closing only our transport asks the fixed service to observe EOF; it is
      // not writer-stop proof. Roots still require the separate exit/EOF receipts.
      for (const socket of this.sockets.keys()) socket.destroy();
      await bounded(this.endInput()); await this.settle();
      if (this.unknown || !this.exited || this.exitCode !== 0 || !this.stdoutEof || !this.stderrEof) throw new Error("Child/pipe state unknown");
      const stopped = this.stopServer();
      // No producer remains: exact child exited and both pipes reached actual EOF.
      for (const socket of this.sockets.keys()) socket.destroy();
      await bounded(stopped); await bounded(Promise.all([...this.sockets.values()]));
      const root = this.root; if (!root || !basename(root).startsWith(".orbit-usage-interop-") || dirname(await realpath(root)) !== await realpath(homedir())) throw new Error("Owned root identity changed");
      await rm(root, { recursive: true, force: true });
    } catch { this.unknown = true; retained.add(this); this.child?.unref(); this.server?.unref(); for (const socket of this.sockets.keys()) socket.unref(); throw new Error("Owned interop child/socket/root retained; cleanup unknown"); }
  }
}

linux("actual TypeScript cohort commits through Python store service and poisons on its EOF", async () => {
  const f = new Interop(); let failed = false, primary: unknown;
  try {
    await bounded(f.track(f.setup()));
    const work = f.track((async () => {
      const c = f.cohort; if (!c || !f.store) throw new Error("Cohort missing");
      await f.track(c.on(f.owner, f.a)); await f.wait("step1");
      const a = await c.usageVersion(f.a); expect(a.enabled).toBe(true);
      const first = JSON.parse(await readFile(join(f.store, "1".repeat(64) + ".json"), "utf8"));
      expect(first).toMatchObject({ schema: 1, epoch: a.epoch, enabled: true });
      const off = f.track(c.off(f.owner, f.a)); expect(c.usageCurrent(f.a, a.epoch)).toBe(false);
      await off; await f.wait("step2");
      await f.track(c.on(f.owner, f.b)); await f.wait("step3");
      const b = await c.usageVersion(f.b); expect(b.enabled).toBe(true);
      const lastA = JSON.parse(await readFile(join(f.store, "1".repeat(64) + ".json"), "utf8"));
      const lastB = JSON.parse(await readFile(join(f.store, "2".repeat(64) + ".json"), "utf8"));
      expect(lastA).toMatchObject({ instance: first.instance, enabled: false }); expect(lastA.epoch).toBeGreaterThan(first.epoch);
      expect(lastB).toMatchObject({ instance: first.instance, epoch: b.epoch, enabled: true });
      expect((await readdir(f.store)).some(name => name.endsWith(".writing") || name.endsWith(".pending"))).toBe(false);
      await f.closeService();
      expect(c.usageCurrent(f.b, b.epoch)).toBe(false); expect((await c.usageVersion(f.b)).enabled).toBe(false);
      await expect(f.track(c.on(f.owner, f.b))).rejects.toMatchObject({ code: "UNCONFIRMED" });
    })());
    await bounded(work, 15000);
  } catch (error) { f.unknown = true; failed = true; primary = error; }
  try { await f.cleanup(); } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "Interop execution and cleanup failed"); throw cleanup; }
  if (failed) throw primary;
  expect(f.stderr).toBe(""); expect(f.exitCode).toBe(0);
}, 30000);
