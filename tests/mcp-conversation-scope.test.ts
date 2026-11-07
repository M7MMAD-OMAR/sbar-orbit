import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp";
import { createSessionMcpServer } from "../src/session-mcp";
import { hostConversationId, localClaim, type CallerClaim } from "../src/caller";
import { ConversationUsage } from "../src/conversation-usage";

type Rpc = { method: string; params: Record<string, unknown>; claim: CallerClaim };
const environmentKeys = ["ORBIT_USAGE_DIR", "ORBIT_CONVERSATION_ID", "T3CODE_THREAD_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID"];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-mcp-conversation-"));
  const socket = join(root, "broker.sock"), requests: Rpc[] = [];
  const connections: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];
  const holds = new Map<string, { seen: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const broker = Bun.serve({ unix: socket, async fetch(request) {
    const body = await request.json() as { method: string; params: Record<string, unknown> };
    const claim = JSON.parse(Buffer.from(request.headers.get("x-orbit-caller") ?? "", "base64url").toString("utf8")) as CallerClaim;
    requests.push({ ...body, claim });
    const hold = holds.get(String(body.params.requestId ?? `${body.method}:${claim.conversationId}`));
    if (hold) { hold.seen.resolve(); await hold.release.promise; }
    if (body.method === "native.open" && !claim.conversationId)
      return Response.json({ ok: false, error: { code: "CONVERSATION_REQUIRED", message: "Missing conversation before native opening" } });
    return Response.json({ ok: true, result: { method: body.method, caller: claim.conversationId,
      requestId: body.params.requestId, sessionId: body.params.sessionId } });
  } });
  const connect = async (options: { bound?: string; session?: string; identityConversation?: string } = {}) => {
    const saved = new Map(environmentKeys.map(key => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env.ORBIT_USAGE_DIR = join(root, "usage");
    if (options.bound !== undefined) process.env.ORBIT_CONVERSATION_ID = options.bound;
    let server: ReturnType<typeof createMcpServer>;
    try {
      const identity = { claim: { v: 1 as const, kind: "adapter" as const, pid: process.pid,
        ...(options.identityConversation === undefined ? {} : { conversationId: options.identityConversation }) } };
      server = options.session ? createSessionMcpServer(socket, options.session, identity) : createMcpServer(socket, identity);
    } finally {
      for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const client = new Client({ name: "conversation-scope-regression", version: "1" });
    connections.push({ client, server });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };
  const cli = async (conversation: string, params: Record<string, unknown>) => {
    const env = { ...process.env };
    for (const key of environmentKeys) delete env[key];
    delete env.ORBIT_OWNER;
    env.ORBIT_SOCKET = socket;
    env.ORBIT_USAGE_DIR = join(root, "usage");
    env.T3CODE_THREAD_ID = conversation;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "native-open", JSON.stringify(params)],
      { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  return { requests, holds, connect, cli,
    close: async () => {
      for (const hold of holds.values()) hold.release.resolve();
      await Promise.allSettled(connections.map(async ({ client, server }) => { await client.close(); await server.close(); }));
      broker.stop(true);
      await rm(root, { recursive: true, force: true });
    } };
}
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
const open = (client: Client, conversationId: string, requestId = "same-opening") => tool(client, "orbit_open", {
  conversationId, requestId, workspace: 7, applicationId: "org.example.OwnedFixture.desktop",
});

test("host environment precedence keeps caller and usage on the same actual conversation", () => {
  const cases = [
    { env: { ORBIT_CONVERSATION_ID: "explicit", T3CODE_THREAD_ID: "t3", CODEX_THREAD_ID: "codex", HERMES_SESSION_ID: "hermes" }, expected: "explicit" },
    { env: { T3CODE_THREAD_ID: "t3", CODEX_THREAD_ID: "codex", HERMES_SESSION_ID: "hermes" }, expected: "t3" },
    { env: { CODEX_THREAD_ID: "codex", HERMES_SESSION_ID: "hermes" }, expected: "codex" },
    { env: { HERMES_SESSION_ID: "hermes" }, expected: "hermes" },
    { env: {}, expected: undefined },
  ];
  const saved = new Map(environmentKeys.map(key => [key, process.env[key]]));
  try {
    for (const { env, expected } of cases) {
      for (const key of environmentKeys) delete process.env[key];
      Object.assign(process.env, env);
      expect(hostConversationId(env)).toBe(expected);
      expect(localClaim("cli", env).conversationId).toBe(expected);
      expect(localClaim("adapter", env).conversationId).toBe(expected);
      expect(new ConversationUsage().conversationId).toBe(expected);
    }
  } finally {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("an invalid explicit Orbit ID never falls through to another host conversation", () => {
  const saved = new Map(environmentKeys.map(key => [key, process.env[key]]));
  try {
    for (const invalid of ["", " ", "bad\0id", "\ud800"]) {
      for (const key of environmentKeys) delete process.env[key];
      const env = { ORBIT_CONVERSATION_ID: invalid, T3CODE_THREAD_ID: "valid-t3", CODEX_THREAD_ID: "valid-codex", HERMES_SESSION_ID: "valid-hermes" };
      Object.assign(process.env, env);
      expect(hostConversationId(env)).toBe(invalid);
      expect(localClaim("cli", env)).not.toHaveProperty("conversationId");
      expect(() => new ConversationUsage()).toThrow();
    }
  } finally {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("an unbound MCP adapter opens with the supplied actual conversation and retains it across reconnect", async () => {
  const state = await fixture();
  try {
    const first = await state.connect();
    expect((await open(first, "owned-a")).isError).not.toBe(true);
    const second = await state.connect();
    expect((await open(second, "owned-a")).isError).not.toBe(true);
    expect(state.requests).toHaveLength(2);
    for (const rpc of state.requests) {
      expect(rpc.claim.conversationId).toBe("owned-a");
      expect(rpc.claim.kind).toBe("adapter");
      expect(rpc.params).toEqual({ requestId: "same-opening", workspace: 7, applicationId: "org.example.OwnedFixture.desktop" });
    }
    for (const entry of (await first.listTools()).tools)
      expect(entry.inputSchema.properties).toHaveProperty("conversationId");
  } finally { await state.close(); }
});

test("missing MCP opening identity is refused before dispatch and correction reuses the request ID", async () => {
  const state = await fixture();
  try {
    const client = await state.connect();
    const params = { requestId: "corrected-opening", workspace: 7, applicationId: "org.example.OwnedFixture.desktop" };
    const refused = await tool(client, "orbit_open", params);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "CONVERSATION_REQUIRED",
      disposition: { delivery: "not-delivered", retry: "safe" }, suggestion: "correct-request" });
    expect(state.requests).toHaveLength(0);
    expect((await tool(client, "orbit_open", { ...params, conversationId: "owned-corrected" })).isError).not.toBe(true);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.params).toEqual(params);
    expect(state.requests[0]?.claim.conversationId).toBe("owned-corrected");
  } finally { await state.close(); }
});

test("actual CLI infers the T3 thread without Orbit environment identity and shares persistent off", async () => {
  const state = await fixture();
  try {
    const params = { requestId: "cli-host-opening", workspace: 7, applicationId: "org.example.OwnedFixture.desktop" };
    const opened = await state.cli("owned-cli-host", params);
    expect(opened.code).toBe(0);
    expect(opened.stderr).toBe("");
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.claim).toMatchObject({ kind: "cli", conversationId: "owned-cli-host" });
    expect(state.requests[0]?.params).toEqual(params);
    const client = await state.connect();
    expect((await tool(client, "orbit_usage", { conversationId: "owned-cli-host", mode: "off" })).isError).not.toBe(true);
    const blocked = await state.cli("owned-cli-host", { ...params, requestId: "blocked-cli-opening" });
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe("");
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: { code: "ORBIT_DISABLED" } });
    expect(state.requests).toHaveLength(1);
  } finally { await state.close(); }
});

test("overlapping calls on one MCP adapter retain independent conversation identities", async () => {
  const state = await fixture();
  const hold = { seen: deferred(), release: deferred() };
  state.holds.set("held-a", hold);
  let pending: ReturnType<typeof open> | undefined;
  try {
    const client = await state.connect();
    pending = open(client, "owned-a", "held-a");
    await hold.seen.promise;
    expect((await open(client, "owned-b", "free-b")).isError).not.toBe(true);
    hold.release.resolve();
    expect((await pending).isError).not.toBe(true);
    expect((await open(client, "owned-a", "again-a")).isError).not.toBe(true);
    expect(state.requests.map(rpc => [rpc.params.requestId, rpc.claim.conversationId])).toEqual([
      ["held-a", "owned-a"], ["free-b", "owned-b"], ["again-a", "owned-a"],
    ]);
  } finally { hold.release.resolve(); await pending; await state.close(); }
});

test("explicit conversation off persists across adapters without disabling a different conversation", async () => {
  const state = await fixture();
  try {
    const a = await state.connect(), b = await state.connect();
    expect((await tool(a, "orbit_usage", { mode: "off", conversationId: "owned-a" })).structuredContent)
      .toMatchObject({ enabled: false, scope: "conversation", conversationId: "owned-a" });
    expect((await open(b, "owned-a")).structuredContent).toMatchObject({ code: "ORBIT_DISABLED" });
    expect((await open(b, "owned-b")).isError).not.toBe(true);
    expect(state.requests.map(rpc => rpc.claim.conversationId)).toEqual(["owned-b"]);
    expect((await tool(b, "orbit_usage", { mode: "status", conversationId: "owned-a" })).structuredContent)
      .toMatchObject({ enabled: false, conversationId: "owned-a" });
    expect((await tool(b, "orbit_usage", { mode: "on", conversationId: "owned-a" })).isError).not.toBe(true);
    expect((await open(a, "owned-a")).isError).not.toBe(true);
  } finally { await state.close(); }
});

test("connection-local off cannot be bypassed by adding or enabling an explicit conversation", async () => {
  const state = await fixture();
  try {
    const client = await state.connect();
    expect((await tool(client, "orbit_usage", { mode: "off" })).structuredContent)
      .toMatchObject({ enabled: false, scope: "connection" });
    expect((await open(client, "owned-a")).structuredContent).toMatchObject({ code: "ORBIT_DISABLED" });
    await tool(client, "orbit_usage", { mode: "on", conversationId: "owned-a" });
    expect((await open(client, "owned-a")).structuredContent).toMatchObject({ code: "ORBIT_DISABLED" });
    expect(state.requests).toHaveLength(0);
    await tool(client, "orbit_usage", { mode: "on" });
    expect((await open(client, "owned-a")).isError).not.toBe(true);
  } finally { await state.close(); }
});

test("read delivery rechecks only its own conversation after overlapping off", async () => {
  const state = await fixture();
  const a = { seen: deferred(), release: deferred() }, b = { seen: deferred(), release: deferred() };
  state.holds.set("native.monitors:owned-a", a);
  state.holds.set("native.monitors:owned-b", b);
  const pending: ReturnType<typeof tool>[] = [];
  try {
    const client = await state.connect();
    const readA = tool(client, "orbit_monitors", { conversationId: "owned-a" }); pending.push(readA);
    const readB = tool(client, "orbit_monitors", { conversationId: "owned-b" }); pending.push(readB);
    await Promise.all([a.seen.promise, b.seen.promise]);
    await tool(client, "orbit_usage", { mode: "off", conversationId: "owned-a" });
    b.release.resolve();
    expect((await readB).structuredContent).toMatchObject({ caller: "owned-b" });
    a.release.resolve();
    const withheld = await readA;
    expect(withheld.isError).toBe(true);
    expect(withheld.structuredContent).toMatchObject({ code: "ORBIT_DISABLED" });
    expect(withheld.structuredContent).not.toHaveProperty("caller");
    expect(state.requests.map(rpc => rpc.claim.conversationId).sort()).toEqual(["owned-a", "owned-b"]);
  } finally {
    a.release.resolve(); b.release.resolve();
    await Promise.allSettled(pending);
    await state.close();
  }
});

test("a fixed environment conversation cannot be replaced by a tool argument", async () => {
  const state = await fixture();
  try {
    const client = await state.connect({ bound: "fixed-owner" });
    expect((await open(client, "different-owner")).isError).toBe(true);
    expect(state.requests).toHaveLength(0);
    expect((await tool(client, "orbit_open", { requestId: "fixed", workspace: 7,
      applicationId: "org.example.OwnedFixture.desktop" })).isError).not.toBe(true);
    expect(state.requests[0]?.claim.conversationId).toBe("fixed-owner");
  } finally { await state.close(); }
});

test("a conversation fixed only by ClientIdentity shares persisted off with other adapters", async () => {
  const state = await fixture();
  try {
    const owned = await state.connect({ identityConversation: "owned-identity" });
    const params = { requestId: "identity-opening", workspace: 7, applicationId: "org.example.OwnedFixture.desktop" };
    expect((await tool(owned, "orbit_open", params)).isError).not.toBe(true);
    expect(state.requests[0]?.claim.conversationId).toBe("owned-identity");
    const global = await state.connect();
    await tool(global, "orbit_usage", { conversationId: "owned-identity", mode: "off" });
    expect((await tool(owned, "orbit_usage", { mode: "status" })).structuredContent)
      .toMatchObject({ enabled: false, scope: "conversation", conversationId: "owned-identity" });
    expect((await tool(owned, "orbit_open", { ...params, requestId: "identity-off" })).structuredContent)
      .toMatchObject({ code: "ORBIT_DISABLED" });
    const reconnected = await state.connect({ identityConversation: "owned-identity" });
    expect((await tool(reconnected, "orbit_open", { ...params, requestId: "identity-reconnected-off" })).structuredContent)
      .toMatchObject({ code: "ORBIT_DISABLED" });
    expect(state.requests).toHaveLength(1);
  } finally { await state.close(); }
});

test("conflicting environment and ClientIdentity fixed conversations refuse adapter construction", async () => {
  const state = await fixture();
  try {
    await expect(state.connect({ bound: "environment-owner", identityConversation: "identity-owner" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(state.requests).toHaveLength(0);
    const matched = await state.connect({ bound: "same-owner", identityConversation: "same-owner" });
    expect((await open(matched, "same-owner")).isError).not.toBe(true);
    expect(state.requests[0]?.claim.conversationId).toBe("same-owner");
  } finally { await state.close(); }
});

test("session MCP tools use the request conversation while preserving their fixed session", async () => {
  const state = await fixture(), session = crypto.randomUUID();
  try {
    const client = await state.connect({ session });
    expect((await tool(client, "orbit_observe", { conversationId: "owned-a", mode: "metadata" })).isError).not.toBe(true);
    expect((await tool(client, "orbit_act", { conversationId: "owned-a", requestId: "state", action: {
      type: "state", appId: "a".repeat(32), windowId: "b".repeat(32),
    } })).isError).not.toBe(true);
    expect((await tool(client, "orbit_pause", { conversationId: "owned-a" })).isError).not.toBe(true);
    for (const rpc of state.requests) {
      expect(rpc.claim.conversationId).toBe("owned-a");
      expect(rpc.params.sessionId).toBe(session);
      expect(rpc.params).not.toHaveProperty("conversationId");
    }
    const global = await state.connect();
    await tool(global, "orbit_usage", { conversationId: "owned-a", mode: "off" });
    const before = state.requests.length;
    expect((await tool(client, "orbit_observe", { conversationId: "owned-a", mode: "metadata" })).structuredContent)
      .toMatchObject({ code: "ORBIT_DISABLED" });
    expect(state.requests).toHaveLength(before);
  } finally { await state.close(); }
});
