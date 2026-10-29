import { expect, test } from "bun:test";
import { Sessions } from "../src/session";
import { nativeApplicationPolicy, narrow } from "../src/policy";
import { renderAct } from "../src/observation-output";

const app = "a".repeat(32), window = "b".repeat(32);
const at = { appId: app, windowId: window };

function fixture(fail?: { at: number; error: Error }) {
  const calls: string[] = [];
  const captures: unknown[] = [];
  const backend = {
    parseAction: (value: Record<string, unknown>) => ({ ...value }),
    act: async (action: { type: string }) => {
      calls.push(action.type);
      if (fail && calls.length - 1 === fail.at) throw fail.error;
      return { response: "ok" };
    },
    baseline: async () => { calls.push("baseline"); return "c".repeat(64); },
    observe: async (_target: unknown, _format: string, settle: unknown) => {
      captures.push(settle);
      return { mimeType: "image/png", image: "PIXELS", width: 10, height: 10, settle: { settled: true, changed: true, captures: 3, waitedMs: 120 } };
    },
  };
  const sessions = new Sessions("/unused-batch-test") as unknown as {
    sessions: Map<string, unknown>; act(input: Record<string, unknown>): Promise<any>;
  };
  const session = { id: "s", state: "running", backend, kind: "native", lease: "l", tail: Promise.resolve(), requests: new Map(),
    policy: { ...nativeApplicationPolicy }, journal: [] as unknown[], journalPath: "/dev/null", tainted: false };
  sessions.sessions.set("s", session);
  return { sessions, session, calls, captures };
}
const key = (name: string) => ({ type: "key", ...at, key: name });
const input = (extra: Record<string, unknown>) => ({ sessionId: "s", requestId: crypto.randomUUID(), ...extra });

test("a batch runs in order, takes a baseline first, and ends with one settled capture", async () => {
  const { sessions, calls, captures } = fixture();
  const result = await sessions.act(input({ actions: [{ type: "text", ...at, text: "1+2" }, key("Return")], capture: {} }));
  expect(calls).toEqual(["baseline", "text", "key"]);
  expect(result.ok).toBe(true);
  expect(result.receipts.map((r: any) => r.status)).toEqual(["ok", "ok"]);
  expect(captures).toEqual([{ since: "c".repeat(64), timeoutMs: 1500 }]);
  expect(result.capture.image).toBe("PIXELS");
});

test("a failure stops the batch, later actions are not attempted and a lost reply is uncertain", async () => {
  const { sessions, calls } = fixture({ at: 2, error: Object.assign(new Error("slow"), { name: "TimeoutError" }) });
  const result = await sessions.act(input({ actions: [key("a"), key("b"), key("c")], capture: { timeoutMs: 400 } }));
  expect(calls.filter(call => call !== "baseline")).toEqual(["key", "key"]);
  expect(result.ok).toBe(false);
  expect(result.receipts.map((r: any) => r.status)).toEqual(["ok", "uncertain", "not-attempted"]);
});

test("a denied action anywhere refuses the whole batch before any input", async () => {
  const { sessions, session, calls } = fixture();
  session.policy = narrow(session.policy, { allow: ["read"] });
  await expect((async () => sessions.act(input({ actions: [{ type: "move", ...at, x: 1, y: 1 }, key("a")] })))()).rejects.toMatchObject({ code: expect.stringMatching(/^POLICY_/) });
  expect(calls).toEqual([]);
});

test("a batch must act on one window and hold only batchable input", async () => {
  const { sessions, calls } = fixture();
  await expect((async () => sessions.act(input({ actions: [key("a"), { ...key("b"), windowId: "c".repeat(32) }] })))()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect((async () => sessions.act(input({ actions: [{ type: "close-window", ...at }] })))()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect((async () => sessions.act(input({ action: key("a"), actions: [key("a")] })))()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect((async () => sessions.act(input({ actions: Array.from({ length: 17 }, () => key("a")) })))()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(calls).toEqual([]);
});

test("replaying a request does not re-execute, keeps no pixels, and a changed list conflicts", async () => {
  const { sessions, session, calls } = fixture();
  const first = input({ actions: [key("a")], capture: {} });
  const result = await sessions.act(first);
  expect(result.capture.image).toBe("PIXELS");
  const before = calls.length;
  const replay = await sessions.act(first);
  expect(calls.length).toBe(before);
  expect(replay.capture).toMatchObject({ expired: true, mimeType: "image/png" });
  expect(JSON.stringify([...session.requests.values()].map(entry => (entry as { fingerprint: string }).fingerprint))).not.toContain("PIXELS");
  expect(replay.capture.image).toBeUndefined();
  await expect((async () => sessions.act({ ...first, actions: [key("b")] }))()).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});

test("a single action without capture keeps the original result shape", async () => {
  const { sessions } = fixture();
  expect(await sessions.act(input({ action: key("a") }))).toEqual({ response: "ok" });
});

test("the image goes out as an image block, not inside the receipt text", () => {
  const rendered = renderAct({ ok: true, completed: 1, receipts: [], capture: { mimeType: "image/png", image: "PIXELS", settle: { settled: true } } });
  expect(rendered.content[0]).toMatchObject({ type: "text" });
  expect((rendered.content[0] as { text: string }).text).not.toContain("PIXELS");
  expect(rendered.content[1]).toEqual({ type: "image", data: "PIXELS", mimeType: "image/png" });
  expect(renderAct({ ok: false, receipts: [] })).toMatchObject({ isError: true });
});
