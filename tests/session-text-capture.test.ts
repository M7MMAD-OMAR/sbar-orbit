import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { NativeBackend } from "../src/hyprland";
import { NativeWorker } from "../src/native-worker";
import { Sessions } from "../src/session";
import { createMcpServer, orbitBatchShape } from "../src/mcp";
import { createSessionMcpServer } from "../src/session-mcp";
import { nativeApplicationPolicy, narrow, type JournalEntry } from "../src/policy";
import { OrbitError, record } from "../src/errors";
import { errorPayload } from "../src/error-disposition";
import { renderAct } from "../src/observation-output";

const target = { appId: "a".repeat(32), windowId: "b".repeat(32) };
const tree = { status: "ok", complete: true, nodes: [{ role: "label", name: "PRIVATE owned readback" }] };
const actions = ["1", "+", "2", "Return"].map(key => ({ type: "key", ...target, key }));
const schema = z.object(orbitBatchShape);
async function fixture() {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const controls: { fallback: boolean; failure?: Error; input?: () => Promise<void> } = { fallback: false };
  const windows = [{ ...target, title: "Owned current title", width: 100, height: 80 }];
  const worker = { request: async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (params.type === "windows") return { windows };
    if (params.type !== "observe") { await controls.input?.(); return { acknowledged: true }; }
    if (params.digestOnly) return { sha256: "c".repeat(64) };
    if (controls.failure) throw controls.failure;
    const text = params.format === "text" && !controls.fallback;
    return { ...target, windows, width: 100, height: 80, surfaceWidth: 100, surfaceHeight: 80, pointer: null,
      capturedAt: 1, mimeType: text ? "text/x-orbit-a11y" : "image/png", ...(text ? {} : { image: "owned-pixels" }),
      ...(params.format === "text" || params.format === "both" ? { tree: controls.fallback ? { status: "unavailable" } : tree } : {}),
      observation: { requestedFormat: params.format ?? "image", treeNodes: text || params.format === "both" ? 1 : 0 } };
  } };
  const Constructor = NativeBackend as unknown as new (worker: unknown, directory: string, options: unknown) => NativeBackend;
  const backend = new Constructor(worker, "/owned-text-fixture", {});
  (Reflect.get(backend, "applications") as Set<string>).add(target.appId);
  await backend.act({ type: "windows", appId: target.appId });
  requests.length = 0;
  const session = { id: crypto.randomUUID(), state: "running", backend, kind: "native", lease: "owned-fixture",
    tail: Promise.resolve(), requests: new Map(), policy: { ...nativeApplicationPolicy }, journal: [] as JournalEntry[], tainted: false };
  const sessions = Object.create(Sessions.prototype) as Sessions;
  Reflect.set(sessions, "sessions", new Map([[session.id, session]]));
  Reflect.set(sessions, "record", async (_session: unknown, entry: JournalEntry) => { session.journal.push(entry); });
  const act = (capture: unknown, requestId = "owned-batch") => sessions.act({ sessionId: session.id, requestId, actions, capture });
  return { backend, session, sessions, requests, controls, act };
}

function observations(requests: { params: Record<string, unknown> }[]) {
  return requests.filter(request => request.params.type === "observe").map(request => request.params);
}

test("text batch returns same-call untrusted readback with no baseline or pixel settle", async () => {
  const f = await fixture();
  const result = record(await f.act({ format: "text", timeoutMs: 700 }));
  expect(result.completed).toBe(4);
  expect((result.receipts as unknown[]).map(receipt => record(receipt).status)).toEqual(["ok", "ok", "ok", "ok"]);
  expect(observations(f.requests)).toEqual([{ type: "observe", ...target, format: "text", observationTimeoutMs: 700 }]);
  const capture = record(result.capture);
  expect(capture.tree).toEqual(tree);
  expect(capture).not.toHaveProperty("image");
  expect(capture).not.toHaveProperty("settle");
  const rendered = renderAct(result);
  expect(rendered.content.some(block => block.type === "image")).toBe(false);
  expect(rendered.content.filter(block => block.type === "text").at(-1)).toMatchObject({ type: "text" });
  expect(JSON.stringify(rendered.content)).toContain("UNTRUSTED APPLICATION DATA");
  expect(JSON.stringify(rendered.content)).toContain("PRIVATE owned readback");
  expect(record(record(rendered.structuredContent).capture).tree).toEqual(tree);
  const first = rendered.content[0];
  if (first?.type !== "text") throw new Error("Missing receipt summary");
  expect(first.text).not.toContain("PRIVATE owned readback");
  expect(JSON.stringify(f.session.journal)).not.toContain("PRIVATE owned readback");
});

