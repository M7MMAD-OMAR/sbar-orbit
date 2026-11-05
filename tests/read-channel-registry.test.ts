import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import type { Caller } from "../src/caller";
import { ReadChannelRegistry, ReadChannelError, type ReadChannelEnrollment,
  type ReadConnectorIdentity, type ResolvedReadChannel } from "../src/read-channel-registry";

const secret = "PRIVATE-process-installation-content-attribution";
function fixture(options: { maxChannels?: number; maxIssues?: number } = {}) {
  const authority = {}, ownerIdentity = {}, key = {}, installation = {}, instance = {}, conversation = {}, binding = {};
  const caller: Caller = { id: "conv:protected-host-attribution", label: secret,
    role: "agent", kind: "adapter", verified: true, pid: 123, start: "456" };
  const state = { now: 1000, live: true, birth: "456", calls: 0, notifications: [] as ResolvedReadChannel[],
    verified: undefined as ReadConnectorIdentity | undefined };
  let verify = (identity: ReadConnectorIdentity) => state.live && identity.pid === 123 && identity.birth === state.birth;
  let revoke = (channel: ResolvedReadChannel) => { state.notifications.push(channel); };
  let clock = () => state.now;
  const registry = new ReadChannelRegistry({ ownerAuthority: authority, ownerIdentity, ...options,
    now: () => clock(), processCurrent: identity => { state.calls++; state.verified = identity; return verify(identity); },
    onRevoke: channel => revoke(channel) });
  const input = (overrides: Partial<ReadChannelEnrollment> = {}): ReadChannelEnrollment => ({ key, installation, instance,
    conversation, callerId: caller.id, pid: 123, birth: "456", expiresAt: 2000,
    views: [{ binding, bindingEpoch: 1, formats: ["text", "image"] }], ...overrides });
  const issue = (overrides: Partial<ReadChannelEnrollment> = {}) => registry.issue(authority, input(overrides));
  const connect = () => { const ticket = issue(); const credential = registry.activate(ticket.enrollment, caller);
    const resolved = registry.resolve(credential.transport, caller)!; return { ticket, credential, resolved }; };
  return { registry, authority, ownerIdentity, key, installation, instance, conversation, binding, caller, state, input, issue, connect,
    setVerify: (callback: typeof verify) => { verify = callback; }, setRevoke: (callback: typeof revoke) => { revoke = callback; },
    setClock: (callback: typeof clock) => { clock = callback; } };
}
function refused(operation: () => unknown, code = "DENIED") {
  try { operation(); throw new Error("Expected connector refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ReadChannelError); expect(error).toMatchObject({ code }); expect(String(error)).not.toContain(secret); }
}

test("constructor and owner status do not create process work or channels", () => {
  const f = fixture(); expect(f.state.calls).toBe(0);
  expect(f.registry.status(f.authority)).toEqual({ closed: false, pending: 0, active: 0, quarantined: 0, capacity: 8, issuesRemaining: 1024 });
  expect(f.registry.resolve(undefined, f.caller)).toBeUndefined(); expect(f.state.calls).toBe(0);
});

test("one-use enrollment exchanges into a distinct exact process transport secret", () => {
  const f = fixture(), { ticket, credential, resolved } = f.connect();
  expect(ticket.enrollment).toMatch(/^[a-f0-9]{64}$/); expect(credential.transport).toMatch(/^[a-f0-9]{64}$/);
  expect(ticket.enrollment).not.toBe(credential.transport);
  refused(() => f.registry.activate(ticket.enrollment, f.caller));
  expect(f.registry.resolve(ticket.enrollment, f.caller)).toBeUndefined();
  expect(f.registry.resolve(credential.transport, { ...f.caller })).toBe(resolved);
  expect(f.registry.isCurrent(resolved.channel)).toBe(true);
  expect(f.registry.status(f.authority)).toMatchObject({ pending: 0, active: 1 });
});

test("protected resolved principal has exact owner installation instance conversation and channel identities", () => {
  const f = fixture(), { resolved } = f.connect();
  expect(resolved.recipient).toEqual({ owner: f.ownerIdentity, connector: f.installation, instance: f.instance,
    conversation: f.conversation, channel: resolved.channel, pid: 123, birth: "456" });
  expect(resolved.views[0]!.binding).toBe(f.binding); expect(resolved.callerId).toBe(f.caller.id);
  expect(Object.isFrozen(resolved)).toBe(true); expect(Object.isFrozen(resolved.recipient)).toBe(true);
  expect(Object.isFrozen(resolved.views)).toBe(true); expect(Object.isFrozen(resolved.views[0]!.formats)).toBe(true);
  expect(f.registry.isCurrent({ ...resolved.channel })).toBe(false);
});

test("owner enrollment idempotency is exact and does not consume additional issue capacity", () => {
  const f = fixture(), first = f.issue(), second = f.issue();
  expect(first).toEqual(second); expect(f.registry.status(f.authority)).toMatchObject({ pending: 1, issuesRemaining: 1023 });
  for (const update of [{ expiresAt: 2001 }, { conversation: {} }, { instance: {} }, { installation: {} }, { birth: "457" },
    { views: [{ binding: f.binding, bindingEpoch: 2, formats: ["text"] as const }] }])
    refused(() => f.issue(update), "CONFLICT");
  expect(f.registry.activate(first.enrollment, f.caller).transport).toMatch(/^[a-f0-9]{64}$/);
});

test("copied body owner role and cloned authority objects cannot issue revoke detach or close", () => {
  const f = fixture();
  for (const authority of [{}, { role: "owner", verified: true }]) {
    refused(() => f.registry.issue(authority, f.input())); refused(() => f.registry.revoke(authority, f.key));
    refused(() => f.registry.detach(authority, f.instance)); refused(() => f.registry.close(authority));
    refused(() => f.registry.status(authority));
  }
  expect(f.state.calls).toBe(0); expect(f.registry.status(f.authority).pending).toBe(0);
});

test("enrollment cannot activate across conversation pid birth or unverified caller", () => {
  const f = fixture(), ticket = f.issue();
  for (const change of [{ id: "conv:foreign" }, { pid: 124 }, { start: "457" }, { start: undefined },
    { verified: false }, { kind: "cli" }, { role: "owner" }]) {
    refused(() => f.registry.activate(ticket.enrollment, { ...f.caller, ...change } as Caller));
  }
  expect(f.registry.status(f.authority)).toMatchObject({ pending: 1, active: 0 });
  expect(f.registry.activate(ticket.enrollment, f.caller).transport).toMatch(/^[a-f0-9]{64}$/);
});

test("foreign token holder cannot select or revoke rightful connector", () => {
  const f = fixture(), { credential, resolved } = f.connect();
  const calls = f.state.calls;
  for (const change of [{ id: "conv:foreign" }, { pid: 124 }, { start: "457" }, { verified: false }])
    expect(f.registry.resolve(credential.transport, { ...f.caller, ...change })).toBeUndefined();
  expect(f.state.calls).toBe(calls); expect(f.registry.resolve(credential.transport, f.caller)).toBe(resolved);
});

test("malformed headers and random JSON role objects do no verification work", () => {
  const f = fixture();
  for (const value of [undefined, null, "", "a".repeat(63), "A".repeat(64), "f".repeat(100000), { role: "owner" }])
    expect(f.registry.resolve(value as string, f.caller)).toBeUndefined();
  expect(f.state.calls).toBe(0);
});

test("capabilities are isolated to one broker registry epoch", () => {
  const f = fixture(), g = fixture(), { ticket, credential, resolved } = f.connect();
  refused(() => g.registry.activate(ticket.enrollment, f.caller));
  expect(g.registry.resolve(credential.transport, f.caller)).toBeUndefined();
  expect(g.registry.isCurrent(resolved.channel)).toBe(false);
  f.registry.close(f.authority); expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
});

test("process verifier receives trusted exact installation and actual conversation snapshot", () => {
  const f = fixture(); f.connect();
  expect(f.state.verified).toMatchObject({ pid: 123, birth: "456", callerId: f.caller.id });
  expect(f.state.verified!.installation).toBe(f.installation); expect(f.state.verified!.instance).toBe(f.instance);
  expect(f.state.verified!.conversation).toBe(f.conversation); expect(Object.isFrozen(f.state.verified)).toBe(true);
});

test("process death and PID reuse invalidate resolution and notify revocation once", () => {
  for (const mode of ["dead", "reused"]) {
    const f = fixture(), { credential, resolved } = f.connect();
    if (mode === "dead") f.state.live = false; else f.state.birth = "999";
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    expect(f.registry.isCurrent(resolved.channel)).toBe(false); expect(f.state.notifications).toEqual([resolved]);
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined(); expect(f.state.notifications).toHaveLength(1);
  }
});

test("fail-closed process verification rejects false truthy missing and throwing proof", () => {
  for (const proof of [() => false, () => undefined, () => 1, () => { throw new Error(secret); }]) {
    const f = fixture(); f.setVerify(proof as (identity: ReadConnectorIdentity) => boolean);
    refused(() => f.issue()); expect(f.registry.status(f.authority).pending).toBe(0);
  }
});

test("expiry is absolute at exact boundary including final channel fence", () => {
  const f = fixture(), { credential, resolved } = f.connect(); f.state.now = 2000;
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
  expect(f.registry.isCurrent(resolved.channel)).toBe(false); expect(f.state.notifications).toHaveLength(1);
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 0 });
});

