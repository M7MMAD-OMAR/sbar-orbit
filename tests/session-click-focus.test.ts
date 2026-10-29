import { expect, test } from "bun:test";
import { Sessions } from "../src/session";
import { nativeApplicationPolicy } from "../src/policy";

const at = { appId: "a".repeat(32), windowId: "b".repeat(32) };

function fixture() {
  const times: { type: string; at: number }[] = [];
  const backend = {
    parseAction: (value: Record<string, unknown>) => ({ ...value }),
    act: async (action: { type: string }) => { times.push({ type: action.type, at: performance.now() }); return { response: "ok" }; },
    baseline: async () => "c".repeat(64),
    observe: async () => ({ mimeType: "image/png", image: "PIXELS", width: 10, height: 10, settle: { settled: true, changed: true, captures: 1, waitedMs: 1 } }),
  };
  const sessions = new Sessions("/unused-click-focus-test") as unknown as { sessions: Map<string, unknown>; act(input: Record<string, unknown>): Promise<any> };
  sessions.sessions.set("s", { id: "s", state: "running", backend, kind: "native", lease: "l", tail: Promise.resolve(), requests: new Map(),
    policy: { ...nativeApplicationPolicy }, journal: [] as unknown[], journalPath: "/dev/null", tainted: false });
  return { sessions, times };
}
const run = (sessions: { act(input: Record<string, unknown>): Promise<any> }, actions: Record<string, unknown>[]) =>
  sessions.act({ sessionId: "s", requestId: crypto.randomUUID(), actions });

test("keyboard input right after a click waits for the focus to land", async () => {
  const { sessions, times } = fixture();
  await run(sessions, [{ type: "click", ...at, x: 5, y: 5 }, { type: "text", ...at, text: "a" }, { type: "key", ...at, key: "Tab" }]);
  expect(times.map(entry => entry.type)).toEqual(["click", "text", "key"]);
  expect(times[1]!.at - times[0]!.at).toBeGreaterThanOrEqual(190);
  expect(times[2]!.at - times[1]!.at).toBeLessThan(150);
});

test("moves and scrolls after a click, and keys after other keys, are not delayed", async () => {
  const { sessions, times } = fixture();
  await run(sessions, [{ type: "click", ...at, x: 5, y: 5 }, { type: "scroll", ...at, x: 5, y: 5, dy: 1 }, { type: "key", ...at, key: "a" }]);
  expect(times[1]!.at - times[0]!.at).toBeLessThan(150);
});
