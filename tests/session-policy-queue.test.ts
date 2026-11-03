import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions } from "../src/session";
import { internalCaller } from "../src/caller";
import { record } from "../src/errors";
import { nativeApplicationPolicy, type ActionClass, type JournalEntry, type SessionPolicy } from "../src/policy";

const target = { appId: "a".repeat(32), windowId: "b".repeat(32) };
const key = { type: "key", ...target, key: "a" };
const input = (requestId: string, extra: Record<string, unknown>) => ({ sessionId: "fixture", requestId, ...extra });
function deferred<T>() {
  let complete: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, resolve: (value: T) => complete(value) };
}
function fixture(policy: SessionPolicy = { ...nativeApplicationPolicy }) {
  const effects: string[] = [];
  const hooks: { act?: (action: { type: string }) => Promise<unknown>; baseline?: () => Promise<string> } = {};
  const backend = {
    parseAction: (value: unknown) => ({ ...record(value), type: String(record(value).type) }),
    act: async (action: { type: string }) => { effects.push(action.type); return hooks.act ? hooks.act(action) : { acknowledged: true }; },
    baseline: async () => { effects.push("baseline"); return hooks.baseline ? hooks.baseline() : "c".repeat(64); },
    observe: async () => { effects.push("capture"); return { mimeType: "image/png", image: "fixture-pixels" }; },
  };
  const session = { id: "fixture", state: "running", backend, kind: "native", lease: "lease", tail: Promise.resolve() as Promise<unknown>,
    requests: new Map<string, { fingerprint: string; result: Promise<unknown> }>(),
    policy, journal: [] as JournalEntry[], journalPath: "unused", tainted: false };
  // Use real orchestration methods with owned in-memory backend/journal, without broker, desktop or timers.
  const sessions = Object.create(Sessions.prototype) as Sessions;
  Reflect.set(sessions, "sessions", new Map([[session.id, session]]));
  Reflect.set(sessions, "record", async (_session: unknown, entry: JournalEntry) => { session.journal.push(entry); });
  const request = async (method: string, params: Record<string, unknown> = {}) =>
    Reflect.apply(Reflect.get(Sessions.prototype, "dispatchRequest"), sessions, [{ method, params: { sessionId: session.id, ...params } }, internalCaller]);
  const narrowTo = (allow: ActionClass[]) => request("session.narrow", { allow });
  return { sessions, session, effects, hooks, request, narrowTo };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 3000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error("Owned advisor did not become ready");
    await Bun.sleep(5);
  }
}
async function advisorFixture() {
  const directory = await mkdtemp(join(tmpdir(), "orbit-queue-advisor-"));
  const ready = join(directory, "ready"), release = join(directory, "release");
  const script = "await Bun.stdin.text(); await Bun.write(" + JSON.stringify(ready) + ", 'ready'); " +
    "while (!(await Bun.file(" + JSON.stringify(release) + ").exists())) await Bun.sleep(5); " +
    "console.log(JSON.stringify({decision:'allow',reason:'owned fixture'}));";
  const policy: SessionPolicy = { ...nativeApplicationPolicy,
    rules: [{ id: "consult-key", verb: "key", decision: "consult", reason: "Owner-configured fixture check" }],
    advisor: { command: [process.execPath, "-e", script], timeoutMs: 4000 } };
  return { policy, ready, release: () => Bun.write(release, "release"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("queued allow is revoked by real session.narrow, cached duplicate never executes", async () => {
  const f = fixture(), gate = deferred<void>();
  f.session.tail = gate.promise;
  const params = input("queued", { action: { ...key, type: "text", text: "private typed content" } });
  const first = f.sessions.act(params), duplicate = f.sessions.act(params);
  expect(duplicate).toBe(first);
  await f.narrowTo(["read"]);
  gate.resolve(undefined);
  await expect(first).rejects.toMatchObject({ code: "POLICY_DENIED", disposition: { delivery: "not-delivered", retry: "unsafe" } });
  expect(f.sessions.act(params)).toBe(first);
  await expect(f.sessions.act(params)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(f.effects).toEqual([]);
  expect(f.session.journal.at(-1)).toMatchObject({ actionType: "text", outcome: "deny", requestId: "queued" });
  expect(f.session.journal.filter(entry => entry.actionType === "text")).toHaveLength(1);
  expect(JSON.stringify(f.session.journal)).not.toContain("private typed content");
});

test("queued irreversible action uses current supervised decision, never stale allow", async () => {
  const f = fixture(), gate = deferred<void>();
  f.session.tail = gate.promise;
  const result = f.sessions.act(input("close-window", { action: { type: "close-window", ...target } }));
  await f.narrowTo(["read"]);
  f.session.policy = { ...f.session.policy, mode: "supervised" };
  gate.resolve(undefined);
  await expect(result).rejects.toMatchObject({ code: "POLICY_CONFIRMATION_REQUIRED" });
  expect(f.effects).toEqual([]);
  expect(f.session.journal.at(-1)).toMatchObject({ outcome: "ask", actionClass: "irreversible" });
});

test("synchronous admission denial remains synchronous and creates no request or effect", () => {
  const f = fixture({ ...nativeApplicationPolicy, allow: ["read"] });
  expect(() => f.sessions.act(input("denied", { action: key }))).toThrow();
  expect(f.session.requests.size).toBe(0);
  expect(f.effects).toEqual([]);
});

test("queued consult rechecks current policy before starting any advisor", async () => {
  const f = fixture({ ...nativeApplicationPolicy,
    rules: [{ id: "consult-key", verb: "key", decision: "consult", reason: "check" }],
    advisor: { command: [process.execPath, "-e", "throw new Error('must not execute');"], timeoutMs: 1000 } });
  const gate = deferred<void>(); f.session.tail = gate.promise;
  const result = f.sessions.act(input("consult-queued", { action: key }));
  await f.narrowTo(["read"]);
  gate.resolve(undefined);
  await expect(result).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(f.effects).toEqual([]);
  expect(f.session.journal.at(-1)).toMatchObject({ outcome: "deny" });
  expect(f.session.journal.at(-1)?.decidedBy).toBeUndefined();
});

test("late advisor allow cannot restore narrowed action authority", async () => {
  const advisor = await advisorFixture(), f = fixture(advisor.policy);
  const result = f.sessions.act(input("consult-running", { action: key }));
  try {
    await waitForFile(advisor.ready);
    await f.narrowTo(["read"]);
    await advisor.release();
    await expect(result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(f.effects).toEqual([]);
    expect(f.session.journal.at(-1)).toMatchObject({ actionType: "key", outcome: "deny" });
    expect(f.session.policy.allow).toEqual(["read"]);
  } finally { await advisor.release(); await result.catch(() => {}); await advisor.cleanup(); }
});

test("any policy identity change invalidates pending advisor approval without a second consult", async () => {
  const advisor = await advisorFixture(), f = fixture(advisor.policy);
  const result = f.sessions.act(input("consult-stale", { action: key }));
  try {
    await waitForFile(advisor.ready);
    await f.narrowTo(["read", "write"]);
    await advisor.release();
    await expect(result).rejects.toMatchObject({ code: "POLICY_DENIED", message: "Session policy changed while the advisor decision was pending" });
    expect(f.effects).toEqual([]);
    expect(f.session.journal.at(-1)).toMatchObject({ outcome: "deny" });
  } finally { await advisor.release(); await result.catch(() => {}); await advisor.cleanup(); }
});

test("unchanged advisor approval executes once and deduplicates before and after completion", async () => {
  const advisor = await advisorFixture(), f = fixture(advisor.policy);
  const params = input("consult-stable", { action: key });
  const result = f.sessions.act(params);
  expect(f.sessions.act(params)).toBe(result);
  try {
    await waitForFile(advisor.ready); await advisor.release();
    await expect(result).resolves.toEqual({ acknowledged: true });
    expect(f.sessions.act(params)).toBe(result);
    await f.sessions.act(params);
    expect(f.effects).toEqual(["key"]);
    expect(f.session.journal.at(-1)).toMatchObject({ outcome: "allow", decidedBy: "advisor-allowed" });
  } finally { await advisor.release(); await result.catch(() => {}); await advisor.cleanup(); }
});

test("batch narrowing between steps refuses later mutation and duplicate cannot replay", async () => {
  const f = fixture(), began = deferred<void>(), gate = deferred<void>();
  f.hooks.act = async () => { began.resolve(undefined); await gate.promise; return { acknowledged: true }; };
  const params = input("batch-narrow", { actions: [key, { ...key, key: "b" }, { ...key, key: "c" }] });
  const result = f.sessions.act(params);
  await began.promise; await f.narrowTo(["read"]); gate.resolve(undefined);
  const response = record(await result), receipts = response.receipts as unknown[];
  expect(receipts.map(value => record(value).status)).toEqual(["ok", "refused", "not-attempted"]);
  expect(f.effects).toEqual(["key"]);
  expect(f.session.journal.at(-1)).toMatchObject({ actionType: "key", outcome: "deny" });
  await f.sessions.act(params);
  expect(f.effects).toEqual(["key"]);
});

test("capture permission is current after input await, not cached before baseline", async () => {
  const f = fixture(), began = deferred<void>(), gate = deferred<void>();
  f.hooks.act = async () => { began.resolve(undefined); await gate.promise; return {}; };
  const result = f.sessions.act(input("capture-narrow", { actions: [key], capture: {} }));
  await began.promise; await f.narrowTo(["write"]); gate.resolve(undefined);
  const response = record(await result);
  expect(record(response.captureError).code).toBe("POLICY_DENIED");
  expect(f.effects).toEqual(["baseline", "key"]);
  expect(f.session.journal.at(-1)).toMatchObject({ actionType: "observe", outcome: "deny" });
});

test("baseline obeys policy at queue dispatch and stop during input prevents final capture", async () => {
  const queued = fixture(), queue = deferred<void>(); queued.session.tail = queue.promise;
  const queuedResult = queued.sessions.act(input("baseline-narrow", { actions: [key], capture: {} }));
  await queued.narrowTo([]); queue.resolve(undefined);
  const response = record(await queuedResult);
  expect(record(response.captureError).code).toBe("POLICY_DENIED");
  expect(queued.effects).toEqual([]);

  const f = fixture(), began = deferred<void>(), gate = deferred<void>();
  f.hooks.act = async () => { began.resolve(undefined); await gate.promise; return {}; };
  const result = f.sessions.act(input("capture-stop", { actions: [key], capture: {} }));
  await began.promise; f.session.state = "closing"; gate.resolve(undefined);
  await expect(result).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  expect(f.effects).toEqual(["baseline", "key"]);
});

test("pause during click-focus settle never dispatches the next batch input", async () => {
  const f = fixture(), clicked = deferred<void>();
  f.hooks.act = async () => { clicked.resolve(undefined); return {}; };
  const result = f.sessions.act(input("batch-pause", { actions: [{ type: "click", ...target, x: 1, y: 1 }, key] }));
  await clicked.promise;
  // Let the next batch step reach its bounded click-focus settle await.
  for (let step = 0; step < 12; step++) await Promise.resolve();
  f.session.state = "pausing";
  const response = record(await result), receipts = response.receipts as unknown[];
  expect(receipts.map(value => record(value).status)).toEqual(["ok", "not-attempted"]);
  expect(f.effects).toEqual(["click"]);
});

test("pause still drains previously admitted single action rather than cancelling accepted work", async () => {
  const f = fixture(), queue = deferred<void>(); f.session.tail = queue.promise;
  const result = f.sessions.act(input("single-drain", { action: key }));
  const paused = f.request("session.pause");
  expect(f.session.state).toBe("pausing");
  queue.resolve(undefined);
  await result; await paused;
  expect(f.effects).toEqual(["key"]);
  expect(f.session.state).toBe("paused");
  expect(f.session.journal.filter(entry => entry.actionType === "key")).toHaveLength(1);
});