test("pending enrollment expires before exchange and cannot be renewed by replay", () => {
  const f = fixture(), ticket = f.issue(); f.state.now = 2000;
  refused(() => f.registry.activate(ticket.enrollment, f.caller));
  refused(() => f.issue({ expiresAt: 3000 }), "CONFLICT");
});

test("strict lifetime caps include exact ten-minute boundary", () => {
  for (const expiresAt of [999, 1000, 601001, NaN, Infinity, true, "2000"]) {
    const f = fixture(); refused(() => f.issue({ expiresAt: expiresAt as number }), "INVALID");
  }
  expect(fixture().issue({ expiresAt: 601000 }).expiresAt).toBe(601000);
});

test("strict process attribution rejects loose labels booleans invalid birth and raw binding ids", () => {
  const updates: Partial<ReadChannelEnrollment>[] = [{ callerId: "Agent" }, { callerId: "conv:" }, { callerId: "conv:a\nb" },
    { pid: true as unknown as number }, { pid: 1 }, { birth: "start" }, { birth: "1".repeat(21) },
    { installation: "app.desktop" as unknown as object }, { conversation: "label" as unknown as object },
    { views: [{ binding: "window-id" as unknown as object, bindingEpoch: 1, formats: ["text"] }] }];
  for (const update of updates) { const f = fixture(); refused(() => f.issue(update), "INVALID"); expect(f.state.calls).toBe(0); }
});

