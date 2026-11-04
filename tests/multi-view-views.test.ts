import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { ReadResourceBudget } from "../src/multi-view-read-budget";
import { ReadViewRegistry, ReadViewError, type ReadCaptureContext, type ReadRecipient,
  type ReadViewBackend, type ReadViewEnrollment, type ReadViewFormat } from "../src/multi-view-views";

const secret = "PRIVATE-frame-command-path-title-token";
function recipient(conversation: object = {}): ReadRecipient {
  return { owner: {}, connector: {}, instance: {}, conversation, channel: {}, pid: 123, birth: "456" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(enabled = true) {
  const authority = {}, who = recipient(), binding = {}, budget = new ReadResourceBudget();
  const state = { now: 1000, ready: true, live: true, bindingEpoch: 1, consentEpoch: 1,
    prepared: 0, captured: 0, checks: 0, context: undefined as ReadCaptureContext | undefined,
    data: new Uint8Array([1, 2, 3]), scratchBytes: 8, retainedBytes: 8 };
  let capture = async (context: ReadCaptureContext): Promise<Uint8Array> => {
    context.lifecycle.confirmStopped(true);
    return state.data;
  };
  const backend: ReadViewBackend = {
    admissionReady: () => { state.checks++; return state.ready; },
    recipientCurrent: (current, epoch) => state.live && epoch === state.consentEpoch && current.owner === who.owner,
    bindingCurrent: (_binding, epoch) => epoch === state.bindingEpoch,
    prepare: () => {
      state.prepared++;
      return { cost: { scratchBytes: state.scratchBytes, retainedBytes: state.retainedBytes },
        capture: (context: ReadCaptureContext) => { state.captured++; state.context = context; return capture(context); } };
    },
  };
  const registry = new ReadViewRegistry({ ownerAuthority: authority, budget, backend, now: () => state.now });
  if (enabled) registry.setEnabled(authority, true);
  const input = (overrides: Partial<ReadViewEnrollment> = {}): ReadViewEnrollment => ({ recipient: who,
    consentEpoch: 1, expiresAt: state.now + 1000, views: [{ binding, bindingEpoch: 1, formats: ["text", "image"] }], ...overrides });
  const enroll = (overrides: Partial<ReadViewEnrollment> = {}) => registry.enroll(authority, input(overrides));
  const read = (grant: ReturnType<typeof enroll>, format: ReadViewFormat = "text", current = who) =>
    registry.read(current, grant.grant, grant.views[0]!.id, format);
  return { authority, who, binding, budget, state, backend, registry, input, enroll, read,
    setCapture: (callback: typeof capture) => { capture = callback; } };
}
function denied(operation: () => unknown, code = "DENIED") {
  try { operation(); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ReadViewError); expect(error).toMatchObject({ code }); expect(String(error)).not.toContain(secret); }
}
async function refused(operation: Promise<unknown>, code = "DENIED") {
  try { await operation; throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ReadViewError); expect(error).toMatchObject({ code }); expect(String(error)).not.toContain(secret); }
}

test("default off performs no backend work or budget allocation", async () => {
  const f = fixture(false);
  expect(f.registry.status(f.who)).toEqual({ enabled: false, views: [] });
  denied(() => f.enroll(), "OFF");
  await refused(f.registry.read(f.who, "a".repeat(64), "b".repeat(24), "text"), "OFF");
  expect(f.state.checks).toBe(0); expect(f.state.prepared).toBe(0); expect(f.state.captured).toBe(0);
  expect(f.budget.status()).toMatchObject({ views: 0, entries: 0, bytes: 0 });
});

test("owner operation uses exact private capability, not role or cloned object", () => {
  const f = fixture();
  for (const owner of [{}, { role: "owner", verified: true }]) {
    denied(() => f.registry.setEnabled(owner, false));
    denied(() => f.registry.enroll(owner, f.input()));
    denied(() => f.registry.revokeConversation(owner, f.who.conversation));
  }
  expect(f.state.prepared).toBe(0);
});

test("grant is random 32-byte connector secret while view ids are non-authorizing", async () => {
  const f = fixture(), g = fixture();
  const first = f.enroll(), second = g.enroll();
  expect(first.grant).toMatch(/^[a-f0-9]{64}$/); expect(first.grant).not.toBe(second.grant);
  expect(first.views[0]!.id).toMatch(/^[a-f0-9]{24}$/);
  await refused(g.registry.read(g.who, first.grant, first.views[0]!.id, "text"));
  expect(g.state.captured).toBe(0);
});

