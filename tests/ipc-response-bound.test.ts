import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { call, callPatient } from "../src/ipc";
import { OrbitError } from "../src/errors";
import type { ClientIdentity } from "../src/caller";

const unixTest = process.platform === "linux" ? test : test.skip;
const LIMIT = 32 * 1024 * 1024;
const client: ClientIdentity = { claim: { v: 1, kind: "client", pid: process.pid } };
async function bounded<T>(work: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Owned IPC fixture remains unconfirmed")), ms);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function fixture() {
  const prefix = "orbit-ipc-bound-", created = await mkdtemp(join(tmpdir(), prefix));
  const base = await realpath(created), parent = await realpath(dirname(created)), socket = join(base, "b.sock");
  const streams = new Set<Promise<void>>(), handlers = new Set<Promise<Response>>(), clients = new Set<Promise<unknown>>();
  let requests = 0, pulls = 0, completed = 0, canceled = 0, closing = false;
  const track = <T>(set: Set<Promise<T>>, promise: Promise<T>) => {
    set.add(promise);
    void promise.then(() => set.delete(promise), () => set.delete(promise));
    return promise;
  };
  const stream = (next: () => Uint8Array | undefined) => {
    let resolve!: () => void, terminal = false;
    const done = new Promise<void>(finish => { resolve = finish; });
    track(streams, done);
    const finish = () => { if (!terminal) { terminal = true; resolve(); } };
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        const chunk = next();
        if (chunk === undefined) { controller.close(); completed++; finish(); }
        else controller.enqueue(chunk);
      },
      cancel() { canceled++; finish(); },
    });
  };
  const bytes = (chunks: Uint8Array[]) => {
    let index = 0;
    return new Response(stream(() => chunks[index++]), { headers: { "Content-Type": "application/json" } });
  };
  const large = (size: number, secret = "") => {
    const prefix = Buffer.from('{"ok":true,"result":"' + secret), suffix = Buffer.from('"}');
    const fill = Buffer.alloc(65536, 97); // One immutable reusable source chunk.
    let remaining = size - prefix.byteLength - suffix.byteLength, stage = 0;
    return new Response(stream(() => {
      if (stage++ === 0) return prefix;
      if (remaining > 0) { const count = Math.min(remaining, fill.byteLength); remaining -= count; return fill.subarray(0, count); }
      if (remaining === 0) { remaining = -1; return suffix; }
      return undefined;
    }));
  };
  let route: () => Response = () => Response.json({ ok: true, result: "owned" });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ unix: socket, fetch(request) {
      const admitted = !closing;
      const work = (async () => {
        if (!admitted) return new Response(null, { status: 503, headers: { Connection: "close" } });
        await request.json(); requests++; return route();
      })();
      return track(handlers, work);
    } });
  } catch { throw new Error("Owned IPC listener startup unconfirmed; fixture retained"); }
  const invoke = (patient = false, beforeAttempt?: () => Promise<void>, sleep?: (ms: number) => Promise<unknown>) => {
    const work = patient ? callPatient(socket, "owned.fixture", {}, client, 100, sleep, beforeAttempt)
      : call(socket, "owned.fixture", {}, undefined, client);
    return bounded(track(clients, work));
  };
  return { bytes, large, invoke, route: (next: typeof route) => { route = next; },
    counts: () => ({ requests, pulls, completed, canceled }),
    close: async () => {
      closing = true; // Close new admissions before draining accepted source work.
      try {
        const listenerStopped = Promise.resolve(server.stop(false));
        // Source completion/cancel and handler settlement are scoped test evidence,
        // not proof of producer stop for arbitrary production brokers.
        await bounded(Promise.all([Promise.allSettled([...clients, ...handlers, ...streams]), listenerStopped]), 5000);
        if (clients.size || handlers.size || streams.size) throw new Error("Owned IPC work remains unsettled");
      } catch { server.unref(); throw new Error("Owned IPC fixture retained because stream/handler completion is unknown"); }
      const info = await lstat(base);
      if (dirname(base) !== parent || !basename(base).startsWith(prefix) || await realpath(base) !== base
          || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing cleanup outside owned IPC fixture");
      await rm(base, { recursive: true, force: true });
    } };
}
async function brokerError(work: Promise<unknown>): Promise<OrbitError> {
  let error: unknown;
  try { await work; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(OrbitError);
  expect(error).toMatchObject({ code: "BROKER_ERROR", disposition: { delivery: "unknown", retry: "unsafe" } });
  return error as OrbitError;
}

unixTest("normal call preserves streamed Unicode BOM and nonfatal UTF-8 JSON semantics", async () => {
  const state = await fixture();
  try {
    const body = Buffer.from('\ufeff' + JSON.stringify({ ok: true, result: { text: "😀 café" } }));
    state.route(() => state.bytes(Array.from(body, byte => Uint8Array.of(byte))));
    expect(await state.invoke()).toEqual({ text: "😀 café" });
    state.route(() => state.bytes([Buffer.from('{"ok":true,"result":"'), Uint8Array.of(255, 195), Buffer.from('"}')]));
    expect(await state.invoke()).toBe("\ufffd\ufffd");
    expect(state.counts().requests).toBe(2);
  } finally { await state.close(); }
}, 20000);

unixTest("normal and patient calls preserve broker refusal metadata without replay", async () => {
  const state = await fixture();
  try {
    state.route(() => Response.json({ ok: false, error: { code: "POLICY_DENIED", message: "Owned broker refusal",
      diagnosticId: "owned-trace", disposition: { delivery: "not-delivered", retry: "unsafe" }, suggestion: "do-not-retry" } }));
    for (const patient of [false, true]) await expect(state.invoke(patient)).rejects.toMatchObject({ code: "POLICY_DENIED",
      message: "Owned broker refusal", diagnosticId: "owned-trace", disposition: { delivery: "not-delivered", retry: "unsafe" }, suggestion: "do-not-retry" });
    expect(state.counts().requests).toBe(2);
  } finally { await state.close(); }
}, 20000);

unixTest("empty and malformed replies fail with fixed content-free BROKER_ERROR", async () => {
  const state = await fixture();
  try {
    const secret = "PRIVATE_MALFORMED_BROKER_BYTES";
    state.route(() => state.bytes([Buffer.from(secret)]));
    const malformed = await brokerError(state.invoke());
    expect(malformed.message).toBe("Native broker reply is invalid JSON");
    expect(JSON.stringify(malformed)).not.toContain(secret);
    expect(malformed.stack).not.toContain(secret);
    state.route(() => new Response(null, { status: 204 }));
    expect((await brokerError(state.invoke())).message).toBe("Native broker reply is invalid JSON");
    expect(state.counts().requests).toBe(2);
  } finally { await state.close(); }
}, 20000);

unixTest("exactly 32 MiB accepted body is decoded once and remains valid", async () => {
  const state = await fixture();
  try {
    const prefix = Buffer.byteLength('{"ok":true,"result":"'), suffix = Buffer.byteLength('"}');
    state.route(() => state.large(LIMIT));
    const value = await state.invoke();
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(LIMIT - prefix - suffix);
    expect(state.counts().requests).toBe(1);
    expect(state.counts().completed).toBe(1);
  } finally { await state.close(); }
}, 25000);

unixTest("32 MiB plus one streamed byte is refused before JSON parsing for call and callPatient", async () => {
  const state = await fixture();
  try {
    const secret = "PRIVATE_OVERSIZE_BROKER_BYTES";
    state.route(() => state.large(LIMIT + 1, secret));
    let attempts = 0, sleeps = 0;
    for (const patient of [false, true]) {
      const error = await brokerError(state.invoke(patient, async () => { attempts++; }, async () => { sleeps++; }));
      expect(error.message).toBe("Native broker reply exceeds its client bound");
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error.stack).not.toContain(secret);
    }
    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
    expect(state.counts().requests).toBe(2);
    expect(state.counts().pulls).toBeGreaterThan(2);
  } finally { await state.close(); }
}, 35000);


