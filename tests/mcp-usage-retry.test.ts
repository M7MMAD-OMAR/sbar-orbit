import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callPatient } from "../src/ipc";
import { ConversationUsage } from "../src/conversation-usage";
import { OrbitError } from "../src/errors";
import type { ClientIdentity } from "../src/caller";

// Real SINGLE-wrapper-attempt callPatient/HTTP Unix requests and preferences.
// No guarantee about Bun internal retries or global at-most-once execution. No MCP child, env
// mutation, desktop action, peer authorization or atomic off/on claim. Runtime
// coverage is callPatient only; adapter callback wiring is a separate static contract.
const identity: ClientIdentity = { claim: { v: 1, kind: "adapter", pid: process.pid, start: "1" } };
type Rpc = { method: string; params: Record<string, unknown> };
async function bounded<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned retry fixture settlement unknown")), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
class Fixture {
  readonly socket: string;
  readonly usageRoot: string;
  readonly requests: Rpc[] = [];
  readonly pending = new Set<Promise<unknown>>();
  readonly bunServers = new Set<ReturnType<typeof Bun.serve>>();
  readonly nodeServers = new Set<Server>();
  readonly sockets = new Set<import("node:net").Socket>();
  startupUnknown = false;
  closing = false;
  constructor(readonly root: string) { this.socket = join(root, "b.sock"); this.usageRoot = join(root, "usage"); }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => { this.pending.delete(promise); }, () => { this.pending.delete(promise); });
    return promise;
  }
  async usage(enabled = true) {
    const usage = new ConversationUsage("retry-" + crypto.randomUUID(), this.usageRoot);
    await this.track(usage.set(enabled ? "on" : "off")); return usage;
  }
  start(reply: (request: Rpc) => unknown | Promise<unknown> = () => ({ ok: true, result: { accepted: true } })) {
    if (this.closing) throw new Error("Owned fixture admissions closed");
    this.startupUnknown = true;
    const server = Bun.serve({ unix: this.socket, fetch: request => {
      const admitted = !this.closing;
      return this.track((async () => {
        if (!admitted) return Response.json({ ok: false, error: { code: "FIXTURE_CLOSING", message: "Owned fixture closing" } }, { status: 503, headers: { Connection: "close" } });
        const rpc = await request.json() as Rpc; this.requests.push(rpc);
        return Response.json(await reply(rpc), { headers: { Connection: "close" } });
      })());
    } });
    this.bunServers.add(server); this.startupUnknown = false;
    return server;
  }
  async resetAfterAcceptedBody() {
    if (this.closing) throw new Error("Owned fixture admissions closed");
    const progress = { acceptedBody: false, headersFlushed: false, bodyQueued: false, reset: false };
    const server = createServer((request, response) => {
      const admitted = !this.closing;
      let done!: () => void;
      const terminal = new Promise<void>(resolve => { done = resolve; }); this.track(terminal);
      response.once("close", done); response.once("finish", done); response.on("error", () => {});
      const work = this.track((async () => {
        if (!admitted) { response.writeHead(503, { Connection: "close" }); response.end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        await new Promise<void>((resolve, reject) => {
          request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) reject(new Error("Owned request bound")); else chunks.push(chunk); });
          request.once("end", resolve); request.once("error", reject); request.once("aborted", () => reject(new Error("Owned request aborted")));
        });
        this.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc);
        progress.acceptedBody = true;
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.flushHeaders(); progress.headersFlushed = true;
        // Send a real partial response only AFTER accepting the complete request.
        // A response-body failure is not evidence that the action was never sent.
        await this.track(new Promise<void>((resolve, reject) => {
          response.write('{"ok":true,"result":', error => {
            try { progress.bodyQueued = !error; progress.reset = true; response.destroy(); resolve(); }
            catch (failure) { reject(failure); }
          });
        }));
      })());
      void work.catch(() => { response.destroy(); });
    });
    this.nodeServers.add(server);
    server.on("connection", socket => {
      this.sockets.add(socket);
      this.track(new Promise<void>(resolve => { socket.once("close", () => { this.sockets.delete(socket); resolve(); }); }));
    });
    await this.track(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socket, resolve); }));
    return progress;
  }
  async close() {
    this.closing = true; // Quiesce every owned admission source BEFORE draining.
    const endings: Promise<unknown>[] = [];
    try {
      if (this.startupUnknown) throw new Error("Unknown listener startup");
      // Graceful listener shutdown rejects NEW connections, not accepted work.
      for (const server of this.bunServers) endings.push(Promise.resolve(server.stop(false)));
      for (const server of this.nodeServers) {
        endings.push(new Promise<void>((resolve, reject) => {
          server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve(); });
        }));
        server.closeIdleConnections();
      }
      // Attach rejection handlers immediately, even while accepted work settles.
      for (const ending of endings) void ending.catch(() => {});
      const deadline = performance.now() + 2000;
      while (this.pending.size) await bounded(Promise.allSettled([...this.pending]), Math.max(1, deadline - performance.now()));
      await bounded(Promise.all(endings));
      const finalDeadline = performance.now() + 2000;
      while (this.pending.size) await bounded(Promise.allSettled([...this.pending]), Math.max(1, finalDeadline - performance.now()));
    } catch {
      // Unknown is not cancellation. Never erase evidence or claim writer drain.
      for (const server of this.bunServers) server.unref();
      for (const server of this.nodeServers) server.unref();
      for (const socket of this.sockets) socket.unref();
      throw new Error("Owned retry fixture cleanup unconfirmed; root retained");
    }
    await rm(this.root, { recursive: true, force: true });
  }
}
async function fixture(work: (owned: Fixture) => Promise<void>) {
  let owned: Fixture | undefined, root: string | undefined;
  try { root = await mkdtemp(join(tmpdir(), "orbit-usage-retry-")); const created = new Fixture(root); owned = created; await bounded(created.track(Promise.resolve().then(() => work(created))), 2500); }
  finally { if (owned) await owned.close(); else if (root) await rm(root, { recursive: true, force: true }); }
}
async function denied(promise: Promise<unknown>, code: string) {
  let observed: unknown;
  try { await promise; } catch (error) { observed = error; }
  expect(observed).toMatchObject({ code }); return observed;
}

