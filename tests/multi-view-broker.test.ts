import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalCaller, type Caller } from "../src/caller";
import { NativeBackend } from "../src/hyprland";
import { Sessions, type SessionOptions, type SessionReadViewsOptions } from "../src/session";
import { ReadUsageCoordinator } from "../src/read-usage-coordinator";
import { ReadResourceBudget } from "../src/multi-view-read-budget";
import { decide, type SessionPolicy } from "../src/policy";
import type { ReadChannelRegistry } from "../src/read-channel-registry";
import type { ReadCaptureContext, ReadObservationLease, ReadRecipient, ReadViewBackend } from "../src/multi-view-views";

// Only protected in-process fake channels. This is not IPC, CLI/MCP off or native qualification.
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
// Attach ordinary handlers immediately. Bun async matchers must not be constructed
// before releasing a gate that the pending read is waiting on.
const settle = <T>(pending: Promise<T>) => pending.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
);
const rejection = (pending: Promise<ReadObservationLease>): Promise<unknown> => pending.then(lease => {
  lease.release();
  return { code: "UNEXPECTED_SUCCESS" };
}, (error: unknown) => error);
const triggered = (signal: Promise<unknown>, outcome: Promise<unknown>) => Promise.race([signal, outcome.then(() => {
  throw new Error("Reader completed before fixture trigger");
})]);
const agent = (pid: number, start: string, id: string): Caller => ({ id, label: "display-only", role: "agent", kind: "adapter", verified: true, pid, start });

async function fixture(configured = true, sharedConversation = false, dynamicChannels = false, usageFactory?: (conversation: object, other: object) => Pick<SessionReadViewsOptions, "usageCurrent" | "usageVersion" | "bindUsageRevocation">) {
  const root = await mkdtemp(join(tmpdir(), "orbit-read-broker-fixture-"));
  const owner = { ...internalCaller }, ownerIdentity = {}, ownerChannel = {}, channelA = {}, channelB = {}, connectorChannel = {}, approvalKey = {};
  const a = agent(4001, "101", "conv:fixture-a"), b = agent(4002, "102", sharedConversation ? "conv:fixture-a" : "conv:fixture-b");
  const recipient = (channel: object, caller: Caller): ReadRecipient => ({ owner: ownerIdentity, connector: {}, instance: {},
    conversation: {}, channel, pid: caller.pid!, birth: caller.start! });
  const recipientA = recipient(channelA, a), recipientB = recipient(channelB, b);
  if (sharedConversation) recipientB.conversation = recipientA.conversation;
  const state = { enabled: true, epoch: 1, ready: true, alive: true, current: true, binding: true, unknown: false,
    now: 1000, usageCalls: 0, usageHook: undefined as undefined | (() => Promise<void>), captureGate: undefined as undefined | Promise<void> };
  const started = deferred<ReadCaptureContext>();
  const capture = mock(async (context: ReadCaptureContext) => {
    started.resolve(context);
    if (state.captureGate) await state.captureGate;
    if (state.unknown) context.lifecycle.unknownDrain();
    else context.lifecycle.confirmStopped(true); // Fixture proves its own synchronous fake work only.
    return new Uint8Array([1, 2, 3]);
  });
  const prepare = mock((_binding: object, _format: "image" | "text") => ({ cost: { scratchBytes: 8, retainedBytes: 8 }, capture }));
  const backend: ReadViewBackend = { admissionReady: () => state.ready, recipientCurrent: () => state.current,
    bindingCurrent: () => state.binding, prepare };
  const readViews: SessionReadViewsOptions = { ownerIdentity, ownerChannel,
    usageCurrent: (_conversation, epoch) => state.enabled && state.epoch === epoch,
    channels: dynamicChannels ? [] : [{ key: "a", channel: channelA, recipient: recipientA, callerId: a.id }, { key: "b", channel: channelB, recipient: recipientB, callerId: b.id }],
    ...(dynamicChannels ? { dynamicChannels: { connectorChannel, processCurrent: (identity: import("../src/read-channel-registry").ReadConnectorIdentity) =>
      state.alive && identity.callerId === a.id && identity.pid === a.pid && identity.birth === a.start
      && identity.installation === recipientA.connector && identity.instance === recipientA.instance && identity.conversation === recipientA.conversation } } : {}),
    backend, liveProcess: (pid, birth) => state.alive && ((pid === a.pid && birth === a.start) || (pid === b.pid && birth === b.start)),
    usageVersion: async conversation => {
      expect(conversation === recipientA.conversation || conversation === recipientB.conversation).toBe(true);
      state.usageCalls++;
      if (state.usageHook) await state.usageHook();
      return { conversation, epoch: state.epoch, enabled: state.enabled };
    }, now: () => state.now, ...(usageFactory ? usageFactory(recipientA.conversation, recipientB.conversation) : {}) };
  const options: SessionOptions = { alive: () => true, ...(configured ? { readViews } : {}) };
  const sessions = new Sessions(root, undefined, undefined, { planPath: "/fixture/host.json", controlDirectory: join(root, "control") }, join(root, "update"), options);
  const legacyObserve = mock(async () => { throw new Error("No legacy/native reader fallback"); });
  const makeBackend = (index: number): NativeBackend => { const values = {
    capabilities: ["observe"], surface: {}, handoff: { workspace: 23, appId: "app-" + index, selectedWindowId: "window-" + index,
      scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 0, y: 0 },
      windows: [{ appId: "app-" + index, windowId: "window-" + index, title: "private-fixture-title", width: 200, height: 100 }] },
    onClose: () => {}, close: async () => {}, pauseLease: async () => {}, resumeLease: async () => {},
    observe: legacyObserve, observePassive: legacyObserve,
  };
    return Object.create(NativeBackend.prototype, Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { value, writable: true, configurable: true, enumerable: true }]))) as NativeBackend;
  };
  const firstBackend = makeBackend(1), secondBackend = makeBackend(2), foreignBackend = makeBackend(3);
  const create = spyOn(NativeBackend, "create").mockResolvedValueOnce(firstBackend).mockResolvedValueOnce(secondBackend).mockResolvedValueOnce(foreignBackend);
  try {
    const first = await sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 23, address: "0xa1", stableId: "a1" } } }, a) as { sessionId: string };
    const second = await sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 23, address: "0xa2", stableId: "a2" } } }, a) as { sessionId: string };
    const foreign = await sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 24, address: "0xa3", stableId: "a3" } } }, b) as { sessionId: string };
    create.mockClear();
    const call = (method: string, params: unknown = {}, caller = owner, channel: object | undefined = ownerChannel) => sessions.dispatch({ method, params }, caller, channel);
    const enable = () => call("views.enable", { enabled: true });
    const targets = () => [{ sessionId: first.sessionId, appId: "app-1", windowId: "window-1", formats: ["image", "text"] },
      { sessionId: second.sessionId, appId: "app-2", windowId: "window-2", formats: ["image"] }];
    const enroll = (views = targets(), channelKey = "a") => call("views.enroll", { channelKey, expiresAt: 2000, views }) as Promise<{ views: { id: string; formats: string[] }[] }>;
    const read = (viewId: string, caller = a, channel = channelA, format = "image") => call("views.read", { viewId, format }, caller, channel) as Promise<ReadObservationLease>;
    const close = async () => { create.mockRestore(); await sessions.close(); await sessions.diagnostics.flush(); await rm(root, { recursive: true, force: true }); };
    const issueChannel = (views = targets(), expiresAt = 2000) => call("views.channel.issue", { key: approvalKey, expiresAt, views, identity: {
      callerId: a.id, pid: a.pid, birth: a.start, installation: recipientA.connector, instance: recipientA.instance, conversation: recipientA.conversation,
    } }) as Promise<{ enrollment: string; expiresAt: number }>;
    const activateChannel = (enrollment: string, caller = a, channel = connectorChannel) =>
      call("views.channel.activate", { enrollment }, caller, channel) as Promise<{ transport: string; channelKey: string; expiresAt: number }>;
    const transportCall = (secret: string, method: string, params: unknown = {}, caller = a) =>
      sessions.dispatchReadTransport({ method, params }, caller, secret);
    return { sessions, state, a, b, owner, channelA, channelB, ownerChannel, connectorChannel, approvalKey, recipientA, recipientB, readViews, firstBackend,
      issueChannel, activateChannel, transportCall,
      create, prepare, capture, legacyObserve, started, first, second, foreign, call, enable, enroll, read, targets, close };
  } catch (error) { create.mockRestore(); await sessions.close(); await rm(root, { recursive: true, force: true }); throw error; }
}