test("isolated production reader bounds tiny-chunk slabs and validates boundary UTF-8 and read cleanup", async () => {
  const prefixName = "orbit-ipc-reader-unit-", created = await mkdtemp(join(tmpdir(), prefixName));
  const base = await realpath(created), parent = await realpath(dirname(created));
  try {
    const shim = join(base, "allocations.mjs"), modulePath = join(base, "reader.mjs");
    await writeFile(shim, [
      "export const allocations=[];",
      "export class CountingBytes extends globalThis.Uint8Array {",
      "  constructor(...args){super(...args);if(args.length===1&&typeof args[0]==='number')allocations.push(args[0]);}",
      "}",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    const source = await readFile(join(import.meta.dir, "../src/ipc.ts"), "utf8");
    const start = source.indexOf("async function readBrokerJson(");
    const end = source.indexOf("/** " + String.fromCharCode(96) + "identity", start);
    expect(source.split("async function readBrokerJson(")).toHaveLength(2);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const helper = source.slice(start, end);
    const isolated = "import {OrbitError} from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href) + ";\n"
      + "import {CountingBytes as Uint8Array} from " + JSON.stringify(pathToFileURL(shim).href) + ";\nexport " + helper;
    await writeFile(modulePath, new Bun.Transpiler({ loader: "ts" }).transformSync(isolated), { mode: 0o600, flag: "wx" });
    const module = await import(pathToFileURL(modulePath).href) as { readBrokerJson(response: Response): Promise<unknown> };
    const hooks = await import(pathToFileURL(shim).href) as { allocations: number[] };
    // Isolated production-derived helper copy. Actual call()/callPatient() HTTP
    // integration is above. No global builtin/fetch mocks or production test API.
    const head = Buffer.from('{"ok":true,"result":"'), tail = Buffer.from('"}'), size = 2 * 65536 + 1;
    const body = Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 97), tail]);
    let offset = 0, reads = 0;
    const tiny = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === body.length) { controller.close(); return; }
      const next = Math.min(offset + 3, body.length);
      controller.enqueue(body.subarray(offset, next)); offset = next; reads++;
    } }));
    const decoded = await bounded(module.readBrokerJson(tiny)) as { ok: boolean; result: string };
    expect(decoded.ok).toBe(true);
    expect(decoded.result.length).toBe(size - head.length - tail.length);
    expect(reads).toBe(Math.ceil(size / 3));
    expect(hooks.allocations).toEqual([65536, 65536, 65536]);
    expect(hooks.allocations.length).toBeLessThanOrEqual(512);
    expect(tiny.body?.locked).toBe(false);

    hooks.allocations.length = 0;
    const bom = Buffer.from([239, 187, 191]), padding = 65535 - bom.length - head.length;
    const utf8 = Buffer.concat([bom, head, Buffer.alloc(padding, 97), Buffer.from("😀"), tail]);
    const boundary = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(utf8.subarray(0, 1)); controller.enqueue(utf8.subarray(1, 2));
      controller.enqueue(utf8.subarray(2)); controller.close();
    } }));
    const unicode = await bounded(module.readBrokerJson(boundary)) as { ok: boolean; result: string };
    expect(unicode.ok).toBe(true);
    expect(unicode.result.length).toBe(padding + 2);
    expect(unicode.result.slice(-2)).toBe("😀");
    expect(unicode.result.includes("\ufffd")).toBe(false);
    expect(hooks.allocations).toEqual([65536, 65536]);
    expect(boundary.body?.locked).toBe(false);

    hooks.allocations.length = 0;
    const tooLarge = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(LIMIT + 1)); controller.close();
    } }));
    expect((await brokerError(bounded(module.readBrokerJson(tooLarge)))).message).toBe("Native broker reply exceeds its client bound");
    expect(hooks.allocations).toEqual([]); // Size refusal precedes allocation/copy.
    expect(tooLarge.body?.locked).toBe(false);

    const secret = "PRIVATE_READER_FAILURE";
    const brokenBody = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } });
    const realReader = brokenBody.getReader();
    let cancelCalls = 0, releaseCalls = 0;
    const broken = new Response(null);
    Object.defineProperty(broken, "body", { value: { getReader: () => ({
      read: () => realReader.read(),
      cancel: () => { cancelCalls++; return Promise.reject(new Error(secret)); },
      releaseLock: () => { releaseCalls++; realReader.releaseLock(); },
    }) } });
    const error = await brokerError(bounded(module.readBrokerJson(broken)));
    expect(error.message).toBe("Native broker reply could not be read");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
    expect(cancelCalls).toBe(1); expect(releaseCalls).toBe(1);
    expect(brokenBody.locked).toBe(false);
    expect(hooks.allocations).toEqual([]);
    // Rejected cancellation is observed, not upgraded into producer-stop proof.
    await Promise.resolve();
  } finally {
    const info = await lstat(base);
    if (dirname(base) !== parent || !basename(base).startsWith(prefixName) || await realpath(base) !== base
        || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing cleanup outside owned reader fixture");
    await rm(base, { recursive: true, force: true });
  }
}, 20000);


unixTest("normal and patient calls reject malformed JSON envelopes without raw errors or replay", async () => {
  const state = await fixture();
  try {
    const secret = "PRIVATE_INVALID_ENVELOPE";
    const envelopes: unknown[] = [null, secret, [], {}, { ok: null }, { ok: 1 }, { ok: secret }];
    for (const value of envelopes) {
      state.route(() => Response.json(value));
      for (const patient of [false, true]) {
        const before = state.counts().requests;
        let attempts = 0, sleeps = 0;
        const error = await brokerError(state.invoke(patient, async () => { attempts++; }, async () => { sleeps++; }));
        expect(error.message).toBe("Native broker reply has an invalid response envelope");
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(error.stack).not.toContain(secret);
        expect(state.counts().requests).toBe(before + 1);
        expect(attempts).toBe(patient ? 1 : 0);
        expect(sleeps).toBe(0);
      }
    }
  } finally { await state.close(); }
}, 20000);