test("scope is an exact bounded already-resolved view set with no implicit pixel widening", () => {
  const f = fixture();
  for (const views of [[], [0, 1, 2].map(() => ({ binding: {}, bindingEpoch: 1, formats: ["text"] as const })),
    [{ binding: f.binding, bindingEpoch: 1, formats: ["text"] as const }, { binding: f.binding, bindingEpoch: 1, formats: ["image"] as const }],
    [{ binding: {}, bindingEpoch: 1, formats: ["both"] }], [{ binding: {}, bindingEpoch: 0, formats: ["text"] }],
    [{ binding: {}, bindingEpoch: 1, formats: ["text", "text"] }]])
    refused(() => f.issue({ views: views as ReadChannelEnrollment["views"] }), "INVALID");
  const ticket = f.issue({ views: [{ binding: f.binding, bindingEpoch: 1, formats: ["text"] }] });
  const credential = f.registry.activate(ticket.enrollment, f.caller);
  expect(f.registry.resolve(credential.transport, f.caller)!.views[0]!.formats).toEqual(["text"]);
});

test("caller and owner input accessors are refused without executing them", () => {
  const f = fixture(); let calls = 0;
  const input = f.input(); Object.defineProperty(input, "pid", { get() { calls++; return 123; } });
  refused(() => f.registry.issue(f.authority, input), "INVALID");
  const ticket = f.issue(), caller = { ...f.caller };
  Object.defineProperty(caller, "pid", { get() { calls++; return 123; } });
  refused(() => f.registry.activate(ticket.enrollment, caller)); expect(calls).toBe(0);
});

test("null prototype data is valid, exotic prototypes and unknown fields are not authority", () => {
  const f = fixture(), input = Object.assign(Object.create(null), f.input());
  const ticket = f.registry.issue(f.authority, input);
  expect(f.registry.activate(ticket.enrollment, Object.assign(Object.create(null), f.caller)).transport).toMatch(/^[a-f0-9]{64}$/);
  const g = fixture(); refused(() => g.registry.issue(g.authority, Object.create(g.input())), "INVALID");
  refused(() => g.registry.issue(g.authority, { ...g.input(), role: "owner" } as ReadChannelEnrollment), "INVALID");
});

test("mutating original enrollment arrays or metadata cannot widen snapshotted scope", () => {
  const f = fixture(), input = f.input(), views = [{ binding: f.binding, bindingEpoch: 1, formats: ["text"] as ("text" | "image")[] }];
  const ticket = f.registry.issue(f.authority, { ...input, views });
  views[0]!.formats.push("image"); views[0]!.bindingEpoch = 2;
  const credential = f.registry.activate(ticket.enrollment, f.caller), resolved = f.registry.resolve(credential.transport, f.caller)!;
  expect(resolved.views[0]!.formats).toEqual(["text"]); expect(resolved.views[0]!.bindingEpoch).toBe(1);
});

