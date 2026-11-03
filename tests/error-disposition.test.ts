import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { OrbitError, normalizeDisposition, unknownDisposition, record } from "../src/errors";
import { nativeApplicationPolicy } from "../src/policy";
import { errorPayload, preflightDisposition, refusedDisposition } from "../src/error-disposition";
import { call, callPatient } from "../src/ipc";
import { createMcpServer } from "../src/mcp";
import { createSessionMcpServer } from "../src/session-mcp";
import { Diagnostics } from "../src/diagnostics";
import { Sessions } from "../src/session";

const payload = (error: unknown): Record<string, unknown> => errorPayload(error, "BACKEND_ERROR", "Request failed");

test("broad codes and transport exceptions never imply safe replay", () => {
  for (const code of ["INVALID_REQUEST", "STALE_REF", "TARGET_CLOSED", "POLICY_DENIED", "UNSUPPORTED", "BACKEND_ERROR", "BROKER_UNAVAILABLE", "TIMEOUT", "ECONNREFUSED"])
    expect(normalizeDisposition(new OrbitError(code, "failure"))).toEqual(unknownDisposition);
  for (const error of [new Error("secret application text"), new DOMException("secret", "TimeoutError"),
    new DOMException("secret", "AbortError"), { code: "INVALID_REQUEST", ...preflightDisposition, text: "secret" }])
    expect(payload(error)).toEqual({ code: "BACKEND_ERROR", message: "Request failed", ...unknownDisposition });
});

test("explicit preflight preserves compatibility and strips arbitrary metadata", () => {
  const error = new OrbitError("INVALID_REQUEST", "Invalid action", "trace-id", { ...preflightDisposition, text: "secret" });
  expect(error).toBeInstanceOf(Error);
  expect(payload(error)).toEqual({ code: "INVALID_REQUEST", message: "Invalid action", diagnosticId: "trace-id", ...preflightDisposition });
  expect(normalizeDisposition(new OrbitError("POLICY_DENIED", "Denied", undefined, refusedDisposition))).toEqual(refusedDisposition);
});

test("incoherent or content-bearing metadata degrades to unknown", () => {
  for (const value of [undefined, null, [], {},
    { disposition: { delivery: "delivered", retry: "safe" }, suggestion: "correct-request" },
    { disposition: { delivery: "unknown", retry: "safe" }, suggestion: "correct-request" },
    { disposition: { delivery: "not-delivered", retry: "safe" }, suggestion: "secret application text" }])
    expect(normalizeDisposition(value)).toEqual(unknownDisposition);
  expect(normalizeDisposition({ disposition: { delivery: "delivered", retry: "unsafe", text: "secret" },
    suggestion: "observe-before-retry", stack: "secret" })).toEqual({
      disposition: { delivery: "delivered", retry: "unsafe" }, suggestion: "observe-before-retry" });
});

test("single-action parser failure is preflight without admitting work", () => {
  let admitted = 0;
  const context = {
    get: () => ({ backend: { parseAction: () => { throw new OrbitError("INVALID_REQUEST", "Invalid action"); } } }),
    ensureOpen: () => {}, decided: () => { admitted++; },
  };
  try {
    Reflect.apply(Sessions.prototype.act, context, [{ sessionId: "fixture", requestId: "fixture", action: {} }]);
    throw new Error("Expected parser refusal");
  } catch (error) { expect(normalizeDisposition(error)).toEqual(preflightDisposition); }
  expect(admitted).toBe(0);
});

test("batch per-action errors retain proof without deriving safety from receipt status", async () => {
  const runBatch = Reflect.get(Sessions.prototype, "runBatch");
  for (const failure of [new OrbitError("INVALID_REQUEST", "Invalid worker request", "trace"),
    new OrbitError("POLICY_DENIED", "Denied", "trace", refusedDisposition),
    new OrbitError("INVALID_REQUEST", "Preflight", "trace", preflightDisposition),
    new DOMException("secret application text", "TimeoutError"), new Error("secret application text")]) {
    let attempts = 0;
    const context = { ensureOpen: () => {}, admit: () => async () => { attempts++; throw failure; } };
    const result = record(await Reflect.apply(runBatch, context, [
      { state: "running" }, [{ type: "move" }, { type: "move" }], undefined, "fixture",
    ]));
    expect(attempts).toBe(1);
    expect(Array.isArray(result.receipts)).toBe(true);
    const receipts = result.receipts as unknown[];
    const first = record(receipts[0]), second = record(receipts[1]);
    expect(normalizeDisposition(first.error)).toEqual(normalizeDisposition(failure));
    expect(second.status).toBe("not-attempted");
    expect(JSON.stringify(first.error)).not.toContain("secret application text");
    if (failure instanceof OrbitError) expect(record(first.error).diagnosticId).toBe("trace");
  }
});

