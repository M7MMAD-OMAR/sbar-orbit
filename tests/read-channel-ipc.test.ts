import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/ipc";
import { callerHeader, encodeClaim, ownerHeader, ownerTokenMatches, readOwnerCredential, resolveCaller, type ProcessProbe } from "../src/caller";
import { ReadChannelError, ReadChannelRegistry, type ReadChannelEnrollment } from "../src/read-channel-registry";

const linux = process.platform === "linux" ? test : test.skip;
const transportHeader = "x-orbit-fixture-read-channel";
type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-read-channel-ipc-"));
  const uid = process.getuid?.() ?? 1000;
  const state = { now: 1000, birth: "100", alive: true };
  const pid = 424242;
  const probe: ProcessProbe = { start: value => value === pid ? state.birth : undefined,
    owner: value => value === pid ? uid : undefined,
    alive: (value, birth) => state.alive && value === pid && birth === state.birth };
  const broker = await startBroker({ probe, session: { alive: () => false } });
  const credential = readOwnerCredential(broker.socket);
  if (!credential) { await broker.close(); await rm(root, { recursive: true, force: true }); throw new Error("Owned fixture credential missing"); }
  const authority = {}, ownerIdentity = {}, installation = {}, instance = {}, conversation = {};
  const enrollment: ReadChannelEnrollment = { key: {}, callerId: "conv:owned-fixture", pid, birth: "100", installation, instance, conversation,
    expiresAt: 2000, views: [{ binding: {}, bindingEpoch: 1, formats: ["image"] }] };
  const registry = new ReadChannelRegistry({ ownerAuthority: authority, ownerIdentity, now: () => state.now,
    processCurrent: identity => state.alive && identity.pid === pid && identity.birth === state.birth
      && identity.installation === installation && identity.instance === instance && identity.conversation === conversation });
  const bridgeSocket = join(root, "fixture-only.sock");
  // Explicit TEST-ONLY bridge. No route or header below is installed in src/ipc.ts.
  // The production broker still never obtains a protected channel from caller JSON.
  const bridge = Bun.serve({ unix: bridgeSocket, async fetch(request) {
    try {
      const body = await request.json() as { method?: unknown; params?: unknown };
      const params = body.params;
      const owner = ownerTokenMatches(request.headers.get(ownerHeader), credential);
      if (body.method === "fixture.channel.issue" || body.method === "fixture.channel.status") {
        if (!owner) throw new ReadChannelError("DENIED");
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) throw new ReadChannelError("INVALID");
        const result = body.method === "fixture.channel.issue" ? registry.issue(authority, enrollment) : registry.status(authority);
        return Response.json({ ok: true, result });
      }
      const caller = resolveCaller(request.headers.get(callerHeader), probe, uid);
      if (body.method === "fixture.channel.activate") {
        if (!params || typeof params !== "object" || Array.isArray(params)
            || Object.keys(params).length !== 1 || !("enrollment" in params) || typeof params.enrollment !== "string") throw new ReadChannelError("INVALID");
        return Response.json({ ok: true, result: registry.activate(params.enrollment, caller) });
      }
      if (body.method === "fixture.channel.resolve") {
        const resolved = registry.resolve(request.headers.get(transportHeader), caller);
        return Response.json({ ok: true, result: { resolved: !!resolved } });
      }
      throw new ReadChannelError("DENIED");
    } catch (error) {
      return Response.json({ ok: false, error: { code: error instanceof ReadChannelError ? error.code : "INVALID", message: "Connector channel request refused" } });
    }
  } });
  await chmod(bridgeSocket, 0o600);
  const headers = (birth = "100", claimedPid = pid, conversationId = "owned-fixture") => ({
    [callerHeader]: encodeClaim({ v: 1, kind: "adapter", pid: claimedPid, start: birth, conversationId, host: "display-only-label" }),
  });
  const ownerHeaders = { [ownerHeader]: credential };
  const request = async (socket: string, method: string, params: unknown = {}, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<Reply> => {
    const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ method, params, ...extra }), signal: AbortSignal.timeout(3000) });
    return await response.json() as Reply;
  };
  const real = (method: string, params: unknown = {}, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => request(broker.socket, method, params, headers, extra);
  const local = (method: string, params: unknown = {}, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => request(bridgeSocket, method, params, headers, extra);
  const issue = async () => {
    const result = await local("fixture.channel.issue", {}, ownerHeaders);
    expect(result.ok).toBe(true);
    return (result.result as { enrollment: string }).enrollment;
  };
  const activate = async (secret: string) => {
    const result = await local("fixture.channel.activate", { enrollment: secret }, headers());
    expect(result.ok).toBe(true);
    return (result.result as { transport: string }).transport;
  };
  return { root, state, registry, authority, ownerIdentity, installation, instance, conversation, enrollment, broker, credential,
    headers, ownerHeaders, real, local, issue, activate,
    close: async () => { bridge.stop(true); registry.close(authority); await broker.close(); await rm(root, { recursive: true, force: true }); } };
}

linux("real private IPC keeps read views unavailable even with valid owner credentials", async () => {
  const f = await fixture();
  try {
    for (const method of ["views.enable", "views.enroll", "views.read", "views.status", "views.off", "views.revoke"]) {
      const reply = await f.real(method, {}, f.ownerHeaders);
      expect(reply).toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: "Read views are unavailable" } });
    }
  } finally { await f.close(); }
});