test("read views are absent by default and ordinary IPC-like dispatch has no protected channel", async () => {
  const f = await fixture(false);
  try {
    for (const method of ["views.enable", "views.enroll", "views.status", "views.read", "views.off"])
      await expect(f.call(method)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("injected feature remains off until exact owner channel enables it", async () => {
  const f = await fixture();
  try {
    await expect(f.enroll()).rejects.toMatchObject({ code: "READ_VIEW_OFF" });
    await expect(f.sessions.dispatch({ method: "views.enable", params: { enabled: true } }, f.owner)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(f.call("views.enable", { enabled: true }, f.a, f.ownerChannel)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.call("views.enable", { enabled: true }, f.owner, {})).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("owner enrolls exactly two owned windows; connector reads retained lease without token exposure", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const enrolled = await f.enroll();
    expect(enrolled.views).toHaveLength(2);
    expect(JSON.stringify(enrolled)).not.toMatch(/grant|private-fixture-title|sessionId/);
    const status = await f.call("views.status", {}, f.a, f.channelA);
    expect(status).toEqual({ enabled: true, views: enrolled.views });
    const lease = await f.read(enrolled.views[0]!.id);
    expect([...lease.bytes]).toEqual([1, 2, 3]);
    lease.release(); lease.release();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.legacyObserve).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("agent cannot enroll off revoke or impersonate the protected owner channel", async () => {
  const f = await fixture();
  try {
    await f.enable();
    for (const method of ["views.enroll", "views.off", "views.revoke"])
      await expect(f.call(method, { channelKey: "a" }, f.a, f.channelA)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.call("views.enable", { enabled: true, role: "owner" }, f.a, f.channelA)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.capture).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("owner enrollment refuses foreign sessions unknown windows duplicates and more than two views", async () => {
  const f = await fixture();
  try {
    await f.enable();
    await expect(f.enroll([{ sessionId: f.foreign.sessionId, appId: "app-3", windowId: "window-3", formats: ["image"] }])).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.enroll([{ ...f.targets()[0]!, windowId: "replaced" }])).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.enroll([f.targets()[0]!, f.targets()[0]!])).rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    await expect(f.enroll([...f.targets(), f.targets()[0]!])).rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("strict fields reject grant role labels and transport objects from request bodies", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll();
    for (const extra of [{ grant: "secret" }, { role: "owner" }, { conversation: "fixture-a" }, { channel: f.channelA }])
      await expect(f.call("views.read", { viewId: enrolled.views[0]!.id, format: "image", ...extra }, f.a, f.channelA)).rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    await expect(f.call("views.enable", { enabled: true, native: true })).rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("view ids are nonauthorizing across connector channels PID births and fabricated recipient copies", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll(); const id = enrolled.views[0]!.id;
    await expect(f.read(id, f.b, f.channelB)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.read(id, { ...f.a, pid: 4002 }, f.channelA)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.read(id, { ...f.a, start: "999" }, f.channelA)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.read(id, f.a, { ...f.channelA })).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const status = await f.call("views.status", {}, f.b, f.channelB);
    expect(status).toEqual({ enabled: true, views: [] });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("unqualified admission has no fallback or reader work", async () => {
  const f = await fixture();
  try {
    f.state.ready = false; await f.enable();
    await expect(f.enroll()).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.legacyObserve).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("unknown external provider cannot confirm release or deliver despite candidate output", async () => {
  const f = await fixture();
  try {
    f.state.unknown = true; await f.enable(); const enrolled = await f.enroll();
    await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_UNCONFIRMED" });
    await expect(f.read(enrolled.views[1]!.id)).rejects.toMatchObject({ code: "READ_VIEW_BUSY" });
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.legacyObserve).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

for (const operation of ["views.off", "views.revoke"] as const) test(operation + " suppresses accepted in-flight delivery and cannot be undone by same epoch on", async () => {
  const f = await fixture(); const gate = deferred<void>();
  try {
    f.state.captureGate = gate.promise; await f.enable(); const enrolled = await f.enroll();
    const pending = f.read(enrolled.views[0]!.id);
    const rejected = rejection(pending);
    await triggered(f.started.promise, rejected);
    expect(await f.call(operation, { channelKey: "a" })).toEqual({ revoked: true });
    gate.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.enroll()).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    f.state.epoch = 2;
    const renewed = await f.enroll(); expect(renewed.views).toHaveLength(2);
  } finally { gate.resolve(); await f.close(); }
});

test("off before reader admission avoids prepare and targets only the protected conversation", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll();
    await f.call("views.off", { channelKey: "b" });
    const lease = await f.read(enrolled.views[0]!.id); lease.release();
    await f.call("views.off", { channelKey: "a" });
    await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.capture).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test("trusted usage off/on epoch change during capture rejects the old grant after await", async () => {
  const f = await fixture(); const gate = deferred<void>();
  try {
    f.state.captureGate = gate.promise; await f.enable(); const enrolled = await f.enroll();
    const pending = f.read(enrolled.views[0]!.id); const rejected = rejection(pending);
    await triggered(f.started.promise, rejected);
    f.state.enabled = false; f.state.epoch = 2;
    f.state.enabled = true; f.state.epoch = 3;
    gate.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.capture).toHaveBeenCalledTimes(1);
  } finally { gate.resolve(); await f.close(); }
});

test("owner off while async usage is pending invalidates the old usage callback", async () => {
  const f = await fixture(), usage = deferred<void>(), entered = deferred<void>();
  try {
    await f.enable(); const enrolled = await f.enroll();
    f.state.usageHook = async () => { entered.resolve(); await usage.promise; };
    const pending = f.read(enrolled.views[0]!.id); const rejected = rejection(pending);
    await triggered(entered.promise, rejected); await f.call("views.off", { channelKey: "a" });
    usage.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { usage.resolve(); await f.close(); }
});

test("post-capture async usage off refuses delivery and releases the proven fake result", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll();
    f.state.usageHook = async () => { if (f.state.usageCalls === 3) { f.state.enabled = false; f.state.epoch = 2; } };
    await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_OFF" });
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.state.usageCalls).toBe(3);
  } finally { await f.close(); }
});

test("exact window object replacement or geometry changes invalidate binding without fallback", async () => {
  for (const replace of [false, true]) {
    const f = await fixture();
    try {
      await f.enable(); const enrolled = await f.enroll();
      const handoff = f.firstBackend.handoff!;
      if (replace) handoff.windows = handoff.windows.map(window => ({ ...window }));
      else handoff.windows[0]!.width++;
      await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.legacyObserve).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }
});

test("lease remains guarded after dispatch diagnostics awaits and owner revocation", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll(); const lease = await f.read(enrolled.views[0]!.id);
    await f.call("views.off", { channelKey: "a" });
    expect(() => lease.bytes).toThrow(); lease.release();
  } finally { await f.close(); }
});

test("dynamic owner issue activate enroll read and revoke uses the actual channel registry", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const issued = await f.issueChannel();
    expect(issued.enrollment).toMatch(/^[a-f0-9]{64}$/);
    const activated = await f.activateChannel(issued.enrollment);
    await expect(f.issueChannel()).rejects.toMatchObject({ code: "READ_CHANNEL_CONFLICT" });
    expect(activated.transport).not.toBe(issued.enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    expect(JSON.stringify(enrolled)).not.toContain(issued.enrollment);
    expect(JSON.stringify(enrolled)).not.toContain(activated.transport);
    const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
    expect([...lease.bytes]).toEqual([1, 2, 3]);
    expect(await f.call("views.channel.revoke", { key: f.approvalKey })).toEqual({ revoked: true });
    expect(() => lease.bytes).toThrow(); lease.release();
    await expect(f.transportCall(activated.transport, "views.status")).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(f.create).not.toHaveBeenCalled(); expect(f.legacyObserve).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("dynamic channel secrets and owner issuance cannot cross ordinary dispatch or wrong protected control channels", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable();
    await expect(f.sessions.dispatch({ method: "views.channel.issue", params: {} }, f.owner)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(f.call("views.channel.issue", {}, f.a, f.ownerChannel)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const issued = await f.issueChannel();
    await expect(f.activateChannel(issued.enrollment, f.a, {})).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    await expect(f.activateChannel(issued.enrollment, f.b)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    const activated = await f.activateChannel(issued.enrollment);
    await expect(f.activateChannel(issued.enrollment)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    await expect(f.transportCall(activated.transport, "views.status", {}, { ...f.a, start: "999" })).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    await expect(f.sessions.dispatch({ method: "views.read", params: { transport: activated.transport } }, f.a)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("dynamic read enrollment cannot broaden approved native window formats or expiration", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable();
    const approved = [{ ...f.targets()[0]!, formats: ["image"] }];
    const activated = await f.activateChannel((await f.issueChannel(approved)).enrollment);
    await expect(f.enroll([f.targets()[1]!], activated.channelKey)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.enroll([f.targets()[0]!], activated.channelKey)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.call("views.enroll", { channelKey: activated.channelKey, expiresAt: 2001, views: approved })).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const enrolled = await f.enroll(approved, activated.channelKey);
    await expect(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "text" })).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
    expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
  } finally { await f.close(); }
});

test("dynamic owner approval refuses foreign sessions and replaced canonical window bindings", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable();
    await expect(f.issueChannel([{ sessionId: f.foreign.sessionId, appId: "app-3", windowId: "window-3", formats: ["image"] }]))
      .rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const approved = [f.targets()[0]!];
    const activated = await f.activateChannel((await f.issueChannel(approved)).enrollment);
    f.firstBackend.handoff!.windows = f.firstBackend.handoff!.windows.map(window => ({ ...window }));
    await expect(f.enroll(approved, activated.channelKey)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

for (const operation of ["revoke", "detach"] as const) test("dynamic registry " + operation + " callback synchronously fences accepted reader work", async () => {
  const f = await fixture(true, false, true), gate = deferred<void>();
  try {
    await f.enable(); const activated = await f.activateChannel((await f.issueChannel()).enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey); f.state.captureGate = gate.promise;
    const outcome = rejection(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as Promise<ReadObservationLease>);
    await triggered(f.started.promise, outcome);
    if (operation === "revoke") await f.call("views.channel.revoke", { key: f.approvalKey });
    else await f.call("views.channel.detach", { instance: f.recipientA.instance });
    expect((await f.started.promise).isCurrent()).toBe(false);
    gate.resolve(); expect(await outcome).toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.transportCall(activated.transport, "views.status")).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
  } finally { gate.resolve(); await f.close(); }
});

test("dynamic off revokes read authority without resurrecting it through an unchanged usage epoch", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const activated = await f.activateChannel((await f.issueChannel()).enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    await f.call("views.off", { channelKey: activated.channelKey });
    await expect(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" })).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    await expect(f.enroll(f.targets(), activated.channelKey)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    f.state.epoch = 2;
    expect((await f.enroll(f.targets(), activated.channelKey)).views).toHaveLength(2);
    expect(f.capture).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("dynamic transport expiry and clock rollback cannot restore a stale captured lease", async () => {
  for (const time of [2000, 999]) {
    const f = await fixture(true, false, true);
    try {
      await f.enable(); const activated = await f.activateChannel((await f.issueChannel()).enrollment);
      const enrolled = await f.enroll(f.targets(), activated.channelKey);
      const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
      f.state.now = time;
      expect(() => lease.bytes).toThrow(); lease.release();
      f.state.now = 1000;
      await expect(f.transportCall(activated.transport, "views.status")).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    } finally { await f.close(); }
  }
});

test("dynamic process invalidation permanently revokes transport instead of trusting a reused claim", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const activated = await f.activateChannel((await f.issueChannel()).enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    f.state.alive = false;
    await expect(f.transportCall(activated.transport, "views.status")).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    f.state.alive = true;
    await expect(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" })).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("dynamic registry revocation never frees unresolved reader credit for a new approval", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const activated = await f.activateChannel((await f.issueChannel([f.targets()[0]!])).enrollment);
    const enrolled = await f.enroll([f.targets()[0]!], activated.channelKey); f.state.unknown = true;
    await expect(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" })).rejects.toMatchObject({ code: "READ_VIEW_UNCONFIRMED" });
    await f.call("views.channel.revoke", { key: f.approvalKey });
    const issued = await f.call("views.channel.issue", { key: {}, expiresAt: 2000, views: [f.targets()[0]!], identity: {
      callerId: f.a.id, pid: f.a.pid, birth: f.a.start, installation: f.recipientA.connector, instance: f.recipientA.instance, conversation: f.recipientA.conversation,
    } }) as { enrollment: string };
    const replacement = await f.activateChannel(issued.enrollment);
    await expect(f.enroll([f.targets()[0]!], replacement.channelKey)).rejects.toMatchObject({ code: "READ_VIEW_LIMIT" });
    expect(f.capture).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test("dynamic protected exchange secrets never enter diagnostics or model-visible view metadata", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const issued = await f.issueChannel(), activated = await f.activateChannel(issued.enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    const status = await f.transportCall(activated.transport, "views.status");
    const report = await f.sessions.diagnostics.report();
    const publicText = JSON.stringify({ enrolled, status, report });
    expect(publicText).not.toContain(issued.enrollment); expect(publicText).not.toContain(activated.transport);
    expect(publicText).not.toContain("private-fixture-title");
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("read transport rejects every non-read method before dispatch without state or backend effects", async () => {
  const f = await fixture(true, false, true);
  try {
    await f.enable(); const activated = await f.activateChannel((await f.issueChannel()).enrollment);
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    const state = mutableSession(f).state;
    for (const method of ["session.act", "session.stop", "session.pause", "session.resume", "session.create", "session.narrow", "session.control",
      "session.forget", "native.open", "native.present", "native.candidates", "views.enable", "views.enroll", "views.off", "views.channel.issue",
      "views.channel.activate", "views.channel.revoke", "diagnostics.report", "settings.write", "caller.detach", "update.begin"]) {
      await expect(f.transportCall(activated.transport, method, { sessionId: f.first.sessionId, enabled: false }))
        .rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    }
    let getterReads = 0;
    const forged = Object.defineProperty({ params: {} }, "method", { get() { getterReads++; return "session.stop"; }, enumerable: true });
    await expect(f.sessions.dispatchReadTransport(forged, f.a, activated.transport)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(getterReads).toBe(0);
    expect(mutableSession(f).state).toBe(state); expect(f.create).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
    expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
  } finally { await f.close(); }
});

test("consumed activation bookkeeping failure revokes exactly its pending channel without losing capacity", async () => {
  const f = await fixture(true, false, true);
  let restore: (() => void) | undefined;
  try {
    await f.enable(); const issued = await f.issueChannel();
    const original = crypto.randomUUID.bind(crypto); let calls = 0;
    const random = spyOn(crypto, "randomUUID").mockImplementation(() => {
      if (++calls === 2) throw new Error("fixture channel bookkeeping failed");
      return original();
    });
    restore = () => random.mockRestore();
    await expect(f.activateChannel(issued.enrollment)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    restore(); restore = undefined;
    expect(await f.call("views.channel.status")).toMatchObject({ active: 0, pending: 0, quarantined: 0 });
    await expect(f.activateChannel(issued.enrollment)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { restore?.(); await f.close(); }
});

test("expiry during post-activation resolution cannot leak a consumed active credential", async () => {
  const f = await fixture(true, false, true);
  let restore: (() => void) | undefined;
  try {
    await f.enable(); const issued = await f.issueChannel();
    const registry = (f.sessions as unknown as { readTransportRegistry: ReadChannelRegistry }).readTransportRegistry;
    const original = registry.resolve.bind(registry);
    const resolve = spyOn(registry, "resolve").mockImplementation((secret, caller) => { f.state.now = 2000; return original(secret, caller); });
    restore = () => resolve.mockRestore();
    await expect(f.activateChannel(issued.enrollment)).rejects.toMatchObject({ code: "READ_CHANNEL_DENIED" });
    restore(); restore = undefined;
    expect(await f.call("views.channel.status")).toMatchObject({ active: 0, pending: 0, quarantined: 0 });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { restore?.(); await f.close(); }
});

for (const control of ["issue", "activate"] as const) test("dynamic " + control + " secret refuses delivery when owner revokes during diagnostics await", async () => {
  const f = await fixture(true, false, true), logged = deferred<void>(), release = deferred<void>();
  let restore: (() => void) | undefined;
  try {
    await f.enable();
    const issued = control === "activate" ? await f.issueChannel() : undefined;
    const original = f.sessions.diagnostics.run.bind(f.sessions.diagnostics);
    const run = spyOn(f.sessions.diagnostics, "run").mockImplementation(async (value, work) => {
      const body = value as { method?: string };
      if (body.method !== "views.channel." + control) return original(value, work);
      const result = await work(); logged.resolve(); await release.promise; return result;
    });
    restore = () => run.mockRestore();
    const pending = settle<unknown>(control === "issue" ? f.issueChannel() : f.activateChannel(issued!.enrollment));
    await triggered(logged.promise, pending);
    await f.call("views.channel.revoke", { key: f.approvalKey });
    release.resolve();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(await f.call("views.channel.status")).toMatchObject({ active: 0, pending: 0 });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { release.resolve(); restore?.(); await f.close(); }
});

test("delayed duplicate issue reply cannot revoke the transport activated from the first issue reply", async () => {
  const f = await fixture(true, false, true), logged = deferred<void>(), release = deferred<void>();
  let restore: (() => void) | undefined;
  try {
    await f.enable(); const issued = await f.issueChannel();
    const original = f.sessions.diagnostics.run.bind(f.sessions.diagnostics);
    const run = spyOn(f.sessions.diagnostics, "run").mockImplementation(async (value, work) => {
      if ((value as { method?: string }).method !== "views.channel.issue") return original(value, work);
      const result = await work(); logged.resolve(); await release.promise; return result;
    });
    restore = () => run.mockRestore();
    const duplicate = settle(f.issueChannel()); await triggered(logged.promise, duplicate);
    const activated = await f.activateChannel(issued.enrollment);
    release.resolve(); const outcome = await duplicate;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "READ_CHANNEL_DENIED" });
    expect(await f.call("views.channel.status")).toMatchObject({ active: 1, pending: 0, quarantined: 0 });
    const enrolled = await f.enroll(f.targets(), activated.channelKey);
    const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
    expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
  } finally { release.resolve(); restore?.(); await f.close(); }
});

test("malicious formats and view arrays cannot override attenuation checks or execute caller accessors", async () => {
  const f = await fixture(true, false, true);
  let effects = 0;
  try {
    await f.enable();
    const imageOnly = [{ ...f.targets()[0]!, formats: ["image"] }];
    const activated = await f.activateChannel((await f.issueChannel(imageOnly)).enrollment);
    const lyingSome = Object.assign(["text"], { some: () => { effects++; return false; } });
    const lyingIterator = Object.defineProperty(["image"], Symbol.iterator, { value: function* () { effects++; yield "text"; } });
    const getter = Object.defineProperty(["image"], "0", { enumerable: true, get() { effects++; return "text"; } });
    const prototype = Object.setPrototypeOf(["text"], Object.create(Array.prototype));
    const extra = Object.assign(["image"], { extra: true });
    const proxy = new Proxy(["text"], { get(target, key, receiver) { effects++; return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) { effects++; return Reflect.getOwnPropertyDescriptor(target, key); } });
    for (const formats of [lyingSome, lyingIterator, getter, prototype, extra, proxy, new Array(1)]) {
      await expect(f.enroll([{ ...f.targets()[0]!, formats: formats as string[] }], activated.channelKey))
        .rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    }
    const outer = Object.assign([...imageOnly], { map: () => { effects++; return f.targets(); } });
    await expect(f.call("views.enroll", { channelKey: activated.channelKey, expiresAt: 2000, views: outer }))
      .rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    const outerGetter = Object.defineProperty([...imageOnly], "0", { enumerable: true, get() { effects++; return f.targets()[1]; } });
    await expect(f.call("views.enroll", { channelKey: activated.channelKey, expiresAt: 2000, views: outerGetter }))
      .rejects.toMatchObject({ code: "READ_VIEW_INVALID" });
    expect(effects).toBe(0); expect(f.prepare).not.toHaveBeenCalled();
    const enrolled = await f.enroll(imageOnly, activated.channelKey);
    await expect(f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "text" }))
      .rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const lease = await f.transportCall(activated.transport, "views.read", { viewId: enrolled.views[0]!.id, format: "image" }) as ReadObservationLease;
    expect([...lease.bytes]).toEqual([1, 2, 3]); lease.release();
  } finally { await f.close(); }
});

type MutableSession = { ownerId: string; policy: SessionPolicy; state: string };
const mutableSession = (f: Awaited<ReturnType<typeof fixture>>) =>
  (f.sessions as unknown as { sessions: Map<string, MutableSession> }).sessions.get(f.first.sessionId)!;
const consultPolicy = (policy: SessionPolicy): SessionPolicy => ({ ...policy,
  advisor: { command: ["/fixture/advisor-must-never-run"], timeoutMs: 100 },
  rules: [{ id: "observe-consult", verb: "observe", decision: "consult", reason: "fixture second opinion" }] });

test("consult policy is not explicit allow at enrollment or after capture", async () => {
  for (const duringCapture of [false, true]) {
    const f = await fixture(), gate = deferred<void>();
    try {
      await f.enable();
      const session = mutableSession(f);
      if (!duringCapture) {
        session.policy = consultPolicy(session.policy);
        expect(decide(session.policy, "observe").outcome).toBe("consult");
        await expect(f.enroll()).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
        expect(f.prepare).not.toHaveBeenCalled();
      } else {
        const enrolled = await f.enroll(); f.state.captureGate = gate.promise;
        const pending = f.read(enrolled.views[0]!.id), rejected = rejection(pending);
        await triggered(f.started.promise, rejected);
        session.policy = consultPolicy(session.policy);
        gate.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
      }
      expect(f.legacyObserve).not.toHaveBeenCalled();
    } finally { gate.resolve(); await f.close(); }
  }
});

test("session owner mutation during capture invalidates exact ownership snapshot", async () => {
  const f = await fixture(), gate = deferred<void>();
  try {
    await f.enable(); const enrolled = await f.enroll(); f.state.captureGate = gate.promise;
    const pending = f.read(enrolled.views[0]!.id), rejected = rejection(pending);
    await triggered(f.started.promise, rejected);
    mutableSession(f).ownerId = "conv:foreign-replacement";
    gate.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
  } finally { gate.resolve(); await f.close(); }
});

test("concurrent enrollment for one channel has exactly one winner and no hidden budget views", async () => {
  const f = await fixture(), usage = deferred<void>(), entered = deferred<void>();
  try {
    await f.enable();
    f.state.usageHook = async () => { entered.resolve(); await usage.promise; };
    const pending = settle(f.enroll()); await triggered(entered.promise, pending);
    await expect(f.enroll()).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    usage.resolve(); const result = await pending;
    if (!result.ok) throw result.error;
    const enrolled = result.value;
    expect(enrolled.views).toHaveLength(2);
    const lease = await f.read(enrolled.views[0]!.id); lease.release();
    await f.call("views.revoke", { channelKey: "a" }); f.state.epoch = 2;
    expect((await f.enroll()).views).toHaveLength(2);
  } finally { usage.resolve(); await f.close(); }
});

test("canonical physical binding cannot be enrolled twice across protected channels", async () => {
  const f = await fixture(true, true);
  try {
    await f.enable();
    const one = [f.targets()[0]!];
    const results = await Promise.allSettled([f.enroll(one, "a"), f.enroll(one, "b")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const refusal = results.find(result => result.status === "rejected");
    expect(refusal?.status === "rejected" ? refusal.reason.code : undefined).toBe("READ_VIEW_LIMIT");
    expect(f.capture).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("expired grant pointer clears safely for fresh owner enrollment under the same usage epoch", async () => {
  const f = await fixture();
  try {
    await f.enable(); const before = await f.enroll();
    f.state.now = 2001;
    const after = await f.call("views.enroll", { channelKey: "a", expiresAt: 3000, views: f.targets() }) as { views: { id: string }[] };
    expect(after.views).toHaveLength(2);
    expect(after.views[0]!.id).not.toBe(before.views[0]!.id);
    await expect(f.read(before.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
    const lease = await f.read(after.views[0]!.id); lease.release();
  } finally { await f.close(); }
});

test("backend-invalidated registry grant does not leave an unrenewable broker pointer", async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.enroll();
    f.state.current = false;
    expect(await f.call("views.status", {}, f.a, f.channelA)).toEqual({ enabled: true, views: [] });
    f.state.current = true; f.state.epoch = 2;
    const renewed = await f.enroll(); expect(renewed.views).toHaveLength(2);
    const lease = await f.read(renewed.views[0]!.id); lease.release();
  } finally { await f.close(); }
});

test("synchronous usage fence blocks bytes when usage changes during diagnostics await without off RPC", async () => {
  const f = await fixture(), logging = deferred<void>(), releaseLog = deferred<void>();
  let restoreRun: (() => void) | undefined;
  try {
    await f.enable(); const enrolled = await f.enroll();
    const run = spyOn(f.sessions.diagnostics, "run").mockImplementation(async (_value, work) => {
      const result = await work(); logging.resolve(); await releaseLog.promise; return result;
    });
    restoreRun = () => run.mockRestore();
    const pending = settle(f.read(enrolled.views[0]!.id));
    await triggered(logging.promise, pending);
    f.state.enabled = false; f.state.epoch = 2;
    releaseLog.resolve();
    const result = await pending;
    if (!result.ok) throw result.error;
    const lease = result.value;
    expect(() => lease.bytes).toThrow(); lease.release();
  } finally { releaseLog.resolve(); restoreRun?.(); await f.close(); }
});

test("session stop immediately revokes accepted pending read without a new observer request", async () => {
  const f = await fixture(), gate = deferred<void>();
  try {
    await f.enable(); const enrolled = await f.enroll(); f.state.captureGate = gate.promise;
    const pending = f.read(enrolled.views[0]!.id), rejected = rejection(pending);
    await triggered(f.started.promise, rejected);
    await f.sessions.dispatch({ method: "session.stop", params: { sessionId: f.first.sessionId } }, f.a);
    gate.resolve(); expect(await rejected).toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(f.legacyObserve).not.toHaveBeenCalled();
  } finally { gate.resolve(); await f.close(); }
});

test("process death before admission and after capture denies with fixed content-free errors", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll(); f.state.alive = false;
    await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_DENIED", message: "Read view request refused" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.call("views.status", {}, f.b, f.channelB).catch(error => ({ code: error.code, message: error.message })))).not.toContain("private-fixture-title");
  } finally { await f.close(); }
});

test("broker lease reserves delivery scratch only while usage and channel remain current", async () => {
  const f = await fixture();
  try {
    await f.enable(); const enrolled = await f.enroll();
    const lease = await f.read(enrolled.views[0]!.id);
    const loan = lease.reserveDelivery(4);
    await f.call("views.off", { channelKey: "a" });
    expect(() => lease.reserveDelivery(1)).toThrow();
    lease.release();
    expect(loan.release()).toBe(true);
    expect(loan.release()).toBe(false);
  } finally { await f.close(); }
});

test("coordinator off fences an accepted broker read before durable acknowledgement", async () => {
  const authority = {}, gate = deferred<void>();
  let listener: ((conversation: object) => void) | undefined;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke: key => { if (!listener) throw new Error(); listener(key); },
    store: { commit: async (_conversation, record) => { if (!record.enabled) await gate.promise; } } });
  let conversation!: object;
  const budgets: ReadResourceBudget[] = [];
  const reserveOriginal = ReadResourceBudget.prototype.reserve;
  const reserve = spyOn(ReadResourceBudget.prototype, "reserve").mockImplementation(function (this: ReadResourceBudget, view, cost) {
    budgets.push(this); return reserveOriginal.call(this, view, cost);
  });
  const f = await fixture(true, false, false, identity => {
    conversation = identity; coordinator.register(authority, identity);
    return { usageVersion: coordinator.usageVersion, usageCurrent: coordinator.usageCurrent,
      bindUsageRevocation: callback => { listener = callback; return () => { listener = undefined; }; } };
  });
  try {
    await coordinator.on(authority, conversation); await f.enable();
    const enrolled = await f.enroll();
    const lease = await f.read(enrolled.views[0]!.id);
    const captureGate = deferred<void>(); f.state.captureGate = captureGate.promise; f.state.unknown = true;
    const secondStarted = deferred<void>();
    f.capture.mockImplementationOnce(async context => {
      secondStarted.resolve(); await captureGate.promise;
      context.lifecycle.unknownDrain(); return new Uint8Array([1, 2, 3]);
    });
    const outcome = rejection(f.read(enrolled.views[1]!.id));
    await triggered(secondStarted.promise, outcome);
    let acknowledged = false; const off = coordinator.off(authority, conversation).then(() => { acknowledged = true; });
    expect(acknowledged).toBe(false);
    expect((f.sessions as unknown as { readKeys: Map<string, { grant?: string }> }).readKeys.get("a")?.grant).toBeUndefined();
    expect(() => lease.bytes).toThrow();
    captureGate.resolve();
    expect(await outcome).toMatchObject({ code: "READ_VIEW_DENIED" });
    lease.release();
    expect(budgets[0]?.status()).toMatchObject({ captureOccupied: true, quarantined: 1, bytes: 16 });
    expect(acknowledged).toBe(false); gate.resolve(); await off; expect(acknowledged).toBe(true);
    await coordinator.on(authority, conversation);
    await expect(f.read(enrolled.views[0]!.id)).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
  } finally { gate.resolve(); reserve.mockRestore(); await f.close(); }
});

test("coordinator revokes only its exact protected conversation", async () => {
  const authority = {}, gate = deferred<void>();
  let listener: ((key: object) => void) | undefined, a!: object, b!: object;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority,
    onRevoke: key => { if (!listener) throw new Error(); listener(key); },
    store: { commit: async (_key, record) => { if (!record.enabled) await gate.promise; } } });
  const f = await fixture(true, false, false, (first, second) => {
    a = first; b = second; coordinator.register(authority, a); coordinator.register(authority, b);
    return { usageVersion: coordinator.usageVersion, usageCurrent: coordinator.usageCurrent,
      bindUsageRevocation: callback => { listener = callback; return () => { listener = undefined; }; } };
  });
  try {
    await coordinator.on(authority, a); await coordinator.on(authority, b); await f.enable();
    const first = await f.enroll();
    const second = await f.enroll([{ sessionId: f.foreign.sessionId, appId: "app-3", windowId: "window-3", formats: ["image"] }], "b");
    const leaseA = await f.read(first.views[0]!.id), leaseB = await f.read(second.views[0]!.id, f.b, f.channelB);
    const off = coordinator.off(authority, a);
    expect(() => leaseA.bytes).toThrow(); expect([...leaseB.bytes]).toEqual([1, 2, 3]);
    const keys = (f.sessions as unknown as { readKeys: Map<string, { grant?: string }> }).readKeys;
    expect(keys.get("a")?.grant).toBeUndefined(); expect(keys.get("b")?.grant).toBeDefined();
    gate.resolve(); await off; leaseA.release(); leaseB.release();
  } finally { gate.resolve(); await f.close(); }
});

test("subscription initialization reentry refuses and releases the binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-read-bind-"));
  let saved: ((key: object) => void) | undefined, cleanup = 0;
  const config: SessionReadViewsOptions = { ownerIdentity: {}, ownerChannel: {}, channels: [],
    backend: { admissionReady: () => true, recipientCurrent: () => true, bindingCurrent: () => true,
      prepare: () => { throw new Error(); } }, liveProcess: () => true,
    usageVersion: async conversation => ({ conversation, epoch: 1, enabled: false }), usageCurrent: () => false,
    bindUsageRevocation: callback => {
      saved = callback; try { callback({}); } catch { /* Binding cannot ignore this failure. */ }
      return () => { cleanup++; };
    } };
  try {
    expect(() => new Sessions(root, undefined, undefined, undefined, undefined, { readViews: config })).toThrow();
    expect(cleanup).toBe(1); expect(() => saved?.({})).not.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown fences protected reentry even when unsubscribe throws", async () => {
  let saved: ((key: object) => void) | undefined, calls = 0, during: Promise<unknown> | undefined;
  let runDuringClose: (() => Promise<unknown>) | undefined;
  const f = await fixture(true, false, false, () => ({
    usageVersion: async conversation => ({ conversation, epoch: 1, enabled: true }), usageCurrent: () => true,
    bindUsageRevocation: callback => { saved = callback; return () => {
      calls++; during = settle(runDuringClose!()); callback({}); throw new Error("private");
    }; },
  }));
  try {
    await f.enable(); const enrolled = await f.enroll(); const lease = await f.read(enrolled.views[0]!.id);
    runDuringClose = () => f.call("views.enable", { enabled: true });
    await f.sessions.close();
    expect(calls).toBe(1); expect(await during).toMatchObject({ ok: false });
    expect(() => lease.bytes).toThrow(); lease.release();
    expect(() => saved?.({})).not.toThrow();
    await expect(f.call("views.enable", { enabled: true })).rejects.toMatchObject({ code: "READ_VIEW_DENIED" });
  } finally { await f.close(); }
});

test("shared store poison synchronously revokes two actual broker conversations and retains unknown reader debt", async () => {
  const authority = {}, captureGate = deferred<void>(), captureStarted = deferred<ReadCaptureContext>();
  let listener: ((key: object) => void) | undefined, a!: object, b!: object, poisoning = false;
  let epochs: number[] = [], writes = 0;
  const notifications: object[] = [], allFenced: boolean[] = [], budgets: ReadResourceBudget[] = [];
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: { async commit() { writes++; } }, onRevoke: key => {
    if (poisoning) {
      notifications.push(key);
      allFenced.push(!coordinator.usageCurrent(a, epochs[0]!) && !coordinator.usageCurrent(b, epochs[1]!));
    }
    if (!listener) throw new Error("Missing protected broker binding");
    listener(key);
    if (poisoning && key === a) throw new Error("private-first-notification-failure");
  } });
  const original = ReadResourceBudget.prototype.reserve;
  const reserve = spyOn(ReadResourceBudget.prototype, "reserve").mockImplementation(function (this: ReadResourceBudget, view, cost) {
    budgets.push(this); return original.call(this, view, cost);
  });
  const f = await fixture(true, false, false, (first, second) => {
    a = first; b = second; coordinator.register(authority, a); coordinator.register(authority, b);
    return { usageVersion: coordinator.usageVersion, usageCurrent: coordinator.usageCurrent,
      bindUsageRevocation: callback => { listener = callback; return () => { listener = undefined; }; } };
  });
  let leaseA: ReadObservationLease | undefined, leaseB: ReadObservationLease | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    await coordinator.on(authority, a); await coordinator.on(authority, b); await f.enable();
    epochs = [(await coordinator.usageVersion(a)).epoch, (await coordinator.usageVersion(b)).epoch];
    const first = await f.enroll();
    const second = await f.enroll([{ sessionId: f.foreign.sessionId, appId: "app-3", windowId: "window-3", formats: ["image"] }], "b");
    leaseA = await f.read(first.views[0]!.id); leaseB = await f.read(second.views[0]!.id, f.b, f.channelB);
    f.capture.mockImplementationOnce(async context => {
      captureStarted.resolve(context); await captureGate.promise;
      context.lifecycle.unknownDrain(); return new Uint8Array([1, 2, 3]);
    });
    pending = rejection(f.read(first.views[1]!.id));
    await triggered(captureStarted.promise, pending);
    poisoning = true; coordinator.poisonAll(authority);
    expect(notifications).toEqual([a, b]); expect(allFenced).toEqual([true, true]);
    const keys = (f.sessions as unknown as { readKeys: Map<string, { grant?: string }> }).readKeys;
    expect(keys.get("a")?.grant).toBeUndefined(); expect(keys.get("b")?.grant).toBeUndefined();
    expect(() => leaseA!.bytes).toThrow(); expect(() => leaseB!.bytes).toThrow();
    expect((await captureStarted.promise).isCurrent()).toBe(false);
    leaseA.release(); leaseB.release();
    captureGate.resolve(); expect(await pending).toMatchObject({ code: "READ_VIEW_DENIED" });
    expect(budgets[0]?.status()).toMatchObject({ captureOccupied: true, quarantined: 1, bytes: 16 });
    const on = await coordinator.on(authority, a).catch((error: { code: string }) => error.code);
    const off = await coordinator.off(authority, b).catch((error: { code: string }) => error.code);
    expect(on).toBe("UNCONFIRMED"); expect(off).toBe("UNCONFIRMED"); expect(writes).toBe(2);
    expect(f.legacyObserve).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    coordinator.poisonAll(authority); expect(notifications).toEqual([a, b]);
  } finally {
    captureGate.resolve(); await pending;
    leaseA?.release(); leaseB?.release(); reserve.mockRestore(); await f.close();
  }
});