test("two selected views reuse one protected conversation budget", () => {
  const f = fixture();
  const grant = f.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] },
    { binding: {}, bindingEpoch: 1, formats: ["image"] }] });
  expect(grant.views).toHaveLength(2);
  expect(f.budget.status()).toMatchObject({ views: 2, conversations: 1 });
  expect(f.registry.status(f.who).views).toEqual(grant.views);
});

test("exact caller channel principal cannot be copied even with equal fields", async () => {
  const f = fixture(), grant = f.enroll();
  await refused(f.read(grant, "text", { ...f.who }));
  expect(f.state.prepared).toBe(0);
  const lease = await f.read(grant); expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
});

test("foreign conversation and same-label connector receive no view metadata", async () => {
  const f = fixture(), grant = f.enroll(), foreign = recipient();
  expect(f.registry.status(foreign)).toEqual({ enabled: true, views: [] });
  await refused(f.read(grant, "text", foreign));
  expect(f.state.prepared).toBe(0);
});

test("every protected principal field is bound and mutation invalidates old grant", async () => {
  for (const key of ["owner", "connector", "instance", "conversation", "channel", "pid", "birth"] as const) {
    const f = fixture(), grant = f.enroll();
    if (key === "pid") f.who.pid++;
    else if (key === "birth") f.who.birth = "457";
    else f.who[key] = {};
    await refused(f.read(grant)); expect(f.state.captured).toBe(0);
    expect(f.registry.status(f.who).views).toEqual([]);
  }
});

test("binding and consent epochs changing before read refuse without capture", async () => {
  for (const key of ["bindingEpoch", "consentEpoch"] as const) {
    const f = fixture(), grant = f.enroll(); f.state[key]++;
    await refused(f.read(grant)); expect(f.state.prepared).toBe(0);
  }
});

test("text-only grant cannot escalate to pixels or implicit both", async () => {
  const f = fixture(), grant = f.enroll({ views: [{ binding: f.binding, bindingEpoch: 1, formats: ["text"] }] });
  await refused(f.read(grant, "image"));
  await refused(f.registry.read(f.who, grant.grant, grant.views[0]!.id, "both" as ReadViewFormat));
  expect(f.state.prepared).toBe(0);
});

test("foreign view ref, malformed and model role-shaped grants all refuse", async () => {
  const f = fixture(), grant = f.enroll();
  for (const token of ["", "x".repeat(64), secret, { role: "owner" } as unknown as string])
    await refused(f.registry.read(f.who, token, grant.views[0]!.id, "text"));
  await refused(f.registry.read(f.who, grant.grant, "a".repeat(24), "text"));
  expect(f.state.prepared).toBe(0);
});

test("enrollment lifetime is positive finite and at most ten minutes", () => {
  for (const value of [NaN, Infinity, -Infinity, 1000, 999, 601001, true, "2000"] as unknown[]) {
    const f = fixture(); denied(() => f.enroll({ expiresAt: value as number }), "INVALID");
    expect(f.budget.status().views).toBe(0);
  }
  const f = fixture(); expect(f.enroll({ expiresAt: 601000 }).views).toHaveLength(1);
});

test("strict epoch process birth and selected format validation", () => {
  for (const epoch of [0, -1, NaN, Infinity, true, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); denied(() => f.enroll({ consentEpoch: epoch as number }), "INVALID");
  }
  for (const formats of [[], ["both"], ["text", "text"], ["image", "text", "image"]]) {
    const f = fixture(); denied(() => f.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: formats as ReadViewFormat[] }] }), "INVALID");
  }
  const f = fixture(); f.who.birth = "not-birth"; denied(() => f.enroll(), "INVALID");
});

test("missing fields, unknown roles and accessor enrollment never execute getters", () => {
  const f = fixture(); let getterCalls = 0;
  const data = f.input(); Object.defineProperty(data, "recipient", { get() { getterCalls++; return f.who; } });
  denied(() => f.registry.enroll(f.authority, data), "INVALID"); expect(getterCalls).toBe(0);
  denied(() => f.registry.enroll(f.authority, { ...f.input(), role: "owner" } as ReadViewEnrollment), "INVALID");
  denied(() => f.registry.enroll(f.authority, {} as ReadViewEnrollment), "INVALID");
});