test("duplicate connector instance or physical binding cannot receive another active ticket", () => {
  const f = fixture(); f.issue();
  refused(() => f.issue({ key: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "CONFLICT");
  refused(() => f.issue({ key: {}, instance: {} }), "CONFLICT");
  expect(f.registry.status(f.authority).pending).toBe(1);
});

test("pending plus active capacity is bounded and stricter limits cannot be raised", () => {
  const f = fixture({ maxChannels: 2 }); f.connect();
  f.issue({ key: {}, instance: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] });
  refused(() => f.issue({ key: {}, instance: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
  expect(f.registry.status(f.authority)).toMatchObject({ active: 1, pending: 1, capacity: 2 });
  for (const maxChannels of [0, -1, 9, true, null]) refused(() => fixture({ maxChannels: maxChannels as number }), "INVALID");
});

test("lifetime issue budget bounds revoked request history without reset on revoke", () => {
  const f = fixture({ maxIssues: 2 }); f.issue(); f.registry.revoke(f.authority, f.key);
  const other = {}; f.issue({ key: other }); f.registry.revoke(f.authority, other);
  refused(() => f.issue({ key: {} }), "LIMIT"); expect(f.registry.status(f.authority).issuesRemaining).toBe(0);
});

test("revoke and detach invalidate immediately before downstream notification without freeing reader accounting", () => {
  for (const mode of ["revoke", "detach"]) {
    const f = fixture(), { credential, resolved } = f.connect(); let occupiedReaderBytes = 1234;
    f.setRevoke(channel => { expect(channel).toBe(resolved); expect(f.registry.isCurrent(channel.channel)).toBe(false); });
    if (mode === "revoke") expect(f.registry.revoke(f.authority, f.key)).toBe(true);
    else f.registry.detach(f.authority, f.instance);
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    expect(occupiedReaderBytes).toBe(1234); occupiedReaderBytes = 0;
    expect(f.registry.revoke(f.authority, f.key)).toBe(false);
  }
});

test("failed revocation callback quarantines bounded slot and never restores old transport", () => {
  const f = fixture({ maxChannels: 1 }), { credential, resolved } = f.connect();
  f.setRevoke(() => { throw new Error(secret); }); f.registry.revoke(f.authority, f.key);
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined(); expect(f.registry.isCurrent(resolved.channel)).toBe(false);
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 0, quarantined: 1 });
  refused(() => f.issue({ key: {}, instance: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
});

test("reentrant issue from verifier is bounded and guard resets on failure", () => {
  const f = fixture(); f.setVerify(() => { refused(() => f.issue(), "BUSY"); return true; });
  const ticket = f.issue(); expect(f.registry.status(f.authority).pending).toBe(1);
  f.registry.revoke(f.authority, f.key);
  f.setVerify(() => { f.issue({ key: {} }); return true; });
  refused(() => f.issue({ key: {} })); expect(f.registry.status(f.authority).pending).toBe(0);
  f.setVerify(() => true); expect(f.issue({ key: {} }).enrollment).not.toBe(ticket.enrollment);
});

test("reentrant revoke or close during proof cannot publish a channel or revive an enrollment", () => {
  for (const mode of ["revoke", "close"]) {
    const f = fixture(); f.setVerify(() => {
      if (mode === "revoke") f.registry.revoke(f.authority, f.key); else f.registry.close(f.authority);
      return true;
    });
    refused(() => f.issue()); expect(f.registry.status(f.authority).pending).toBe(0);
  }
});

test("resolve proof callback detachment and nested resolution fail closed", () => {
  const f = fixture(), { credential, resolved } = f.connect();
  f.setVerify(() => { expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    f.registry.detach(f.authority, f.instance); return true; });
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined(); expect(f.registry.isCurrent(resolved.channel)).toBe(false);
});

test("clock expiry during proof and backwards clock cannot authorize delayed transport", () => {
  const f = fixture(), { credential } = f.connect(); f.setVerify(() => { f.state.now = 2000; return true; });
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
  const g = fixture(), connection = g.connect(); g.state.now = 999;
  expect(g.registry.resolve(connection.credential.transport, g.caller)).toBeUndefined();
});

test("entropy collision never overwrites active secret or reuses revoked token tombstones", () => {
  const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => Buffer.alloc(size, 7)) as typeof crypto.randomBytes);
  try {
    const f = fixture(), ticket = f.issue();
    refused(() => f.registry.activate(ticket.enrollment, f.caller), "LIMIT");
    expect(f.registry.status(f.authority)).toMatchObject({ pending: 1, active: 0 });
    f.registry.revoke(f.authority, f.key);
    refused(() => f.issue({ key: {} }), "LIMIT");
    expect(f.registry.status(f.authority).pending).toBe(0);
  } finally { random.mockRestore(); }
});

test("retired owner request cannot be replayed with a fresh scope or later expiry", () => {
  const f = fixture(), { ticket, credential } = f.connect(); f.registry.revoke(f.authority, f.key);
  refused(() => f.issue({ expiresAt: 3000 }), "CONFLICT");
  refused(() => f.registry.activate(ticket.enrollment, f.caller));
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
});

test("caller mutation within process proof cannot publish activation or resolution", () => {
  const f = fixture(), ticket = f.issue();
  f.setVerify(() => { f.caller.start = "999"; return true; });
  refused(() => f.registry.activate(ticket.enrollment, f.caller));
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 1 });
  const g = fixture(), { credential } = g.connect();
  g.setVerify(() => { g.caller.id = "conv:foreign"; return true; });
  expect(g.registry.resolve(credential.transport, g.caller)).toBeUndefined();
});

test("final live clock cannot publish revoked or closed resolve or isCurrent results", () => {
  for (const operation of ["resolve", "isCurrent"]) for (const mutation of ["revoke", "close"]) {
    const f = fixture(), { credential, resolved } = f.connect(); let armed = false;
    f.setVerify(() => { armed = true; return true; });
    f.setClock(() => {
      if (armed) {
        armed = false;
        if (mutation === "revoke") f.registry.revoke(f.authority, f.key); else f.registry.close(f.authority);
      }
      return f.state.now;
    });
    if (operation === "resolve") expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    else expect(f.registry.isCurrent(resolved.channel)).toBe(false);
    expect(f.state.notifications).toEqual([resolved]);
    f.setVerify(() => true);
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
  }
});

test("final issue clock cannot publish after reentrant revoke or close", () => {
  for (const mutation of ["revoke", "close"]) {
    const f = fixture(); let armed = false;
    f.setVerify(() => { armed = true; return true; });
    f.setClock(() => {
      if (armed) {
        armed = false;
        if (mutation === "revoke") f.registry.revoke(f.authority, f.key); else f.registry.close(f.authority);
      }
      return f.state.now;
    });
    refused(() => f.issue());
    expect(f.registry.status(f.authority)).toMatchObject({ pending: 0, active: 0, issuesRemaining: 1024 });
  }
});

test("second caller descriptor check cannot revoke then publish activate or resolve", () => {
  for (const operation of ["activate", "resolve"]) for (const mutation of ["revoke", "close"]) {
    const f = fixture(), ticket = f.issue();
    const credential = operation === "resolve" ? f.registry.activate(ticket.enrollment, f.caller) : undefined;
    let checks = 0;
    const caller = new Proxy(f.caller, { getOwnPropertyDescriptor(target, key) {
      if (key === "id" && ++checks === 4) {
        if (mutation === "revoke") f.registry.revoke(f.authority, f.key); else f.registry.close(f.authority);
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    if (credential) expect(f.registry.resolve(credential.transport, caller)).toBeUndefined();
    else refused(() => f.registry.activate(ticket.enrollment, caller));
    expect(checks).toBe(4); expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 0 });
  }
});

test("final post-caller clock is fenced after its own revocation callback", () => {
  for (const operation of ["activate", "resolve"]) {
    const f = fixture(), ticket = f.issue();
    const credential = operation === "resolve" ? f.registry.activate(ticket.enrollment, f.caller) : undefined;
    let checks = 0, armed = false;
    const caller = new Proxy(f.caller, { getOwnPropertyDescriptor(target, key) {
      if (key === "id" && ++checks === 4) armed = true;
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    f.setClock(() => { if (armed) { armed = false; f.registry.close(f.authority); } return f.state.now; });
    if (credential) expect(f.registry.resolve(credential.transport, caller)).toBeUndefined();
    else refused(() => f.registry.activate(ticket.enrollment, caller));
    expect(checks).toBe(4); expect(f.registry.status(f.authority)).toMatchObject({ closed: true, active: 0, pending: 0 });
  }
});

test("caller descriptor introspection cannot recursively resolve or issue authority", () => {
  const f = fixture(), { credential, resolved } = f.connect(); let nested = 0;
  const caller = new Proxy(f.caller, { getOwnPropertyDescriptor(target, key) {
    if (key === "id") {
      nested++; expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
      expect(f.registry.isCurrent(resolved.channel)).toBe(false);
      refused(() => f.issue(), "BUSY");
    }
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  expect(f.registry.resolve(credential.transport, caller)).toBe(resolved); expect(nested).toBe(4);
});

test("throwing or backwards sweep clock permanently invalidates all channels even after recovery", () => {
  for (const failure of ["throw", "backwards"]) {
    const f = fixture(), { credential, resolved } = f.connect();
    f.setClock(() => { if (failure === "throw") throw new Error(secret); return 999; });
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    f.setClock(() => 1000);
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    expect(f.registry.isCurrent(resolved.channel)).toBe(false); refused(() => f.issue({ key: {} }));
    expect(f.state.notifications).toEqual([resolved]);
    expect(f.registry.status(f.authority)).toMatchObject({ closed: true, pending: 0, active: 0 });
  }
});

test("clock fault preserves failed downstream invalidation in quarantine and repeated revoke is false", () => {
  const f = fixture(), { credential, resolved } = f.connect(); let notifications = 0;
  f.setRevoke(() => { notifications++; throw new Error(secret); });
  f.setClock(() => { throw new Error(secret); });
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
  f.setClock(() => 1000);
  expect(f.registry.isCurrent(resolved.channel)).toBe(false);
  expect(f.registry.revoke(f.authority, f.key)).toBe(false);
  expect(f.registry.status(f.authority)).toMatchObject({ closed: true, quarantined: 1, pending: 0, active: 0 });
  expect(notifications).toBe(1);
});

test("clock callback recursion is bounded and no channel revives after nested clock fault", () => {
  const f = fixture(), { credential } = f.connect(); let calls = 0;
  f.setClock(() => {
    calls++;
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    f.registry.status(f.authority); // A nested clock read permanently fails closed.
    return f.state.now;
  });
  expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined(); expect(calls).toBe(1);
  f.setClock(() => 1000); expect(f.registry.status(f.authority)).toMatchObject({ closed: true, active: 0 });
});

test("process verifier receives exact frozen identity keys without enrollment authority or scope", () => {
  const f = fixture(); f.connect();
  expect(Reflect.ownKeys(f.state.verified!).sort()).toEqual(["birth", "callerId", "conversation", "installation", "instance", "pid"]);
  expect(Object.isFrozen(f.state.verified)).toBe(true);
});

test("idempotent owner issue after activation returns only the spent exchange ticket", () => {
  const f = fixture(), { ticket, credential, resolved } = f.connect();
  expect(f.issue()).toEqual(ticket); refused(() => f.registry.activate(ticket.enrollment, f.caller));
  expect(f.registry.resolve(credential.transport, f.caller)).toBe(resolved);
});

test("entropy callback revocation cannot publish issue or activate results", () => {
  for (const operation of ["issue", "activate"]) {
    const f = fixture(), ticket = operation === "activate" ? f.issue() : undefined;
    const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => {
      f.registry.close(f.authority); return Buffer.alloc(size, 9);
    }) as typeof crypto.randomBytes);
    try {
      if (ticket) refused(() => f.registry.activate(ticket.enrollment, f.caller));
      else refused(() => f.issue());
      expect(f.registry.status(f.authority)).toMatchObject({ closed: true, active: 0, pending: 0 });
    } finally { random.mockRestore(); }
  }
});

test("scope arrays reject overridden methods iterators getters holes and proxies without callbacks", () => {
  for (const site of ["views", "formats"]) for (const poison of ["some", "map", "iterator", "getter", "hole", "proxy", "prototype"]) {
    const f = fixture(); let calls = 0;
    const view = { binding: f.binding, bindingEpoch: 1, formats: ["text"] as ("text" | "image")[] };
    let values: unknown[] = site === "formats" ? view.formats : [view];
    if (poison === "some" || poison === "map") Object.defineProperty(values, poison, { get() { calls++; return () => false; } });
    if (poison === "iterator") Object.defineProperty(values, Symbol.iterator, { value: function* () { calls++; yield "image"; } });
    if (poison === "getter") Object.defineProperty(values, "0", { get() { calls++; return "image"; } });
    if (poison === "hole") delete values[0];
    if (poison === "proxy") values = new Proxy(values, { ownKeys(target) { calls++; return Reflect.ownKeys(target); } });
    if (poison === "prototype") Object.setPrototypeOf(values, Object.create(Array.prototype));
    if (site === "formats") view.formats = values as ("text" | "image")[];
    const views = site === "views" ? values as ReadChannelEnrollment["views"] : [view];
    refused(() => f.issue({ views }), "INVALID"); expect(calls).toBe(0);
    expect(f.state.calls).toBe(0); expect(f.registry.status(f.authority)).toMatchObject({ pending: 0, active: 0, issuesRemaining: 1024 });
  }
});

test("format mutation from process verifier cannot widen enrolled scope", () => {
  const f = fixture(), formats: ("text" | "image")[] = ["text"];
  f.setVerify(() => { formats.push("image"); return true; });
  const ticket = f.issue({ views: [{ binding: f.binding, bindingEpoch: 1, formats }] });
  const credential = f.registry.activate(ticket.enrollment, f.caller), resolved = f.registry.resolve(credential.transport, f.caller)!;
  expect(resolved.views[0]!.formats).toEqual(["text"]); expect(Object.isFrozen(resolved.views[0]!.formats)).toBe(true);
});

test("status and errors never expose authority secrets caller labels process data or view scope", () => {
  const f = fixture(), { ticket, credential } = f.connect(); const status = JSON.stringify(f.registry.status(f.authority));
  for (const value of [ticket.enrollment, credential.transport, f.caller.id, secret, "birth", "pid", "views", "binding", "installation"])
    expect(status).not.toContain(value);
  refused(() => f.registry.activate(secret, f.caller));
});


function independent(f: ReturnType<typeof fixture>) {
  const key = {}, instance = {}, conversation = {}, binding = {};
  const ticket = f.issue({ key, instance, conversation, views: [{ binding, bindingEpoch: 1, formats: ["text"] }] });
  const credential = f.registry.activate(ticket.enrollment, f.caller);
  const resolved = f.registry.resolve(credential.transport, f.caller)!;
  return { key, instance, conversation, binding, ticket, credential, resolved };
}

test("nonvoid revocation results quarantine slots bindings and tokens even after ordinary Promise settlement", async () => {
  for (const mode of ["pending", "fulfilled", "rejected", "cross-realm", "thenable", "scalar", "object"] as const) {
    const f = fixture({ maxChannels: 2 }), { credential, resolved } = f.connect();
    let settle!: () => void, thenReads = 0, callbacks = 0;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const thenable = Object.defineProperty({}, "then", { get() { thenReads++; throw new Error(secret); } });
    f.setRevoke(() => {
      callbacks++;
      if (mode === "pending") return pending as never;
      if (mode === "fulfilled") return Promise.resolve() as never;
      if (mode === "rejected") return Promise.reject(new Error(secret)) as never;
      if (mode === "cross-realm") return runInNewContext("Promise.reject(new Error('PRIVATE-cross-realm'))") as never;
      if (mode === "thenable") return thenable as never;
      return (mode === "scalar" ? 1 : { private: secret }) as never;
    });
    expect(f.registry.revoke(f.authority, f.key)).toBe(true);
    expect(f.registry.resolve(credential.transport, f.caller)).toBeUndefined();
    expect(f.registry.isCurrent(resolved.channel)).toBe(false);
    expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 0, quarantined: 1, capacity: 2 });
    refused(() => f.issue(), "CONFLICT");
    refused(() => f.issue({ key: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "CONFLICT");
    refused(() => f.issue({ key: {}, instance: {} }), "CONFLICT");
    const other = independent(f);
    expect(f.registry.resolve(other.credential.transport, f.caller)).toBe(other.resolved);
    expect(f.registry.isCurrent(other.resolved.channel)).toBe(true);
    refused(() => f.issue({ key: {}, instance: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
    settle(); await Promise.resolve(); await Promise.resolve();
    expect(f.registry.status(f.authority)).toMatchObject({ active: 1, quarantined: 1 });
    expect(f.registry.revoke(f.authority, f.key)).toBe(false);
    expect(callbacks).toBe(1); expect(thenReads).toBe(0);
    expect(JSON.stringify(f.registry.status(f.authority))).not.toContain(secret);
    // No async settlement is a synchronous revoke ACK or downstream drain proof.
  }
});

test("a pending revocation Promise rejected later remains observed and quarantined", async () => {
  const f = fixture({ maxChannels: 1 }), { resolved } = f.connect();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, failure) => { reject = failure; });
  f.setRevoke(() => pending as never);
  f.registry.revoke(f.authority, f.key);
  reject(new Error(secret)); await Promise.resolve(); await Promise.resolve();
  expect(f.registry.isCurrent(resolved.channel)).toBe(false);
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, quarantined: 1 });
  refused(() => f.issue({ key: {}, instance: {}, views: [{ binding: {}, bindingEpoch: 1, formats: ["text"] }] }), "LIMIT");
});

test("only synchronous undefined notification frees a retired binding slot", () => {
  const f = fixture({ maxChannels: 1 }), { resolved } = f.connect();
  const calls: ResolvedReadChannel[] = [];
  f.setRevoke(value => { calls.push(value); });
  expect(f.registry.revoke(f.authority, f.key)).toBe(true);
  expect(calls).toEqual([resolved]);
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, pending: 0, quarantined: 0 });
  // A fresh owner request may reuse the released instance/view, not the retired key.
  expect(f.issue({ key: {} }).enrollment).toMatch(/^[a-f0-9]{64}$/);
  refused(() => f.issue(), "CONFLICT");
});

test("nonvoid callback reentry stays revoked and notifies once without leaking raw failure", async () => {
  const f = fixture(), { resolved } = f.connect();
  const observations: { current: boolean; repeated: boolean }[] = [];
  f.setRevoke(value => {
    observations.push({ current: f.registry.isCurrent(value.channel), repeated: f.registry.revoke(f.authority, f.key) });
    f.registry.detach(f.authority, f.instance);
    return Promise.reject(new Error(secret)) as never;
  });
  expect(f.registry.revoke(f.authority, f.key)).toBe(true);
  await Promise.resolve();
  expect(observations).toEqual([{ current: false, repeated: false }]);
  expect(f.registry.status(f.authority)).toMatchObject({ quarantined: 1 });
  expect(f.registry.isCurrent(resolved.channel)).toBe(false);
});

test("unrelated revoke during true false or throwing process proof denies one check without retiring the target", () => {
  for (const mode of ["true", "false", "throw"] as const) {
    const f = fixture(), own = f.connect(), other = independent(f);
    let changed = false;
    f.setVerify(identity => {
      if (!changed && identity.instance === f.instance) {
        changed = true; f.registry.revoke(f.authority, other.key);
        if (mode === "throw") throw new Error(secret);
        return mode === "true";
      }
      return true;
    });
    expect(f.registry.resolve(own.credential.transport, f.caller)).toBeUndefined();
    expect(changed).toBe(true);
    expect(f.state.notifications).toEqual([other.resolved]);
    f.setVerify(() => true);
    expect(f.registry.resolve(own.credential.transport, f.caller)).toBe(own.resolved);
    expect(f.registry.isCurrent(own.resolved.channel)).toBe(true);
    expect(f.issue()).toEqual(own.ticket); // Target key was not retired by global drift.
    expect(f.registry.status(f.authority)).toMatchObject({ active: 1, quarantined: 0 });
  }
});

test("unrelated generation drift in before or final live clock preserves the target but never authorizes that sample", () => {
  for (const moment of ["before", "after"] as const) {
    const f = fixture(), own = f.connect(), other = independent(f);
    let armed = moment === "before", changed = false;
    const calls = f.state.calls;
    f.setVerify(() => { if (moment === "after" && !changed) armed = true; return true; });
    f.setClock(() => {
      if (armed && !changed) { armed = false; changed = true; f.registry.revoke(f.authority, other.key); }
      return f.state.now;
    });
    expect(f.registry.isCurrent(own.resolved.channel)).toBe(false);
    expect(changed).toBe(true);
    if (moment === "before") expect(f.state.calls).toBe(calls); // No proof ran, no claim of liveness.
    expect(f.state.notifications).toEqual([other.resolved]);
    f.setVerify(() => true); f.setClock(() => f.state.now);
    expect(f.registry.resolve(own.credential.transport, f.caller)).toBe(own.resolved);
    expect(f.issue()).toEqual(own.ticket);
  }
});

test("independent target expiry still retires it despite simultaneous unrelated generation change", () => {
  const f = fixture(), own = f.connect(), other = independent(f);
  let changed = false;
  f.setVerify(() => {
    if (!changed) { changed = true; f.registry.revoke(f.authority, other.key); f.state.now = 2000; }
    return true;
  });
  expect(f.registry.resolve(own.credential.transport, f.caller)).toBeUndefined();
  expect(f.state.notifications).toEqual([other.resolved, own.resolved]);
  f.setVerify(() => true);
  refused(() => f.issue({ expiresAt: 3000 }), "CONFLICT");
  expect(f.registry.status(f.authority)).toMatchObject({ active: 0, quarantined: 0 });
});
