import { expect, test } from "bun:test";
import { Sessions } from "../src/session";
import { NativeBackend } from "../src/hyprland";
import { nativeApplicationPolicy, type JournalEntry } from "../src/policy";
import { OrbitError } from "../src/errors";
import { internalCaller } from "../src/caller";

const action = { type: "edit-ref", appId: "a".repeat(32), windowId: "b".repeat(32), ref: "@" + "c".repeat(32) + ":e1", text: "private" };
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const began = gate(), release = gate(), effects: string[] = [];
  let enabled = true, unknown = false;
  const backend = {
    parseAction: (value: unknown) => value,
    prepareAction: async () => { effects.push("prepare"); began.resolve(); await release.promise; },
    cancelPreparedAction: async () => { effects.push("cancel"); },
    cancelPreparedActions: async () => { effects.push("revoke"); },
    act: async () => { effects.push("send"); if (unknown) throw new OrbitError("SEMANTIC_UNKNOWN", "Unknown"); return { semantic: { accepted: true } }; },
  };
  const session = { id: "fixture", ownerId: "owned", state: "running", backend, kind: "native", lease: "lease", tail: Promise.resolve(),
    requests: new Map(), policy: { ...nativeApplicationPolicy }, journal: [] as JournalEntry[], journalPath: "unused", tainted: false };
  const sessions = Object.create(Sessions.prototype) as Sessions;
  Reflect.set(sessions, "sessions", new Map([[session.id, session]]));
  Reflect.set(sessions, "options", { semanticUsageEnabled: async () => enabled });
  Reflect.set(sessions, "record", async (_: unknown, entry: JournalEntry) => { session.journal.push(entry); });
  const input = { sessionId: session.id, requestId: "once", action: { ...action } };
  const narrow = async () => Reflect.apply(Reflect.get(Sessions.prototype, "dispatchRequest"), sessions,
    [{ method: "session.narrow", params: { sessionId: session.id, allow: ["read"] } }, internalCaller]);
  return { began, release, effects, session, sessions, input, narrow, off: () => { enabled = false; }, unknown: () => { unknown = true; } };
}
for (const change of ["narrow", "pause", "off", "close"] as const) test(`${change} during read-only semantic preparation prevents SEND`, async () => {
  const f = fixture(), pending = f.sessions.act(f.input);
  await f.began.promise;
  if (change === "narrow") await f.narrow();
  if (change === "pause") f.session.state = "pausing";
  if (change === "close") f.session.state = "closing";
  if (change === "off") f.off();
  f.release.resolve();
  await expect(pending).rejects.toBeInstanceOf(OrbitError);
  expect(f.effects).not.toContain("send");
  expect(f.effects).toContain("cancel");
});
test("unknown semantic delivery is deduplicated before and after completion", async () => {
  const f = fixture(); f.unknown();
  const pending = f.sessions.act(f.input);
  expect(f.sessions.act(f.input)).toBe(pending);
  await f.began.promise; f.release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SEMANTIC_UNKNOWN" });
  expect(f.sessions.act(f.input)).toBe(pending);
  await expect(f.sessions.act(f.input)).rejects.toMatchObject({ code: "SEMANTIC_UNKNOWN" });
  expect(f.effects.filter(value => value === "send")).toHaveLength(1);
  expect(JSON.stringify(f.session.journal)).not.toContain("private");
});
test("narrow during pointer ref capture preparation prevents the click", async () => {
  const f = fixture();
  const pending = f.sessions.act({ ...f.input, action: { type: "ref-click", appId: action.appId, windowId: action.windowId, ref: action.ref } });
  await f.began.promise;
  await f.narrow();
  f.release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(f.effects).not.toContain("send");
  expect(f.effects).toContain("cancel");
});
test("failed read-only preparation reports no delivery while failed SEND remains unknown", async () => {
  for (const error of [new OrbitError("STALE_REF", "Expired"), new OrbitError("BACKEND_ERROR", "Lost reply"), new Error("Unavailable")]) {
    const f = fixture();
    f.session.backend.prepareAction = async () => { f.effects.push("prepare"); throw error; };
    await expect(f.sessions.act(f.input)).rejects.toMatchObject({
      disposition: { delivery: "not-delivered", retry: "unsafe" }, suggestion: "observe-before-retry",
    });
    expect(f.effects).not.toContain("send");
    expect(f.effects).toContain("cancel");
  }
  const f = fixture(); f.unknown(); f.release.resolve();
  await expect(f.sessions.act(f.input)).rejects.toMatchObject({ code: "SEMANTIC_UNKNOWN", disposition: { delivery: "unknown", retry: "unsafe" } });
});
function backendFixture() {
  const calls: string[] = [];
  const backend = Object.create(NativeBackend.prototype) as NativeBackend;
  for (const [name, value] of Object.entries({ options: {}, closing: false, semanticEpoch: 0, semanticPrepared: new Map(),
    applications: new Map([[action.appId, {}]]), worker: { request: async (method: string) => { calls.push(method); return method === "semantic-prepare" ? { token: "d".repeat(32) } : {}; } } })) Reflect.set(backend, name, value);
  return { backend, calls };
}
test("backend accepts only its trusted preparation bound to original action object and content", async () => {
  const f = backendFixture(), original = { ...action };
  await expect(f.backend.act(original)).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  await f.backend.prepareAction(original);
  await expect(f.backend.act({ ...original })).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  original.text = "changed";
  await expect(f.backend.act(original)).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  expect(f.calls).not.toContain("semantic-send");
});
test("revoked preparation cannot dispatch and public prepared/routing fields are rejected", async () => {
  const f = backendFixture(), original = { ...action };
  await f.backend.prepareAction(original); await f.backend.cancelPreparedActions();
  await expect(f.backend.act(original)).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  for (const extra of [{ token: "d".repeat(32) }, { prepared: "d".repeat(32) }, { path: "/private" }, { owner: ":1.2" }])
    expect(() => f.backend.parseAction({ ...action, ...extra })).toThrow();
  expect(f.calls).not.toContain("semantic-send");
});
test("backend sends exactly once after trusted preparation and enforces semantic bounds", async () => {
  const f = backendFixture(), original = { ...action, text: "" };
  await f.backend.prepareAction(original); await f.backend.act(original);
  await expect(f.backend.act(original)).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  expect(f.calls.filter(value => value === "semantic-send")).toHaveLength(1);
  for (const invalid of [{ ...action, text: "é".repeat(8001) }, { ...action, text: "\ud800" }, { ...action, type: "value-ref", text: undefined, value: Infinity }])
    expect(() => f.backend.parseAction(invalid)).toThrow();
});