test("duplicate binding, zero views and more than two views fail closed", () => {
  const f = fixture();
  const item = { binding: f.binding, bindingEpoch: 1, formats: ["text"] as ReadViewFormat[] };
  for (const views of [[], [item, item], [item, { ...item, binding: {} }, { ...item, binding: {} }]])
    denied(() => f.enroll({ views }), "INVALID");
  expect(f.budget.status().views).toBe(0);
});

test("same selected client cannot obtain a second view lease", () => {
  const f = fixture(); f.enroll(); denied(() => f.enroll(), "LIMIT");
  expect(f.budget.status().views).toBe(1);
});

test("device eight-view four-conversation and per-conversation two-view caps", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.enroll({ recipient: { ...f.who, conversation: {} }, views: [
    { binding: {}, bindingEpoch: 1, formats: ["text"] }, { binding: {}, bindingEpoch: 1, formats: ["image"] }] });
  expect(f.budget.status()).toMatchObject({ views: 8, conversations: 4 });
  denied(() => f.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
  const g = fixture();
  g.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }, { binding: {}, bindingEpoch: 1, formats: ["text"] }] });
  denied(() => g.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
});

test("partial budget enrollment failure rolls back all newly allocated views", () => {
  const f = fixture();
  f.enroll();
  denied(() => f.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] },
    { binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
  expect(f.budget.status()).toMatchObject({ views: 1, conversations: 1 });
});

test("explicit hard gate false refuses enrollment without provider work", () => {
  const f = fixture(); f.state.ready = false; denied(() => f.enroll());
  expect(f.state.prepared).toBe(0); expect(f.state.captured).toBe(0); expect(f.budget.status().views).toBe(0);
});

test("qualification loss after enrollment refuses instead of fallback", async () => {
  const f = fixture(), grant = f.enroll(); f.state.ready = false;
  await refused(f.read(grant)); expect(f.state.prepared).toBe(0);
});

test("trusted identity and gate exceptions are fixed private refusals", async () => {
  for (const key of ["admissionReady", "recipientCurrent", "bindingCurrent"] as const) {
    const f = fixture(), grant = f.enroll(); f.backend[key] = () => { throw new Error(secret); };
    await refused(f.read(grant)); expect(f.state.prepared).toBe(0);
  }
});

test("off then on never revives earlier grant", async () => {
  const f = fixture(), grant = f.enroll();
  f.registry.setEnabled(f.authority, false); f.registry.setEnabled(f.authority, true);
  await refused(f.read(grant)); expect(f.registry.status(f.who).views).toEqual([]);
});

test("detach conversation off and exact binding invalidation remove grant", async () => {
  for (const mode of ["detach", "conversation", "binding"]) {
    const f = fixture(), grant = f.enroll();
    if (mode === "detach") f.registry.detach(f.authority, f.who);
    else if (mode === "conversation") f.registry.revokeConversation(f.authority, f.who.conversation);
    else f.registry.invalidateBinding(f.authority, f.binding);
    await refused(f.read(grant)); expect(f.budget.status().views).toBe(0);
  }
});

test("expiry at exact boundary refuses and does not reconstruct by label", async () => {
  const f = fixture(), grant = f.enroll({ expiresAt: 1010 }); f.state.now = 1010;
  await refused(f.read(grant)); expect(f.budget.status().views).toBe(0);
});

test("revoke while capture awaits suppresses successful late data", async () => {
  const f = fixture(), grant = f.enroll(), pending = deferred<Uint8Array>();
  f.setCapture(() => pending.promise); const read = f.read(grant);
  expect(f.budget.status().captureOccupied).toBe(true);
  f.registry.revoke(f.authority, grant.grant);
  expect(f.state.context!.isCurrent()).toBe(false);
  expect(f.budget.status().captureOccupied).toBe(true);
  f.state.context!.lifecycle.confirmStopped(true); pending.resolve(new Uint8Array([1]));
  await refused(read); expect(f.budget.status()).toMatchObject({ views: 0, entries: 0, bytes: 0 });
});