test("capture errors remain conservative even after earlier batch input succeeded", async () => {
  const runBatch = Reflect.get(Sessions.prototype, "runBatch");
  for (const mode of ["capture-failed", "capture-denied", "not-attempted"] as const) {
    let attempts = 0, observations = 0;
    const context = { ensureOpen: () => {}, record: async () => {}, admit: () => async () => { attempts++; return {}; } };
    const session = { id: "fixture", journal: [], state: mode === "not-attempted" ? "paused" : "running",
      policy: mode === "capture-denied" ? { ...nativeApplicationPolicy, allow: [] } : nativeApplicationPolicy,
      backend: { baseline: async () => "fixture-digest", observe: async () => {
        observations++; throw new Error("secret application text");
      } } };
    const result = record(await Reflect.apply(runBatch, context, [session,
      [{ type: "move", appId: "fixture", windowId: "fixture" }], { timeoutMs: 100 }, "fixture"]));
    expect(normalizeDisposition(result.captureError)).toEqual(unknownDisposition);
    expect(record(result.captureError).code).toBe(mode === "capture-failed" ? "BACKEND_ERROR" : mode === "capture-denied" ? "POLICY_DENIED" : "NOT_ATTEMPTED");
    expect(attempts).toBe(mode === "not-attempted" ? 0 : 1);
    expect(observations).toBe(mode === "capture-failed" ? 1 : 0);
    expect(JSON.stringify(result.captureError)).not.toContain("secret application text");
  }
});

test("diagnostics preserves direct proof but not aggregate cleanup uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-error-diagnostics-"));
  const diagnostics = new Diagnostics(root);
  try {
    const preflight = new OrbitError("INVALID_REQUEST", "Invalid action", undefined, preflightDisposition);
    for (const [error, expected] of [[preflight, preflightDisposition],
      [new AggregateError([preflight, new Error("cleanup failed")]), unknownDisposition]] as const) {
      let caught = false;
      try { await diagnostics.run({ method: "session.act" }, async () => { throw error; }); }
      catch (result) {
        caught = true;
        expect(normalizeDisposition(result)).toEqual(expected);
        expect(result).toBeInstanceOf(OrbitError);
        expect((result as OrbitError).diagnosticId).toBeString();
      }
      expect(caught).toBe(true);
    }
  } finally {
    await diagnostics.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("post-dispatch malformed acknowledgement remains unknown and is not retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-error-uncertain-"));
  const socket = join(root, "broker.sock");
  let delivered = 0;
  const broker = Bun.serve({ unix: socket, fetch() { delivered++; return new Response("not JSON"); } });
  try {
    for (const signal of [undefined, new AbortController().signal]) {
      let caught = false;
      try { await call(socket, "session.act", {}, signal); }
      catch (error) { caught = true; expect(normalizeDisposition(error)).toEqual(unknownDisposition); }
      expect(caught).toBe(true);
    }
    let caught = false;
    try { await callPatient(socket, "session.act"); }
    catch (error) { caught = true; expect(normalizeDisposition(error)).toEqual(unknownDisposition); }
    expect(caught).toBe(true);
    expect(delivered).toBe(3);
  } finally { broker.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("broker clients and both MCP surfaces propagate disposition without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-error-wire-"));
  const socket = join(root, "broker.sock");
  let requests = 0;
  let response: Record<string, unknown> = payload(new OrbitError("INVALID_REQUEST", "Invalid action", "trace", preflightDisposition));
  const broker = Bun.serve({ unix: socket, fetch() { requests++; return Response.json({ ok: false, error: response }); } });
  try {
    for (const signal of [undefined, new AbortController().signal]) {
      try { await call(socket, "session.act", {}, signal); throw new Error("Expected broker refusal"); }
      catch (error) { expect(payload(error)).toEqual(response); }
    }
    const beforePatient = requests;
    await expect(callPatient(socket, "session.act")).rejects.toBeInstanceOf(OrbitError);
    expect(requests).toBe(beforePatient + 1);
    for (const server of [createMcpServer(socket), createSessionMcpServer(socket, crypto.randomUUID())]) {
      const client = new Client({ name: "disposition-fixture", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = CallToolResultSchema.parse(await client.callTool({ name: "orbit_observe", arguments: { sessionId: "fixture" } }));
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(response);
        const first = result.content[0];
        expect(first?.type).toBe("text");
        if (first?.type === "text") expect(JSON.parse(first.text)).toEqual(response);
      } finally { await client.close(); await server.close(); }
    }
    for (const legacy of [{ code: "INVALID_REQUEST", message: "Legacy refusal" },
      { code: "BACKEND_ERROR", message: "Acknowledgement lost", disposition: { delivery: "unknown", retry: "safe" }, suggestion: "correct-request" }]) {
      response = legacy;
      let caught = false;
      try { await call(socket, "session.act"); }
      catch (error) { caught = true; expect(normalizeDisposition(error)).toEqual(unknownDisposition); }
      expect(caught).toBe(true);
    }
  } finally { broker.stop(true); await rm(root, { recursive: true, force: true }); }
});
