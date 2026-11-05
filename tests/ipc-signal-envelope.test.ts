import { expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { call } from "../src/ipc";
import { OrbitError } from "../src/errors";
import type { ClientIdentity } from "../src/caller";

const unixTest = process.platform === "linux" ? test : test.skip;
const LIMIT = 32 * 1024 * 1024;
const identity: ClientIdentity = { claim: { v: 1, kind: "client", pid: process.pid } };
async function bounded<T>(work: Promise<T>, ms = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Owned signal fixture remains unconfirmed")), ms);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function ownedRoot() {
  const prefix = "orbit-signal-reply-", made = await mkdtemp(join(tmpdir(), prefix));
  const base = await realpath(made), parent = await realpath(dirname(made));
  return { base, remove: async () => {
    const info = await lstat(base);
    if (dirname(base) !== parent || !basename(base).startsWith(prefix) || await realpath(base) !== base
        || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing non-owned fixture cleanup");
    await rm(base, { recursive: true, force: true });
  } };
}
async function fixture() {
  const root = await ownedRoot(), socket = join(root.base, "b.sock");
  const active = new Set<Promise<unknown>>(), responses = new Set<Promise<unknown>>(), connectionEnds = new Set<Promise<unknown>>();
  const connections = new Set<import("node:net").Socket>();
  let requests = 0, closing = false, stage = "running";
  const roles = new Map<Promise<unknown>, "handler" | "client">();
  const counts = { handlerStarted: 0, handlerSettled: 0, clientStarted: 0, clientSettled: 0,
    responseFinish: 0, responseClose: 0, connectionOpened: 0, connectionClosed: 0, socketEndRequested: 0, socketDestroyRequested: 0 };
  const listener = { closeRequested: false, callback: false, callbackError: false };
  const track = <T>(promise: Promise<T>, target = active, role?: "handler" | "client") => {
    target.add(promise);
    if (role) { roles.set(promise, role); if (role === "handler") counts.handlerStarted++; else counts.clientStarted++; }
    const done = () => {
      target.delete(promise); roles.delete(promise);
      if (role === "handler") counts.handlerSettled++; else if (role === "client") counts.clientSettled++;
    };
    void promise.then(done, done);
    return promise;
  };
  let route: (response: ServerResponse) => void | Promise<void> = response => { response.end('{"ok":true,"result":"owned"}'); };
  const server = createServer((request, response) => {
    const admitted = !closing;
    let terminal!: () => void;
    track(new Promise<void>(resolve => { terminal = resolve; }), responses);
    response.once("close", () => { counts.responseClose++; terminal(); });
    response.once("finish", () => { counts.responseFinish++; terminal(); }); response.on("error", () => {});
    const work = track((async () => {
      response.setHeader("Connection", "close"); response.setHeader("Content-Type", "application/json");
      if (!admitted) { response.statusCode = 503; response.end(); return; }
      let bytes = 0;
      for await (const chunk of request) { bytes += (chunk as Buffer).byteLength; if (bytes > 4096) throw new Error("Owned request bound"); }
      requests++;
      await route(response);
    })(), active, "handler");
    void work.catch(() => { response.destroy(); });
  });
  server.on("connection", connection => {
    connections.add(connection); counts.connectionOpened++;
    connection.on("error", () => {}); // An error is not a close receipt.
    track(new Promise<void>(resolve => connection.once("close", () => { connections.delete(connection); counts.connectionClosed++; resolve(); })), connectionEnds);
  });
  try { await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); })); }
  catch { server.unref(); throw new Error("Owned listener startup unconfirmed; root retained"); }
  const invoke = (signal = new AbortController().signal) => bounded(track(call(socket, "owned.fixture", {}, signal, identity), active, "client"));
  return { socket, base: root.base, invoke, requests: () => requests,
    route: (next: typeof route) => { route = next; },
    close: async () => {
      closing = true;
      try {
        stage = "request-listener-close"; listener.closeRequested = true;
        const stopped = new Promise<void>((resolve, reject) => server.close(error => {
          listener.callback = true; listener.callbackError = Boolean(error);
          if (error) reject(error); else resolve();
        }));
        stage = "drain-handlers-clients-responses";
        await bounded(Promise.allSettled([...active, ...responses]), 5000);
        if (active.size || responses.size) throw new Error("Owned handler/response work not settled");
        // Only after all accepted work is done may idle owned connections be
        // half-closed. Never destroy an active sender or signal a numeric PID.
        stage = "end-owned-idle-connections";
        for (const connection of connections) if (!connection.destroyed) { counts.socketEndRequested++; connection.end(); }
        // Runtime evidence showed ended/finished writes with an open readable
        // half after every handler/client/response had settled. Only these owned
        // idle sockets may now be destroyed; still require actual close events.
        stage = "destroy-confirmed-owned-idle-connections";
        if (server.listening || active.size || responses.size) throw new Error("Owned work/listener is not quiescent");
        for (const connection of connections) if (!connection.destroyed) {
          if (active.size || responses.size) throw new Error("New owned work appeared before socket cleanup");
          counts.socketDestroyRequested++; connection.destroy();
        }
        stage = "await-connection-close-and-listener";
        await bounded(Promise.all([stopped, Promise.allSettled([...connectionEnds])]), 5000);
        if (active.size || responses.size || connectionEnds.size || connections.size) throw new Error("Owned connection close not confirmed");
      } catch {
        server.unref(); for (const connection of connections) connection.unref();
        const pendingRoles = [...roles.values()];
        const evidence = { stage, requests, counts, listener: { ...listener, listening: server.listening },
          pending: { active: active.size, handlers: pendingRoles.filter(role => role === "handler").length,
            clients: pendingRoles.filter(role => role === "client").length, responses: responses.size,
            connectionClose: connectionEnds.size, connections: connections.size },
          sockets: [...connections].map(connection => ({ destroyed: connection.destroyed,
            readableEnded: connection.readableEnded, writableEnded: connection.writableEnded, writableFinished: connection.writableFinished,
            bytesRead: connection.bytesRead, bytesWritten: connection.bytesWritten })) };
        throw new Error("Owned signal fixture retained: " + JSON.stringify(evidence));
      }
      await root.remove();
    } };
}
function write(response: ServerResponse, bytes: Uint8Array): Promise<boolean> {
  if (response.destroyed) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true;
      response.off("close", closed); response.off("error", closed); resolve(ok);
    };
    const closed = () => finish(false);
    response.once("close", closed); response.once("error", closed);
    try { response.write(bytes, error => finish(!error && !response.destroyed)); } catch { finish(false); }
  });
}
async function invalid(work: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try { await work; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(OrbitError);
  expect(error).toMatchObject({ code: "BROKER_ERROR", message, disposition: { delivery: "unknown", retry: "unsafe" } });
  expect(JSON.stringify(error)).not.toContain("PRIVATE_SIGNAL_REPLY");
}

unixTest("actual signaled call accepts fragmented BOM normal JSON and nonfatal UTF-8", async () => {
  const state = await fixture();
  try {
    state.route(async response => {
      for (const byte of Buffer.from('\ufeff' + JSON.stringify({ ok: true, result: "😀 café" })))
        if (!await write(response, Uint8Array.of(byte))) return;
      response.end();
    });
    expect(await state.invoke()).toBe("😀 café");
    state.route(async response => {
      if (!await write(response, Buffer.from('{"ok":true,"result":"'))) return;
      if (!await write(response, Uint8Array.of(255, 195))) return;
      response.end('"}');
    });
    expect(await state.invoke()).toBe("\ufffd\ufffd");
    expect(state.requests()).toBe(2);
  } finally { await state.close(); }
}, 20000);

unixTest("actual signaled malformed envelopes and JSON return fixed errors without replay", async () => {
  const state = await fixture();
  try {
    for (const value of [null, [], {}, "PRIVATE_SIGNAL_REPLY", { ok: null }, { ok: 1 }, { ok: "true" },
      { ok: false, error: { message: { toString: null, valueOf: null, private: "PRIVATE_SIGNAL_REPLY" } } },
      { ok: false, error: { code: { private: "PRIVATE_SIGNAL_REPLY" }, message: "owned" } },
      { ok: false, error: { diagnosticId: { private: "PRIVATE_SIGNAL_REPLY" }, message: "owned" } },
      { ok: false, error: ["PRIVATE_SIGNAL_REPLY"] }, { ok: false, error: "PRIVATE_SIGNAL_REPLY" }, { ok: false, error: null }]) {
      state.route(response => { response.end(JSON.stringify(value)); });
      const before = state.requests();
      await invalid(state.invoke(), "Native broker reply has an invalid response envelope");
      expect(state.requests()).toBe(before + 1);
    }
    state.route(response => { response.end("PRIVATE_SIGNAL_REPLY invalid JSON"); });
    await invalid(state.invoke(), "Native broker reply is invalid JSON");
  } finally { await state.close(); }
}, 20000);

unixTest("actual signaled broker refusal preserves its code diagnostic and disposition", async () => {
  const state = await fixture();
  try {
    state.route(response => { response.end(JSON.stringify({ ok: false, error: { code: "POLICY_DENIED", message: "Owned refusal", diagnosticId: "owned-trace",
      disposition: { delivery: "not-delivered", retry: "unsafe" }, suggestion: "do-not-retry" } })); });
    await expect(state.invoke()).rejects.toMatchObject({ code: "POLICY_DENIED", message: "Owned refusal", diagnosticId: "owned-trace",
      disposition: { delivery: "not-delivered", retry: "unsafe" }, suggestion: "do-not-retry" });
    expect(state.requests()).toBe(1);
  } finally { await state.close(); }
}, 20000);

unixTest("pre-aborted signaled call dispatches no request and preserves caller reason", async () => {
  const state = await fixture();
  try {
    const controller = new AbortController(), reason = new Error("owned-caller-abort"); controller.abort(reason);
    let error: unknown;
    try { await state.invoke(controller.signal); } catch (caught) { error = caught; }
    expect(error).toBe(reason); expect(state.requests()).toBe(0);
  } finally { await state.close(); }
}, 20000);

unixTest("accepted signaled response closed before end rejects once without replay", async () => {
  const state = await fixture();
  try {
    const progress = { prefixQueued: false, reset: false };
    state.route(async response => {
      if (await write(response, Buffer.from('{"ok":true,"result":'))) {
        progress.prefixQueued = true; progress.reset = true; response.destroy();
      }
    });
    let observed: unknown;
    try { await state.invoke(); } catch (error) { observed = error; }
    expect(observed).toBeDefined();
    if (observed instanceof OrbitError) {
      expect(observed.code).toBe("BROKER_ERROR");
      expect(observed.disposition).toEqual({ delivery: "unknown", retry: "unsafe" });
      expect(["Native broker reply could not be read", "Native broker reply is invalid JSON"]).toContain(observed.message);
    } else expect(observed).toBeInstanceOf(Error); // Request-level reset before response callback.
    expect(progress).toEqual({ prefixQueued: true, reset: true });
    expect(state.requests()).toBe(1);
    // Queued bytes are not client-consumption or producer-cancellation proof.
  } finally { await state.close(); }
}, 20000);

unixTest("valid JSON prefix plus 32 MiB overflow cannot resolve success on a late end", async () => {
  const state = await fixture();
  try {
    state.route(async response => {
      const prefix = Buffer.from('{"ok":true,"result":"valid-prefix"}');
      if (!await write(response, prefix)) return;
      const spaces = Buffer.alloc(65536, 32); let remaining = LIMIT + 1 - prefix.length;
      while (remaining > 0) {
        const count = Math.min(remaining, spaces.length);
        if (!await write(response, spaces.subarray(0, count))) return;
        remaining -= count;
      }
      response.end();
    });
    await invalid(state.invoke(), "Native broker reply exceeds its client bound");
    expect(state.requests()).toBe(1);
  } finally { await state.close(); }
}, 30000);

test("isolated exact signal helper rejects overflow before destroy even when end arrives next", async () => {
  const root = await ownedRoot();
  try {
    const shim = join(root.base, "http-events.mjs"), copy = join(root.base, "signal-copy.mjs");
    await writeFile(shim, [
      "import {EventEmitter} from 'node:events';",
      "export const counts={requests:0,destroy:0,end:0};",
      "export function request(options,callback){ counts.requests++;const child=new EventEmitter();",
      "child.destroy=()=>{counts.destroy++;return child;};",
      "child.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.destroy=()=>response;callback(response);",
      "response.emit('data',Buffer.from('{\"ok\":true,\"result\":\"valid-prefix\"}'));",
      "response.emit('data',Buffer.alloc(32*1024*1024+1,32));response.emit('data',Buffer.from('ignored'));",
      "counts.end++;response.emit('end');response.emit('close');child.emit('close');});return child;}",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    const source = await readFile(join(import.meta.dir, "../src/ipc.ts"), "utf8");
    const start = source.indexOf("async function cancellableCall("), end = source.indexOf("/** Bound accepted response-body", start);
    expect(source.split("async function cancellableCall(")).toHaveLength(2);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    let helper = source.slice(start, end);
    const dependency = 'await import("node:http")'; expect(helper.split(dependency)).toHaveLength(2);
    helper = helper.replace(dependency, "await import(" + JSON.stringify(pathToFileURL(shim).href) + ")");
    const isolated = "import {OrbitError} from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href) + ";\n"
      + "import {identityHeaders} from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/caller.ts")).href) + ";\nexport " + helper;
    await writeFile(copy, new Bun.Transpiler({ loader: "ts" }).transformSync(isolated), { mode: 0o600, flag: "wx" });
    const module = await import(pathToFileURL(copy).href) as { cancellableCall(socket: string, method: string, params: unknown, signal: AbortSignal, who: ClientIdentity): Promise<unknown> };
    const hooks = await import(pathToFileURL(shim).href) as { counts: { requests: number; destroy: number; end: number } };
    await invalid(bounded(module.cancellableCall("owned", "owned.fixture", {}, new AbortController().signal, identity)), "Native broker reply exceeds its client bound");
    expect(hooks.counts).toEqual({ requests: 1, destroy: 1, end: 1 });
    // Controlled event-order proof from an isolated production-derived copy,
    // not a claim about OS scheduling or arbitrary producer cancellation.
  } finally { await root.remove(); }
}, 20000);