test("off expiry and epoch replacement after await independently suppress delivery", async () => {
  for (const mode of ["off", "expiry", "binding", "consent", "birth"]) {
    const f = fixture(), grant = f.enroll(), pending = deferred<Uint8Array>();
    f.setCapture(() => pending.promise); const read = f.read(grant);
    if (mode === "off") f.registry.setEnabled(f.authority, false);
    if (mode === "expiry") f.state.now = 2001;
    if (mode === "binding") f.state.bindingEpoch++;
    if (mode === "consent") f.state.consentEpoch++;
    if (mode === "birth") f.who.birth = "999";
    f.state.context!.lifecycle.confirmStopped(true); pending.resolve(new Uint8Array([1]));
    await refused(read); expect(f.budget.status().entries).toBe(0);
  }
});

test("promise success without real stop callback quarantines capture credit", async () => {
  const f = fixture(), grant = f.enroll(); f.setCapture(async () => new Uint8Array([1]));
  await refused(f.read(grant), "UNCONFIRMED");
  expect(f.budget.status()).toMatchObject({ captureOccupied: true, quarantined: 1, bytes: 16 });
  await refused(f.read(grant), "BUSY");
  f.state.context!.lifecycle.confirmStopped(false);
  expect(f.budget.status()).toMatchObject({ captureOccupied: false, entries: 0, bytes: 0 });
});

test("backend rejection cannot free unknown owned work or leak raw errors", async () => {
  const f = fixture(), grant = f.enroll(); f.setCapture(async () => { throw new Error(secret); });
  await refused(f.read(grant), "BACKEND");
  expect(f.budget.status()).toMatchObject({ captureOccupied: true, quarantined: 1 });
  f.registry.revoke(f.authority, grant.grant);
  expect(f.budget.status().views).toBe(1);
  f.state.context!.lifecycle.confirmStopped(false);
  expect(f.budget.status()).toMatchObject({ views: 0, entries: 0, bytes: 0 });
});

test("external provider unknown remains occupied even if root output arrived", async () => {
  const f = fixture(), grant = f.enroll();
  f.setCapture(async context => { context.lifecycle.unknownDrain(); return new Uint8Array([1]); });
  await refused(f.read(grant), "UNCONFIRMED"); expect(f.budget.status().captureOccupied).toBe(true);
  expect(f.state.context!.lifecycle.confirmStopped(false)).toBe(true);
  expect(f.state.context!.lifecycle.confirmStopped(false)).toBe(false);
});

test("successful lease consumes retained bytes until one idempotent release", async () => {
  const f = fixture(), grant = f.enroll(); const lease = await f.read(grant);
  expect(f.budget.status()).toMatchObject({ entries: 1, retainedReferences: 1, bytes: 8, captureOccupied: false });
  expect([...lease.bytes]).toEqual([1, 2, 3]);
  lease.release(); lease.release();
  expect(f.budget.status()).toMatchObject({ entries: 0, bytes: 0 }); denied(() => lease.bytes);
});

test("backend aliases are detached by transfer without an uncharged copy", async () => {
  const f = fixture(), grant = f.enroll(), original = f.state.data, alias = original.subarray();
  const lease = await f.read(grant);
  expect(original.byteLength).toBe(0); expect(alias.byteLength).toBe(0);
  expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
});

test("revoked delivered lease blocks later getters but keeps outstanding reference accounted", async () => {
  const f = fixture(), grant = f.enroll(), lease = await f.read(grant), delivered = lease.bytes;
  f.registry.revoke(f.authority, grant.grant); denied(() => lease.bytes);
  expect([...delivered]).toEqual([1, 2, 3]);
  expect(f.budget.status()).toMatchObject({ views: 1, entries: 1, bytes: 8 });
  lease.release(); expect(f.budget.status()).toMatchObject({ views: 0, entries: 0, bytes: 0 });
});

test("two retained entries cap limits consumers without auto eviction", async () => {
  const f = fixture(), grant = f.enroll();
  const first = await f.read(grant); f.state.data = new Uint8Array([4]); const second = await f.read(grant);
  await refused(f.read(grant), "LIMIT");
  expect([...first.bytes]).toEqual([1, 2, 3]); first.release(); second.release();
});

test("oversized zero or aliased backing payload is refused under original reservation", async () => {
  for (const data of [new Uint8Array(9), new Uint8Array(0), new Uint8Array(new ArrayBuffer(12), 2, 3)]) {
    const f = fixture(), grant = f.enroll(); f.state.data = data;
    await refused(f.read(grant), "BACKEND"); expect(f.budget.status()).toMatchObject({ entries: 0, bytes: 0 });
  }
});