test("cached text duplicate preserves receipts and metrics but no raw tree or repeated work", async () => {
  const f = await fixture();
  const first = record(await f.act({ format: "text" }));
  const count = f.requests.length;
  const replay = record(await f.act({ format: "text" }));
  expect(replay.receipts).toEqual(first.receipts);
  const capture = record(replay.capture);
  expect(capture.expired).toBe(true);
  expect(capture.observation).toEqual(record(first.capture).observation);
  expect(await f.session.tail).toBeUndefined();
  expect(record(first.capture).tree).toEqual(tree);
  expect(capture).not.toHaveProperty("tree"); expect(capture).not.toHaveProperty("image");
  expect(JSON.stringify(replay)).not.toContain("PRIVATE owned readback");
  expect(JSON.stringify(renderAct(replay))).not.toContain("PRIVATE owned readback");
  expect(JSON.stringify(f.session.journal)).not.toContain("PRIVATE owned readback");
  expect(f.requests.length).toBe(count);
});

test("session rejection queue tail resolves void without retaining the rejection", async () => {
  const f = await fixture();
  const result = f.act({ format: "text" });
  f.session.state = "closing";
  await expect(result).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  expect(await f.session.tail).toBeUndefined();
  expect(f.requests).toEqual([]);
});

test("worker serialization tail resolves void on success and failure while caller gets original frame", async () => {
  const worker = Object.create(NativeWorker.prototype) as NativeWorker;
  Reflect.set(worker, "tail", Promise.resolve());
  Reflect.set(worker, "queued", 0);
  Reflect.set(worker, "bytes", 0);
  Reflect.set(worker, "fragments", []);
  Reflect.set(worker, "ended", false);
  let fail = false;
  Reflect.set(worker, "abort", (error: unknown) => { throw error; });
  Reflect.set(worker, "stdin", { write: (bytes: Buffer, callback: (error?: Error) => void) => {
    const request = record(JSON.parse(bytes.toString("utf8")));
    callback();
    const response = fail ? { requestId: request.requestId, ok: false,
      error: { code: "CAPTURE_UNAVAILABLE", message: "private provider diagnostic" } } :
      { requestId: request.requestId, ok: true, result: { tree, image: "PRIVATE original pixels" } };
    queueMicrotask(() => Reflect.apply(Reflect.get(NativeWorker.prototype, "receive"), worker,
      [Buffer.from(JSON.stringify(response) + "\n")]));
  } });
  const first = record(await worker.request("act", { type: "observe" }));
  expect(first.tree).toEqual(tree);
  expect(first.image).toBe("PRIVATE original pixels");
  expect(await Reflect.get(worker, "tail")).toBeUndefined();
  expect(Reflect.get(worker, "queued")).toBe(0);
  fail = true;
  await expect(worker.request("act", { type: "observe" })).rejects.toMatchObject({ code: "CAPTURE_UNAVAILABLE" });
  expect(await Reflect.get(worker, "tail")).toBeUndefined();
  expect(Reflect.get(worker, "queued")).toBe(0);
  expect(first.tree).toEqual(tree);
});

test("explicit image and omitted format have identical legacy fingerprint and wire", async () => {
  const f = await fixture();
  await f.act({});
  const before = f.requests.length;
  await f.act({ format: "image" });
  expect(f.requests.length).toBe(before);
  expect(observations(f.requests)).toEqual([
    { type: "observe", ...target, digestOnly: true },
    { type: "observe", ...target, since: "c".repeat(64), timeoutMs: 1500 },
  ]);
});

test("both retains image baseline and settle options and returns both framed readbacks", async () => {
  const f = await fixture();
  const result = await f.act({ format: "both", timeoutMs: 900, quietMs: 200 });
  expect(observations(f.requests)).toEqual([
    { type: "observe", ...target, digestOnly: true },
    { type: "observe", ...target, format: "both", since: "c".repeat(64), timeoutMs: 900, quietMs: 200 },
  ]);
  const rendered = renderAct(result);
  expect(rendered.content.some(block => block.type === "image")).toBe(true);
  expect(JSON.stringify(rendered.content)).toContain("UNTRUSTED APPLICATION DATA");
  expect(record(record(rendered.structuredContent).capture).tree).toEqual(tree);
  const replay = record(await f.act({ format: "both", timeoutMs: 900, quietMs: 200 }));
  expect(record(replay.capture)).not.toHaveProperty("tree");
});

