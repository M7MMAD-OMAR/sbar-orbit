import { expect, test } from "bun:test";
import { NativeWorker } from "../src/native-worker";
import { OrbitError, record } from "../src/errors";
import { unknownDisposition } from "../src/errors";
import { nativeApplicationPolicy, type JournalEntry } from "../src/policy";
import { Sessions } from "../src/session";

const messages = {
  CAPTURE_UNAVAILABLE: "Native window capture is unavailable; inspect the current target before another observation",
  CAPTURE_DEADLINE_EXCEEDED: "Native observation exceeded its capture deadline; inspect the current target before another observation",
  CAPTURE_GEOMETRY_CHANGED: "Native target geometry changed during capture; inspect the current target before another observation",
} as const;

function decodeFailure(code: string): OrbitError {
  const failures: unknown[] = [];
  // Exercise the actual decoder without creating a child, descriptor, timer or desktop session.
  const worker = Object.create(NativeWorker.prototype) as NativeWorker;
  Reflect.set(worker, "bytes", 0);
  Reflect.set(worker, "fragments", []);
  Reflect.set(worker, "pending", { id: "owned-fixture", timer: undefined,
    resolve: () => { throw new Error("Failure frame resolved"); }, reject: (error: unknown) => failures.push(error) });
  Reflect.set(worker, "abort", (error: unknown) => { throw error; });
  const encoded = Buffer.from(JSON.stringify({ requestId: "owned-fixture", ok: false,
    error: { code, message: "private application diagnostic", disposition: { delivery: "not-delivered", retry: "safe" },
      suggestion: "private application diagnostic" } }) + "\n");
  const receive = Reflect.get(NativeWorker.prototype, "receive");
  Reflect.apply(receive, worker, [encoded.subarray(0, 13)]);
  expect(failures).toHaveLength(0);
  Reflect.apply(receive, worker, [encoded.subarray(13)]);
  expect(failures).toHaveLength(1);
  const error = failures[0];
  expect(error).toBeInstanceOf(OrbitError);
  if (!(error instanceof OrbitError)) throw new Error("Worker did not classify failure");
  return error;
}

for (const [code, message] of Object.entries(messages)) {
  test(code + " has fixed content-free message and never infers safe input replay", () => {
    const error = decodeFailure(code);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.disposition).toEqual(unknownDisposition.disposition);
    expect(error.suggestion).toBe(unknownDisposition.suggestion);
    expect(error.message).not.toContain("private application diagnostic");
  });
}

test("mixed capture and cleanup failure stays generic and conservative", () => {
  const error = decodeFailure("NATIVE_FAILED");
  expect(error.code).toBe("NATIVE_FAILED");
  expect(error.message).toBe("Native request failed; inspect its private worker journal");
  expect(error.disposition).toEqual({ delivery: "unknown", retry: "unsafe" });
});

test("capture failure preserves four acknowledged inputs and cached retry never replays", async () => {
  for (const code of Object.keys(messages)) {
    const captureFailure = decodeFailure(code);
    let inputs = 0, baselines = 0, captures = 0;
    const backend = {
      parseAction: (value: unknown) => ({ ...record(value), type: String(record(value).type) }),
      act: async () => { inputs++; return { acknowledged: true }; },
      baseline: async () => { baselines++; return "c".repeat(64); },
      observe: async () => { captures++; throw captureFailure; },
    };
    const session = { id: "owned-fixture", state: "running", kind: "native", lease: "fixture", backend,
      tail: Promise.resolve(), requests: new Map(), policy: { ...nativeApplicationPolicy },
      journal: [] as JournalEntry[], tainted: false };
    const sessions = Object.create(Sessions.prototype) as Sessions;
    Reflect.set(sessions, "sessions", new Map([[session.id, session]]));
    Reflect.set(sessions, "record", async (_session: unknown, entry: JournalEntry) => { session.journal.push(entry); });
    const params = { sessionId: session.id, requestId: "four-keys", capture: {},
      actions: ["1", "+", "2", "Return"].map(key => ({ type: "key", key, appId: "a".repeat(32), windowId: "b".repeat(32) })) };
    const first = record(await sessions.act(params));
    expect((first.receipts as unknown[]).map(receipt => record(receipt).status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(first.completed).toBe(4);
    expect(record(first.captureError)).toMatchObject({ code, disposition: { delivery: "unknown", retry: "unsafe" } });
    const replay = record(await sessions.act(params));
    expect(replay.receipts).toEqual(first.receipts);
    expect(replay.captureError).toEqual(first.captureError);
    expect(inputs).toBe(4);
    expect(baselines).toBe(1);
    expect(captures).toBe(1);
  }
});