linux("real IPC body role caller and channel spoofing never creates a protected read transport", async () => {
  const f = await fixture();
  try {
    const reply = await f.real("views.enable", { enabled: true, role: "owner", protectedReadChannel: {}, ownerAuthority: {} }, f.headers(),
      { caller: { role: "owner", verified: true }, role: "owner", protectedReadChannel: {} });
    expect(reply).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    const legacy = await f.real("session.stop", { scope: "mine", role: "owner" }, {}, { role: "owner", caller: { role: "owner" } });
    expect(legacy).toMatchObject({ ok: true, result: { scope: "mine", owner: "unidentified client", stopped: [], failed: [] } });
  } finally { await f.close(); }
});

linux("legacy session list detach and owner stop remain available without native sessions", async () => {
  const f = await fixture();
  try {
    expect(await f.real("session.list", {}, f.headers())).toEqual({ ok: true, result: [] });
    expect(await f.real("caller.detach", {}, f.headers())).toEqual({ ok: true, result: { detached: true } });
    expect(await f.real("session.stop", { scope: "mine" }, f.ownerHeaders)).toMatchObject({ ok: true, result: { owner: "the person", stopped: [], failed: [] } });
    expect(await f.real("session.create", { backend: "browser" }, f.headers())).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  } finally { await f.close(); }
});

linux("test-only bridge issuance requires actual owner credential not body authority or caller labels", async () => {
  const f = await fixture();
  try {
    for (const headers of [{}, f.headers(), { [ownerHeader]: "0".repeat(64) }] as Record<string, string>[]) {
      expect(await f.local("fixture.channel.issue", {}, headers, { role: "owner", ownerAuthority: {}, verified: true }))
        .toMatchObject({ ok: false, error: { code: "DENIED" } });
    }
    const secret = await f.issue(); expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.local("fixture.channel.issue", { pid: 1, conversation: "model-selected" }, f.ownerHeaders)).toMatchObject({ ok: false, error: { code: "INVALID" } });
  } finally { await f.close(); }
});

linux("test-only exchange is one-use and exact verified connector resolves a stable opaque channel", async () => {
  const f = await fixture();
  try {
    const secret = await f.issue(), transport = await f.activate(secret);
    expect(transport).not.toBe(secret);
    expect(await f.local("fixture.channel.activate", { enrollment: secret }, f.headers())).toMatchObject({ ok: false, error: { code: "DENIED" } });
    expect(await f.local("fixture.channel.resolve", {}, { ...f.headers(), [transportHeader]: transport })).toEqual({ ok: true, result: { resolved: true } });
    const caller = resolveCaller(f.headers()[callerHeader], { start: () => "100", owner: () => process.getuid?.(), alive: () => true });
    const first = f.registry.resolve(transport, caller), second = f.registry.resolve(transport, caller);
    expect(first).toBe(second); expect(first?.recipient.conversation).toBe(f.conversation);
    expect(first?.recipient.owner).toBe(f.ownerIdentity);
    expect(first?.channel).not.toEqual({ role: "owner" });
  } finally { await f.close(); }
});