test("SharedArrayBuffer and untyped claimed lengths cannot enter delivery", async () => {
  for (const data of [new Uint8Array(new SharedArrayBuffer(3)), { byteLength: 3 }, Buffer.from([1, 2, 3])]) {
    const f = fixture(), grant = f.enroll();
    f.setCapture(async context => { context.lifecycle.confirmStopped(true); return data as Uint8Array; });
    await refused(f.read(grant), "BACKEND"); expect(f.budget.status().entries).toBe(0);
  }
});

test("invalid or inflated preparation cannot start capture", async () => {
  for (const value of [-1, 0, true, NaN, 1048577]) {
    const f = fixture(), grant = f.enroll(); f.state.retainedBytes = value as number;
    await refused(f.read(grant), "BACKEND"); expect(f.state.captured).toBe(0); expect(f.budget.status().entries).toBe(0);
  }
});

test("model status exposes only own non-authorizing refs and no raw contents or token", async () => {
  const f = fixture(), grant = f.enroll(); const lease = await f.read(grant);
  const value = JSON.stringify(f.registry.status(f.who));
  expect(value).not.toContain(grant.grant); expect(value).not.toContain(secret);
  for (const field of ["pid", "birth", "owner", "connector", "conversation", "bytes", "binding", "epoch"])
    expect(value).not.toContain('"' + field + '"');
  expect(value).toContain(grant.views[0]!.id); lease.release();
});

test("prepare callback reentrant revoke prevents actual provider admission", async () => {
  const f = fixture(), grant = f.enroll(), prepare = f.backend.prepare;
  f.backend.prepare = (binding, format) => { f.registry.revoke(f.authority, grant.grant); return prepare(binding, format); };
  await refused(f.read(grant)); expect(f.state.captured).toBe(0); expect(f.budget.status().entries).toBe(0);
});

test("off/on or conversation-off within owner enrollment checks cannot resurrect grant", () => {
  for (const mode of ["off-on", "conversation"]) {
    const f = fixture(), current = f.backend.recipientCurrent;
    f.backend.recipientCurrent = (who, epoch) => {
      if (mode === "off-on") { f.registry.setEnabled(f.authority, false); f.registry.setEnabled(f.authority, true); }
      else f.registry.revokeConversation(f.authority, f.who.conversation);
      return current(who, epoch);
    };
    denied(() => f.enroll()); expect(f.budget.status().views).toBe(0);
  }
});

test("genuine typed-array own getters cannot spoof reserved size or run side effects", async () => {
  const f = fixture(), grant = f.enroll(), oversized = new Uint8Array(32);
  let calls = 0;
  for (const key of ["buffer", "byteOffset", "byteLength", "constructor"]) Object.defineProperty(oversized, key, {
    get() { calls++; return key === "buffer" ? new ArrayBuffer(3) : key === "constructor" ? Uint8Array : 3; },
  });
  f.setCapture(async context => { context.lifecycle.confirmStopped(true); return oversized; });
  await refused(f.read(grant), "BACKEND"); expect(calls).toBe(0); expect(f.budget.status().bytes).toBe(0);
});

test("identity mutation inside final binding check cannot escape the post-callback fence", async () => {
  const f = fixture(), grant = f.enroll(), check = f.backend.bindingCurrent;
  f.backend.bindingCurrent = (binding, epoch) => { const okay = check(binding, epoch); f.who.birth = "999"; return okay; };
  await refused(f.read(grant)); expect(f.state.captured).toBe(0);
});

test("clock expiry inside binding callback refuses before native capture", async () => {
  const f = fixture(), grant = f.enroll(), check = f.backend.bindingCurrent;
  f.backend.bindingCurrent = (binding, epoch) => { const okay = check(binding, epoch); f.state.now = 2000; return okay; };
  await refused(f.read(grant)); expect(f.state.captured).toBe(0);
});

test("token or view-reference entropy collision fails closed without overwriting active authority", async () => {
  const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => Buffer.alloc(size, 7)) as typeof crypto.randomBytes);
  try {
    const f = fixture(), grant = f.enroll();
    denied(() => f.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
    expect(f.budget.status().views).toBe(1);
    const lease = await f.read(grant); lease.release();
    const g = fixture();
    denied(() => g.enroll({ views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] },
      { binding: {}, bindingEpoch: 1, formats: ["image"] }] }), "LIMIT");
    expect(g.budget.status().views).toBe(0);
  } finally { random.mockRestore(); }
});