test("invalid capture format and text settle controls refuse before any input or baseline", async () => {
  for (const capture of [{ format: "text", quietMs: 20 }, { format: "text", graceMs: 0 },
    { format: "image", graceMs: 0 }, { format: "both", graceMs: 0 }, { format: "unknown" },
    { format: "text", timeoutMs: 99 }, { format: "text", timeoutMs: 3001 }]) {
    const f = await fixture();
    expect(schema.safeParse({ capture }).success).toBe(false);
    expect(() => f.act(capture)).toThrow();
    expect(f.requests).toEqual([]);
    expect(f.session.requests.size).toBe(0);
  }
});

test("format changes with same request identity conflict without replay", async () => {
  const f = await fixture(); await f.act({ format: "text" });
  const count = f.requests.length;
  expect(() => f.act({ format: "both" })).toThrow("Request ID already used with different arguments");
  expect(f.requests.length).toBe(count);
});

test("text fallback is one bounded image observation without image baseline or settle", async () => {
  const f = await fixture(); f.controls.fallback = true;
  const result = record(await f.act({ format: "text", timeoutMs: 500 }));
  expect(record(result.capture).mimeType).toBe("image/png");
  expect(record(result.capture).tree).toEqual({ status: "unavailable" });
  expect(record(result.capture)).not.toHaveProperty("settle");
  expect(observations(f.requests)).toEqual([{ type: "observe", ...target, format: "text", observationTimeoutMs: 500 }]);
});

test("failed text read preserves input acknowledgements and unknown unsafe capture error", async () => {
  const f = await fixture(); f.controls.failure = new OrbitError("CAPTURE_DEADLINE_EXCEEDED", "Owned fixed failure");
  const result = record(await f.act({ format: "text" }));
  expect(result.completed).toBe(4);
  expect(record(result.captureError)).toMatchObject({ code: "CAPTURE_DEADLINE_EXCEEDED", disposition: { delivery: "unknown", retry: "unsafe" } });
  const count = f.requests.length; await f.act({ format: "text" }); expect(f.requests.length).toBe(count);
});

test("read permission narrowed during last input prevents post-action text query", async () => {
  const f = await fixture(); let count = 0;
  f.controls.input = async () => { if (++count === 4) f.session.policy = narrow(f.session.policy, { allow: ["write"] }); };
  const result = record(await f.act({ format: "text" }));
  expect(result.completed).toBe(4);
  expect(record(result.captureError).code).toBe("POLICY_DENIED");
  expect(observations(f.requests)).toEqual([]);
});

test("both MCP surfaces return text tree in same act call using shared capture schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-text-mcp-"));
  const socket = join(root, "broker.sock"), previous = process.env.ORBIT_USAGE_DIR;
  process.env.ORBIT_USAGE_DIR = join(root, "usage");
  const f = await fixture();
  const broker = Bun.serve({ unix: socket, async fetch(request) {
    const body = record(await request.json());
    try { return Response.json({ ok: true, result: await f.sessions.act(record(body.params)) }); }
    catch (error) { return Response.json({ ok: false, error: errorPayload(error, "BACKEND_ERROR", "Owned fixture failed") }); }
  } });
  try {
    for (const [index, server] of [createMcpServer(socket), createSessionMcpServer(socket, f.session.id)].entries()) {
      const client = new Client({ name: "text-readback-fixture", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(b); await client.connect(a);
        const response = CallToolResultSchema.parse(await client.callTool({ name: "orbit_act",
          arguments: { sessionId: f.session.id, requestId: "mcp-" + index, actions, capture: { format: "text", timeoutMs: 500 } } }));
        expect(response.isError).not.toBe(true);
        expect(record(record(response.structuredContent).capture).tree).toEqual(tree);
        expect(JSON.stringify(response.content)).toContain("UNTRUSTED APPLICATION DATA");
        expect(response.content.some(block => block.type === "image")).toBe(false);
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    broker.stop(true);
    if (previous === undefined) delete process.env.ORBIT_USAGE_DIR; else process.env.ORBIT_USAGE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