linux("wrong PID birth conversation or owner-header-only activation cannot consume enrollment", async () => {
  const f = await fixture();
  try {
    const secret = await f.issue();
    for (const headers of [f.headers("100", 424243), f.headers("101"), f.headers("100", 424242, "other-conversation"), f.ownerHeaders] as Record<string, string>[])
      expect(await f.local("fixture.channel.activate", { enrollment: secret }, headers)).toMatchObject({ ok: false, error: { code: "DENIED" } });
    expect(await f.activate(secret)).toMatch(/^[a-f0-9]{64}$/);
  } finally { await f.close(); }
});

linux("expired capability and reused PID birth fail closed without transport resolution", async () => {
  const f = await fixture();
  try {
    const secret = await f.issue(); f.state.now = 2000;
    expect(await f.local("fixture.channel.activate", { enrollment: secret }, f.headers())).toMatchObject({ ok: false, error: { code: "DENIED" } });
    expect(f.registry.resolve(secret, resolveCaller(f.headers()[callerHeader], { start: () => "100", owner: () => process.getuid?.(), alive: () => true }))).toBeUndefined();
  } finally { await f.close(); }
});

linux("active transport rejects forged headers and process birth replacement", async () => {
  const f = await fixture();
  try {
    const transport = await f.activate(await f.issue());
    for (const headers of [f.headers(), { ...f.headers(), [transportHeader]: "0".repeat(64) }, { ...f.headers("101"), [transportHeader]: transport }] as Record<string, string>[])
      expect(await f.local("fixture.channel.resolve", {}, headers)).toEqual({ ok: true, result: { resolved: false } });
    expect(await f.local("fixture.channel.resolve", { transport }, f.headers())).toEqual({ ok: true, result: { resolved: false } });
    f.state.birth = "101";
    expect(await f.local("fixture.channel.resolve", {}, { ...f.headers("101"), [transportHeader]: transport })).toEqual({ ok: true, result: { resolved: false } });
  } finally { await f.close(); }
});

linux("owner revoke invalidates protected channel but never creates reader credit or public capability", async () => {
  const f = await fixture();
  try {
    const transport = await f.activate(await f.issue());
    expect(f.registry.revoke(f.authority, f.enrollment.key)).toBe(true);
    expect(await f.local("fixture.channel.resolve", {}, { ...f.headers(), [transportHeader]: transport })).toEqual({ ok: true, result: { resolved: false } });
    expect(await f.real("views.read", { viewId: "a".repeat(24), format: "image" }, { ...f.headers(), [transportHeader]: transport }))
      .toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  } finally { await f.close(); }
});

linux("secrets never enter registry status real broker diagnostics or fixed refusal bodies", async () => {
  const f = await fixture();
  try {
    const secret = await f.issue(), transport = await f.activate(secret);
    const refused = await f.real("views.read", { viewId: "b".repeat(24), format: "image", enrollment: secret }, { ...f.headers(), [transportHeader]: transport });
    const status = await f.local("fixture.channel.status", {}, f.ownerHeaders);
    const report = await f.real("diagnostics.report", {}, f.ownerHeaders);
    const text = JSON.stringify({ refused, status, report });
    expect(text).not.toContain(secret); expect(text).not.toContain(transport); expect(text).not.toContain(f.credential);
    expect(text).not.toContain("owned-fixture"); expect(text).not.toContain("424242");
    expect(status).toMatchObject({ ok: true, result: { pending: 0, active: 1, quarantined: 0 } });
  } finally { await f.close(); }
});