test("isolated signal event ordering tolerates request close and contains synchronous failures", async () => {
  const root = await ownedRoot();
  try {
    const shim = join(root.base, "ordered-http.mjs"), copy = join(root.base, "ordered-signal.mjs");
    await writeFile(shim, [
      "import {EventEmitter} from 'node:events';",
      "let mode='early-close'; export const counts={requests:0,destroy:0,end:0};",
      "export const reset=value=>{mode=value;counts.requests=0;counts.destroy=0;counts.end=0;};",
      "export class Bytes extends globalThis.Uint8Array {",
      " static [Symbol.hasInstance](value){return value instanceof globalThis.Uint8Array;}",
      " constructor(...args){if(mode==='allocation'&&typeof args[0]==='number')throw new Error('PRIVATE_SIGNAL_REPLY');super(...args);}",
      " set(...args){if(mode==='copy')throw new Error('PRIVATE_SIGNAL_REPLY');return super.set(...args);}",
      "}",
      "export function request(options,callback){counts.requests++;if(mode==='request')throw new Error('PRIVATE_SIGNAL_REPLY');",
      "const child=new EventEmitter(),response=new EventEmitter();response.destroy=()=>response;",
      "child.destroy=()=>{counts.destroy++;child.emit('close');return child;};",
      "const original=response.on;response.on=function(event,listener){original.call(this,event,listener);",
      " if(event==='data'&&mode==='sync-registration'){this.emit('data','bad');this.emit('end');}return this;};",
      "const deliver=()=>{callback(response);if(mode==='early-close')child.emit('close');",
      " response.emit('data',mode==='bad-chunk'?'PRIVATE_SIGNAL_REPLY':Buffer.from('{\"ok\":true,\"result\":\"late-body\"}'));",
      " counts.end++;response.emit('end');response.emit('error',new Error('PRIVATE_SIGNAL_REPLY'));response.emit('close');",
      " child.emit('error',new Error('PRIVATE_SIGNAL_REPLY'));child.emit('close');};",
      "child.end=()=>{if(mode==='end')throw new Error('PRIVATE_SIGNAL_REPLY');queueMicrotask(deliver);};",
      "if(mode==='sync-registration')callback(response);return child;}",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    const source = await readFile(join(import.meta.dir, "../src/ipc.ts"), "utf8");
    const start = source.indexOf("async function cancellableCall("), end = source.indexOf("/** Bound accepted response-body", start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const dependency = 'await import("node:http")', helper = source.slice(start, end);
    expect(helper.split(dependency)).toHaveLength(2);
    const imports = "import {OrbitError} from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href) + ";\n"
      + "import {identityHeaders} from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/caller.ts")).href) + ";\n"
      + "import {Bytes as Uint8Array} from " + JSON.stringify(pathToFileURL(shim).href) + ";\nexport ";
    await writeFile(copy, new Bun.Transpiler({ loader: "ts" }).transformSync(imports + helper.replace(dependency,
      "await import(" + JSON.stringify(pathToFileURL(shim).href) + ")")), { mode: 0o600, flag: "wx" });
    const module = await import(pathToFileURL(copy).href) as { cancellableCall(socket: string, method: string, params: unknown, signal: AbortSignal, who: ClientIdentity): Promise<unknown> };
    const hooks = await import(pathToFileURL(shim).href) as { reset(mode: string): void; counts: { requests: number; destroy: number; end: number } };
    for (const mode of ["early-close", "request", "end", "bad-chunk", "sync-registration", "allocation", "copy"]) {
      hooks.reset(mode);
      const controller = new AbortController();
      const work = bounded(module.cancellableCall("owned", "owned.fixture", {}, controller.signal, identity));
      if (mode === "early-close") {
        expect(await work).toBe("late-body");
        expect(hooks.counts.destroy).toBe(0);
      } else {
        await invalid(work, "Native broker reply could not be read");
        expect(hooks.counts.destroy).toBe(mode === "request" ? 0 : 1);
      }
      expect(hooks.counts.requests).toBe(1);
      const before = { ...hooks.counts };
      controller.abort(new Error("owned-after-settlement"));
      expect(hooks.counts).toEqual(before);
    }
    // Private dependency substitution only, not OS scheduling or cancellation proof.
  } finally { await root.remove(); }
}, 20000);