test("actual initial off rejects before even a reachable fake broker request", () => fixture(async f => {
  const usage = await f.usage(false); f.start(); let guards = 0, sleeps = 0;
  await denied(f.track(callPatient(f.socket, "session.act", { requestId: "initial" }, identity, 1000,
    async () => { sleeps++; }, async () => { guards++; await f.track(usage.assertEnabled()); })), "ORBIT_DISABLED");
  expect(guards).toBe(1); expect(sleeps).toBe(0); expect(f.requests).toHaveLength(0);
}));

test("absent broker is one attempt; observed off blocks a later explicit call", () => fixture(async f => {
  const usage = await f.usage(); let guards = 0, sleeps = 0, firstError: unknown;
  const guard = async () => { guards++; await f.track(usage.assertEnabled()); };
  const sleep = async () => { sleeps++; throw new Error("Automatic sleep is forbidden"); };
  try { await f.track(callPatient(f.socket, "session.act", { requestId: "not-delivered-fixture" }, identity, 1000, sleep, guard)); }
  catch (error) { firstError = error; }
  expect(firstError).toBeDefined(); expect(sleeps).toBe(0); expect(guards).toBe(1);
  expect(f.requests).toHaveLength(0);
  await f.track(usage.set("off")); f.start();
  await denied(f.track(callPatient(f.socket, "session.act", { requestId: "explicit-after-off" }, identity, 1000, sleep, guard)), "ORBIT_DISABLED");
  expect(guards).toBe(2); expect(sleeps).toBe(0); expect(f.requests).toHaveLength(0);
}));

test("malformed preference blocks the single attempted call without dispatch", () => fixture(async f => {
  const usage = await f.usage(); let guards = 0, sleeps = 0;
  const name = createHash("sha256").update(usage.conversationId!).digest("hex") + ".json";
  await f.track(writeFile(join(f.usageRoot, name), "PRIVATE-corrupt-policy{", { mode: 0o600 })); f.start();
  await denied(f.track(callPatient(f.socket, "session.act", {}, identity, 1000,
    async () => { sleeps++; }, async () => { guards++; await f.track(usage.assertEnabled()); })), "USAGE_STATE_INVALID");
  expect(sleeps).toBe(0); expect(guards).toBe(1); expect(f.requests).toHaveLength(0);
}));

test("broker start requires an explicit second call, each independently guarded", () => fixture(async f => {
  const usage = await f.usage(); let guards = 0, sleeps = 0, absent: unknown;
  const guard = async () => { guards++; await f.track(usage.assertEnabled()); };
  const sleep = async () => { sleeps++; throw new Error("No automatic retry"); };
  try { await f.track(callPatient(f.socket, "session.act", { requestId: "owned-fixture-id" }, identity, 1000, sleep, guard)); }
  catch (error) { absent = error; }
  expect(absent).toBeDefined(); expect(guards).toBe(1); expect(sleeps).toBe(0);
  f.start();
  const result = await f.track(callPatient(f.socket, "session.act", { requestId: "owned-fixture-id" }, identity, 1000, sleep, guard));
  expect(result).toEqual({ accepted: true }); expect(guards).toBe(2); expect(sleeps).toBe(0);
  expect(f.requests.map(value => value.method)).toEqual(["session.act"]);
}));