test("synchronous qualification reentry cannot enroll the same binding twice or charge nested quota", async () => {
  for (const stage of ["admissionReady", "recipientCurrent", "bindingCurrent"] as const) {
    const f = fixture(), original = f.backend[stage];
    let nested = 0;
    if (stage === "admissionReady") f.backend.admissionReady = () => {
      nested++; denied(() => f.enroll(), "BUSY"); return (original as () => boolean)();
    };
    else if (stage === "recipientCurrent") f.backend.recipientCurrent = (who, epoch) => {
      nested++; denied(() => f.enroll(), "BUSY");
      return (original as ReadViewBackend["recipientCurrent"])(who, epoch);
    };
    else f.backend.bindingCurrent = (binding, epoch) => {
      nested++; denied(() => f.enroll(), "BUSY");
      return (original as ReadViewBackend["bindingCurrent"])(binding, epoch);
    };
    const grant = f.enroll();
    expect(nested).toBeGreaterThan(0);
    expect(f.budget.status()).toMatchObject({ views: 1, conversations: 1, entries: 0 });
    // Restore before the read, whose qualification callbacks are intentionally separate.
    if (stage === "admissionReady") f.backend.admissionReady = original as ReadViewBackend["admissionReady"];
    else if (stage === "recipientCurrent") f.backend.recipientCurrent = original as ReadViewBackend["recipientCurrent"];
    else f.backend.bindingCurrent = original as ReadViewBackend["bindingCurrent"];
    expect(f.registry.status(f.who).views).toHaveLength(1);
    const lease = await f.read(grant); lease.release();
    f.registry.revoke(f.authority, grant.grant);
    expect(f.budget.status()).toMatchObject({ views: 0, conversations: 0, entries: 0 });
  }
});

test("uncaught enrollment reentry rolls back without quota and guard resets for retry", () => {
  const f = fixture(), current = f.backend.recipientCurrent;
  f.backend.recipientCurrent = () => { f.enroll(); return true; };
  denied(() => f.enroll());
  expect(f.budget.status()).toMatchObject({ views: 0, conversations: 0, entries: 0 });
  f.backend.recipientCurrent = current;
  const grant = f.enroll();
  expect(f.registry.status(f.who).views).toHaveLength(1);
  f.registry.revoke(f.authority, grant.grant);
  expect(f.budget.status()).toMatchObject({ views: 0, conversations: 0 });
});

test("two-view status publishes no partial enrollment when its second binding is invalid and preserves debt", async () => {
  for (const phase of ["retained", "running"]) {
    const f = fixture(), second = {};
    const grant = f.enroll({ views: [
      { binding: f.binding, bindingEpoch: 1, formats: ["text"] },
      { binding: second, bindingEpoch: 1, formats: ["text"] },
    ] });
    const pending = deferred<Uint8Array>();
    let held: Awaited<ReturnType<typeof f.read>> | undefined;
    let running: ReturnType<typeof f.read> | undefined;
    if (phase === "retained") held = await f.read(grant);
    else { f.setCapture(() => pending.promise); running = f.read(grant); }
    f.backend.bindingCurrent = binding => binding !== second;
    expect(f.registry.status(f.who)).toEqual({ enabled: true, views: [] });
    await refused(f.read(grant));
    expect(f.budget.status()).toMatchObject({ views: 1, entries: 1,
      bytes: phase === "retained" ? 8 : 16, captureOccupied: phase === "running" });
    if (held) { denied(() => held!.bytes); held.release(); }
    else {
      f.state.context!.lifecycle.confirmStopped(false);
      pending.resolve(new Uint8Array([1]));
      await refused(running!);
    }
    expect(f.budget.status()).toMatchObject({ views: 0, conversations: 0, entries: 0, bytes: 0 });
  }
});

test("idle revoked grants do not accumulate quota or replayable tombstones", async () => {
  const f = fixture(); let old = "";
  for (let i = 0; i < 100; i++) {
    const grant = f.enroll(); old = grant.grant; expect(f.registry.revoke(f.authority, old)).toBe(true);
  }
  expect(f.budget.status()).toMatchObject({ views: 0, conversations: 0 });
  await refused(f.registry.read(f.who, old, "a".repeat(24), "text"));
});