test("public semantic schema enforces strict routing-free verbs and write policy", async () => {
  const { orbitActionSchema } = await import("../src/mcp");
  const { classify, decide } = await import("../src/policy");
  for (const candidate of [{ ...action, text: "" }, { ...action, type: "invoke-ref", text: undefined }, { ...action, type: "value-ref", text: undefined, value: 2 }]) {
    const clean = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
    expect(orbitActionSchema.safeParse(clean).success).toBe(true);
    expect(classify(candidate.type)).toBe("write");
    expect(decide({ ...nativeApplicationPolicy, allow: ["read"] }, candidate.type).outcome).toBe("deny");
  }
  for (const extra of [{ token: "d".repeat(32) }, { path: "/private" }, { semanticTarget: {} }])
    expect(orbitActionSchema.safeParse({ ...action, ...extra }).success).toBe(false);
  expect(orbitActionSchema.safeParse({ ...action, text: "\ud800" }).success).toBe(false);
});

test("revocation while plugin preparation is in flight cancels the returned token before SEND", async () => {
  const f = backendFixture(), began = gate(), release = gate(), original = { ...action };
  Reflect.set(f.backend, "worker", { request: async (method: string) => {
    f.calls.push(method);
    if (method === "semantic-prepare") { began.resolve(); await release.promise; return { token: "d".repeat(32) }; }
    return {};
  } });
  const pending = f.backend.prepareAction(original);
  await began.promise; await f.backend.cancelPreparedActions(); release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "PAUSED" });
  await expect(f.backend.act(original)).rejects.toMatchObject({ code: "SEMANTIC_PREPARATION_REQUIRED" });
  expect(f.calls).toContain("semantic-cancel");
  expect(f.calls).not.toContain("semantic-send");
});

test("narrowing drains an admitted semantic SEND before acknowledging the new policy", async () => {
  const f = fixture(), b = backendFixture(), began = gate(), release = gate();
  Reflect.set(f.session, "backend", b.backend);
  Reflect.set(b.backend, "worker", { request: async (method: string) => {
    b.calls.push(method);
    if (method === "semantic-prepare") return { token: "d".repeat(32) };
    if (method === "semantic-send") { began.resolve(); await release.promise; b.calls.push("effect"); }
    return {};
  } });
  const pending = f.sessions.act(f.input);
  await began.promise;
  let acknowledged = false;
  const narrowed = f.narrow().then(value => { acknowledged = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(b.calls).toContain("semantic-cancel");
  expect(b.calls).not.toContain("effect");
  let secondAcknowledged = false;
  const secondNarrowed = f.narrow().then(value => { secondAcknowledged = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(secondAcknowledged).toBe(false);
  release.resolve();
  await pending; await narrowed; await secondNarrowed;
  expect(acknowledged).toBe(true);
  expect(f.session.policy.allow).toEqual(["read"]);
  expect(b.calls.filter(value => value === "semantic-send")).toHaveLength(1);
  expect(b.calls.filter(value => value === "effect")).toHaveLength(1);
});