test("sixth positional sleep is compatible but never invoked automatically", () => fixture(async f => {
  let sleeps = 0, absent: unknown;
  const sleep = async () => { sleeps++; throw new Error("Compatibility argument must be unused"); };
  try { await f.track(callPatient(f.socket, "session.list", {}, identity, 1000, sleep)); }
  catch (error) { absent = error; }
  expect(absent).toBeDefined(); expect(sleeps).toBe(0);
  f.start();
  const result = await f.track(callPatient(f.socket, "session.list", {}, identity, 1000, sleep));
  expect(result).toEqual({ accepted: true }); expect(sleeps).toBe(0); expect(f.requests).toHaveLength(1);
}));

test("policy error shaped ENOENT is outside transport catch and never retried", () => fixture(async f => {
  f.start(); const marker = Object.assign(new Error("Fixed policy rejection"), { code: "ENOENT" });
  let sleeps = 0, guards = 0, observed: unknown;
  try { await f.track(callPatient(f.socket, "session.act", {}, identity, 1000,
    async () => { sleeps++; throw new Error("Unexpected guard retry"); }, async () => { guards++; throw marker; })); }
  catch (error) { observed = error; }
  expect(observed).toBe(marker); expect(guards).toBe(1); expect(sleeps).toBe(0); expect(f.requests).toHaveLength(0);
}));

for (const code of ["ENOENT", "ECONNREFUSED"] as const) test("actual broker-origin " + code + " refusal is never resent", () => fixture(async f => {
  f.start(() => ({ ok: false, error: { code, message: "Fixed broker refusal" } }));
  let sleeps = 0, guards = 0;
  const error = await denied(f.track(callPatient(f.socket, "session.act", { requestId: "one-refusal" }, identity, 1000,
    async () => { sleeps++; throw new Error("Unexpected accepted-RPC retry"); }, async () => { guards++; })), code);
  expect((error as Error).message).toBe("Fixed broker refusal");
  expect(f.requests).toHaveLength(1); expect(guards).toBe(1); expect(sleeps).toBe(0);
}));

test("accepted request followed by server reset is never retried", () => fixture(async f => {
  const progress = await f.resetAfterAcceptedBody(); let sleeps = 0, guards = 0, observed: unknown;
  try { await f.track(callPatient(f.socket, "session.act", { requestId: "accepted-before-reset" }, identity, 1000,
    async () => { sleeps++; throw new Error("Unexpected post-send retry"); }, async () => { guards++; })); }
  catch (error) { observed = error; }
  expect(observed).toBeDefined();
  // Reset may fail before fetch returns (raw transport error), or while the
  // bounded reader consumes the body (fixed BROKER_ERROR). Neither proves no delivery.
  if (observed instanceof OrbitError) {
    expect(observed.code).toBe("BROKER_ERROR");
    expect(observed.disposition).toEqual({ delivery: "unknown", retry: "unsafe" });
    expect(["Native broker reply could not be read", "Native broker reply is invalid JSON"]).toContain(observed.message);
  } else expect(observed).toBeInstanceOf(Error);
  expect(progress).toEqual({ acceptedBody: true, headersFlushed: true, bodyQueued: true, reset: true });
  // Queued server bytes are not a claim that the client consumed a partial body.
  expect(f.requests).toHaveLength(1); expect(guards).toBe(1); expect(sleeps).toBe(0);
}));

test("off after accepted mutation does not cancel or hide its returned receipt", () => fixture(async f => {
  const usage = await f.usage();
  f.start(async () => { await f.track(usage.set("off")); return { ok: true, result: { receipt: "accepted-work" } }; });
  const result = await f.track(callPatient(f.socket, "session.act", { requestId: "honest-receipt" }, identity, 1000,
    async () => { throw new Error("No retry expected"); }, () => f.track(usage.assertEnabled())));
  expect(result).toEqual({ receipt: "accepted-work" }); expect(f.requests).toHaveLength(1);
  expect((await f.track(usage.status())).enabled).toBe(false);
}));

test("both adapter invoke implementations statically bind the seventh usage guard", async () => {
  // This is a source wiring contract, NOT actual MCP adapter/runtime coverage.
  for (const path of ["../src/mcp.ts", "../src/session-mcp.ts"]) {
    const source = await readFile(join(import.meta.dir, path), "utf8");
    const start = source.indexOf("const invoke = async");
    const end = source.indexOf("server.registerTool", start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const invoke = source.slice(start, end);
    expect(invoke).toContain("undefined, undefined, () => usage.assertEnabled()");
  }
});
