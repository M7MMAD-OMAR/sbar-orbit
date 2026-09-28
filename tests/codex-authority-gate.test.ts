import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { startCodexReadOnlyGate } from "../src/codex-authority-gate";

type Rpc = { id?: string | number; method?: string; params?: Record<string, unknown>;
  result?: Record<string, unknown>; error?: Record<string, unknown> };

class Probe {
  private buffer = Buffer.alloc(0);
  private ready = false;
  private messages: Rpc[] = [];
  private waiters: Array<(message: Rpc) => void> = [];
  readonly socket: Socket;
  readonly opened: Promise<void>;

  constructor(path: string) {
    this.socket = createConnection({ path });
    const key = randomBytes(16).toString("base64");
    this.opened = new Promise<void>((resolveOpen, rejectOpen) => {
      this.socket.once("connect", () => this.socket.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`));
      this.socket.once("error", rejectOpen);
      this.socket.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.ready) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const header = this.buffer.subarray(0, end).toString("ascii");
          if (!header.startsWith("HTTP/1.1 101")) return rejectOpen(new Error("WebSocket upgrade failed"));
          this.buffer = this.buffer.subarray(end + 4);
          this.ready = true;
          resolveOpen();
        }
        for (;;) {
          if (this.buffer.length < 2) return;
          const first = this.buffer[0];
          const second = this.buffer[1];
          if (first !== undefined && (first & 15) === 8) {
            const mask = randomBytes(4);
            this.socket.end(Buffer.concat([Buffer.from([0x88, 0x80]), mask]));
            return;
          }
          if (first === undefined || second === undefined || (first & 15) !== 1 || (second & 128) !== 0)
            return rejectOpen(new Error("Unexpected WebSocket response frame"));
          let size = second & 127;
          let header = 2;
          if (size === 126) {
            if (this.buffer.length < 4) return;
            size = this.buffer.readUInt16BE(2);
            header = 4;
          } else if (size === 127) {
            if (this.buffer.length < 10) return;
            size = Number(this.buffer.readBigUInt64BE(2));
            header = 10;
          }
          if (this.buffer.length < header + size) return;
          const message = JSON.parse(this.buffer.subarray(header, header + size).toString("utf8")) as Rpc;
          this.buffer = this.buffer.subarray(header + size);
          const waiter = this.waiters.shift();
          if (waiter) waiter(message);
          else this.messages.push(message);
        }
      });
    });
  }

  send(message: Rpc) { this.sendText(JSON.stringify(message)); }

  sendText(text: string) {
    const bytes = Buffer.from(text);
    const mask = randomBytes(4);
    const header = bytes.length < 126 ? Buffer.from([0x81, 0x80 | bytes.length])
      : bytes.length <= 65535 ? Buffer.from([0x81, 0xfe, bytes.length >> 8, bytes.length & 255])
        : Buffer.from([0x81, 0xff, 0, 0, 0, 0,
          (bytes.length / 0x1000000) & 255, (bytes.length >> 16) & 255,
          (bytes.length >> 8) & 255, bytes.length & 255]);
    const payload = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) payload[i] = (bytes[i] ?? 0) ^ (mask[i % 4] ?? 0);
    this.socket.write(Buffer.concat([header, mask, payload]));
  }

  next(): Promise<Rpc> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => rejectNext(new Error("No RPC response")), 3000);
      this.waiters.push(result => { clearTimeout(timer); resolveNext(result); });
    });
  }

  close() { this.socket.destroy(); }

  closed(label: string): Promise<void> {
    if (this.socket.destroyed) return Promise.resolve();
    return new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(() => rejectClose(new Error(`Gate did not close ${label} client`)), 3000);
      this.socket.once("close", () => { clearTimeout(timer); resolveClose(); });
    });
  }
}

async function stateRequest(path: string, method: string, params: Record<string, unknown> = {}) {
  const socket = createConnection({ path });
  socket.setEncoding("utf8");
  return await new Promise<Rpc>((resolveRequest, rejectRequest) => {
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); rejectRequest(new Error("No state response")); }, 3000);
    socket.once("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolveRequest(JSON.parse(buffer.slice(0, end)) as Rpc);
    });
    socket.once("error", error => { clearTimeout(timer); rejectRequest(error); });
  });
}

async function identity(path: string) {
  const info = await lstat(path, { bigint: true });
  return { device: String(info.dev), inode: String(info.ino) };
}

test("Codex gate blocks tokens, host commands and state writes while preserving read-only RPC", async () => {
  const root = await mkdtemp("/tmp/orbit-native-codex-gate-test-");
  const ownerPath = join(root, "owner.sock");
  const statePath = `${ownerPath}.state`;
  const fakeToken = "fixture-only-token";
  const fakeEmail = ["owner", "example.invalid"].join(String.fromCharCode(64));
  const reached: string[] = [];
  let ownerInitializeParams: Record<string, unknown> | undefined;
  let ownerThreadListParams: Record<string, unknown> | undefined;
  let ownerThreadReadParams: Record<string, unknown> | undefined;
  let stateWrites = 0;
  let requirementsResult: Record<string, unknown> = { requirements: null };
  let accountRouting: unknown = { chatgptAccountId: "fixture_selected",
    backendOrigin: "https://secret.fixture.invalid", accountRoutingOverride: "us" };
  const owner = Bun.serve({
    unix: ownerPath,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("WebSocket required", { status: 400 }); },
    websocket: {
      message(socket, text) {
        const message = JSON.parse(String(text)) as Rpc;
        reached.push(message.method ?? "unknown");
        if (message.method === "initialize") ownerInitializeParams = message.params;
        if (message.method === "thread/list") ownerThreadListParams = message.params;
        if (message.method === "thread/read") ownerThreadReadParams = message.params;
        if (message.id === undefined) return;
        let result: Record<string, unknown> = {};
        if (message.method === "getAuthStatus")
          result = { authMethod: "chatgpt", authToken: fakeToken };
        if (message.method === "account/read")
          result = { account: { type: "chatgpt", email: fakeEmail, planType: "plus",
            authToken: fakeToken }, requiresOpenaiAuth: true, workspaceRouting: accountRouting };
        if (message.method === "configRequirements/read") result = requirementsResult;
        if (message.method === "thread/list") result = { data: [{ id: "fixture-thread" }] };
        if (message.method === "thread/read") result = { thread: { id: "fixture-thread", turns: [] } };
        socket.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  const state = createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("data", data => {
      const message = JSON.parse(String(data).trim()) as Rpc;
      if (message.method === "write") stateWrites++;
      const result = message.method === "hello"
        ? { version: 1, ownerCodexHome: "/tmp/fixture/.codex", ownerIdentity: { dev: 1, ino: 2 } }
        : message.method === "snapshot" ? { "project-order": ["fixture-project"] } : "fixture";
      socket.write(JSON.stringify(message.method === "read"
        ? { id: message.id, error: "fixture-secret-error" } : { id: message.id, result }) + "\n");
    });
  });
  await new Promise<void>(resolveListen => state.listen(statePath, resolveListen));
  await chmod(ownerPath, 0o600);
  await chmod(statePath, 0o600);
  let gate: Awaited<ReturnType<typeof startCodexReadOnlyGate>> | undefined;
  let legacyGate: Awaited<ReturnType<typeof startCodexReadOnlyGate>> | undefined;
  const probes: Probe[] = [];
  try {
    const direct = new Probe(ownerPath);
    probes.push(direct);
    await direct.opened;
    direct.send({ id: 1, method: "getAuthStatus", params: { includeToken: true } });
    const baseline = await direct.next();
    expect(baseline.result?.authToken === fakeToken).toBe(true);
    direct.send({ id: 2, method: "command/exec", params: { command: "fixture" } });
    await direct.next();
    expect(reached).toContain("command/exec");
    direct.close();
    reached.length = 0;

    gate = await startCodexReadOnlyGate(root, ownerPath, statePath, {
      ownerIdentity: await identity(ownerPath), stateIdentity: await identity(statePath), maxMessageBytes: 1024,
    });
    const privateClient = new Probe(gate.socketPath);
    probes.push(privateClient);
    await privateClient.opened;
    privateClient.send({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture" },
      capabilities: {}, config: { command: "fixture-should-not-pass" } } });
    expect((await privateClient.next()).error).toBeUndefined();
    expect(ownerInitializeParams?.config).toBeUndefined();
    privateClient.send({ method: "initialized" });
    privateClient.send({ id: "requirements", method: "configRequirements/read" });
    expect((await privateClient.next()).result).toEqual({ requirements: {
      allowedLoginMethods: ["api", "chatgpt"], application: null,
    } });
    expect(reached).toContain("configRequirements/read");
    requirementsResult = { requirements: { allowedLoginMethods: ["chatgpt"], application: null } };
    privateClient.send({ id: "managed-requirements", method: "configRequirements/read" });
    expect((await privateClient.next()).result).toEqual({ requirements: {
      allowedLoginMethods: ["chatgpt"], application: null,
    } });
    requirementsResult = { requirements: { allowedLoginMethods: ["chatgpt"], application: null,
      modelProviders: { fixture: { env_key: "FIXTURE_ENV" } } } };
    privateClient.send({ id: "provider-requirements", method: "configRequirements/read" });
    expect((await privateClient.next()).error).toEqual({ code: -32000,
      message: "Codex owner requirements unavailable" });
    requirementsResult = { requirements: { allowedLoginMethods: [], application: null } };
    privateClient.send({ id: "no-login-methods", method: "configRequirements/read" });
    expect((await privateClient.next()).result).toEqual({ requirements: {
      allowedLoginMethods: [], application: null,
    } });
    requirementsResult = { requirements: { modelProvider: "fixture", application: null } };
    privateClient.send({ id: "missing-login-methods", method: "configRequirements/read" });
    expect((await privateClient.next()).error).toEqual({ code: -32000,
      message: "Codex owner requirements unavailable" });
    requirementsResult = { requirements: { allowedLoginMethods: ["unknown"], application: null } };
    privateClient.send({ id: "malformed-requirements", method: "configRequirements/read" });
    expect((await privateClient.next()).error).toEqual({ code: -32000,
      message: "Codex owner requirements unavailable" });
    requirementsResult = { requirements: { allowedLoginMethods: ["chatgpt"],
      application: { network: { enabled: true, domains: { "fixture.invalid": "allow" } } } } };
    privateClient.send({ id: "network-requirements", method: "configRequirements/read" });
    expect((await privateClient.next()).error).toEqual({ code: -32000,
      message: "Codex owner requirements unavailable" });
    const reachedBeforeConfigRead = reached.length;
    privateClient.send({ id: "raw-config", method: "config/read", params: { includeLayers: true } });
    expect((await privateClient.next()).error).toBeDefined();
    expect(reached.length).toBe(reachedBeforeConfigRead);
    privateClient.send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: true } });
    const auth = await privateClient.next();
    expect(auth.result).toEqual({ authMethod: "chatgpt" });
    expect(JSON.stringify(auth).includes(fakeToken)).toBe(false);
    privateClient.send({ id: 3, method: "account/read", params: { refreshToken: true } });
    const account = await privateClient.next();
    expect(account.result?.account).toEqual({ type: "chatgpt", email: fakeEmail, planType: "plus" });
    expect(account.result?.workspaceRouting).toEqual({ chatgptAccountId: "fixture_selected" });
    expect(JSON.stringify(account).includes(fakeToken)).toBe(false);
    expect(JSON.stringify(account).includes("secret.fixture.invalid")).toBe(false);
    expect(JSON.stringify(account).includes("accountRoutingOverride")).toBe(false);
    accountRouting = { chatgptAccountId: "bad/owner", backendOrigin: "https://secret.fixture.invalid" };
    privateClient.send({ id: "invalid-account-id", method: "account/read" });
    expect((await privateClient.next()).result?.workspaceRouting).toBeNull();
    accountRouting = { chatgptAccountId: "x".repeat(129) };
    privateClient.send({ id: "oversized-account-id", method: "account/read" });
    expect((await privateClient.next()).result?.workspaceRouting).toBeNull();
    accountRouting = null;
    privateClient.send({ id: "missing-account-id", method: "account/read" });
    expect((await privateClient.next()).result?.workspaceRouting).toBeNull();
    privateClient.send({ id: 4, method: "thread/list", params: {
      limit: 100, cursor: null, modelProviders: [], sectionId: "550e8400-e29b-41d4-a716-446655440000",
      sortKey: "updated_at", useStateDbOnly: false,
    } });
    expect((await privateClient.next()).result?.data).toEqual([{ id: "fixture-thread" }]);
    expect(ownerThreadListParams?.useStateDbOnly).toBe(true);
    expect(ownerThreadListParams?.sectionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    privateClient.send({ id: "parent-list", method: "thread/list", params: {
      archived: false, cursor: null, limit: 100, modelProviders: [], parentThreadId: null,
      sortKey: "updated_at", sortDirection: "desc", sourceKinds: [], useStateDbOnly: false,
    } });
    expect((await privateClient.next()).result?.data).toEqual([{ id: "fixture-thread" }]);
    expect(ownerThreadListParams?.useStateDbOnly).toBe(true);
    privateClient.send({ id: 5, method: "thread/read", params: { threadId: "fixture-thread", includeTurns: true } });
    expect((await privateClient.next()).error?.code).toBe(-32601);
    expect(reached).not.toContain("thread/read");
    for (const method of ["command/exec", "thread/shellCommand", "thread/start", "project/import",
      "plugin/install", "unknown/action"])
      privateClient.send({ id: method, method, params: {} });
    for (let i = 0; i < 6; i++) expect((await privateClient.next()).error?.code).toBe(-32601);
    expect(reached).toContain("initialized");
    expect(reached).not.toContain("command/exec");
    expect(reached).not.toContain("thread/start");
    expect(reached).not.toContain("thread/shellCommand");
    expect(reached).not.toContain("project/import");
    expect((await stateRequest(gate.stateSocketPath, "write", { key: "project-order", value: [] })).error?.code)
      .toBe(-32601);
    expect(stateWrites).toBe(0);
    expect((await stateRequest(gate.stateSocketPath, "hello")).result?.version).toBe(1);
    expect((await stateRequest(gate.stateSocketPath, "snapshot")).result?.["project-order"])
      .toEqual(["fixture-project"]);
    const stateError: unknown = (await stateRequest(gate.stateSocketPath, "read", { key: "local-projects" })).error;
    expect(stateError).toBe("Codex owner state request failed");

    const malformed = new Probe(gate.socketPath);
    probes.push(malformed);
    await malformed.opened;
    malformed.sendText("{");
    await malformed.closed("malformed");
    const oversized = new Probe(gate.socketPath);
    probes.push(oversized);
    await oversized.opened;
    oversized.sendText("x".repeat(1025));
    await oversized.closed("oversized");
    expect(reached).not.toContain("unknown");

    legacyGate = await startCodexReadOnlyGate(root, ownerPath, statePath, {
      ownerIdentity: await identity(ownerPath), stateIdentity: await identity(statePath),
      allowLegacyThreadRead: true,
    });
    const legacyClient = new Probe(legacyGate.socketPath);
    probes.push(legacyClient);
    await legacyClient.opened;
    const threadId = "550e8400-e29b-41d4-a716-446655440000";
    const invalidReads = [
      { threadId, includeTurns: true },
      { threadId, includeTurns: true, readOnly: false },
      { threadId, includeTurns: true, readOnly: true, mutation: true },
      { threadId: "fixture-thread", includeTurns: true, readOnly: true },
    ];
    const reachedBeforeInvalidReads = reached.length;
    for (const [index, params] of invalidReads.entries()) {
      legacyClient.send({ id: `invalid-read-${index}`, method: "thread/read", params });
      expect((await legacyClient.next()).error?.code).toBe(-32601);
    }
    expect(reached.length).toBe(reachedBeforeInvalidReads);
    legacyClient.send({ id: "legacy-read", method: "thread/read",
      params: { threadId, includeTurns: true, readOnly: true } });
    expect((await legacyClient.next()).result?.thread).toEqual({ id: "fixture-thread", turns: [] });
    expect(ownerThreadReadParams).toEqual({ threadId, includeTurns: true, readOnly: true });
    legacyClient.send({ id: "legacy-metadata", method: "thread/read",
      params: { threadId, includeTurns: false, readOnly: true } });
    expect((await legacyClient.next()).result?.thread).toEqual({ id: "fixture-thread", turns: [] });
    expect(ownerThreadReadParams).toEqual({ threadId, includeTurns: false, readOnly: true });
    legacyClient.send({ id: "legacy-turn", method: "turn/start", params: { threadId, input: [] } });
    expect((await legacyClient.next()).error?.code).toBe(-32601);
  } finally {
    for (const probe of probes) probe.close();
    await legacyGate?.close();
    await gate?.close();
    owner.stop(true);
    await new Promise<void>(resolveClose => state.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("Codex gate rejects owner socket replacement after preparation", async () => {
  const root = await mkdtemp("/tmp/orbit-native-codex-gate-identity-");
  const ownerPath = join(root, "owner.sock");
  const statePath = `${ownerPath}.state`;
  let replacementCalls = 0;
  let owner = Bun.serve({
    unix: ownerPath,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("Unavailable", { status: 400 }); },
    websocket: { message() {} },
  });
  let state = createServer(socket => socket.on("data", () => { replacementCalls++; }));
  await new Promise<void>(resolveListen => state.listen(statePath, resolveListen));
  await chmod(ownerPath, 0o600);
  await chmod(statePath, 0o600);
  const ownerIdentity = await identity(ownerPath);
  const stateIdentity = await identity(statePath);
  let gate: Awaited<ReturnType<typeof startCodexReadOnlyGate>> | undefined;
  try {
    gate = await startCodexReadOnlyGate(root, ownerPath, statePath, { ownerIdentity, stateIdentity });
    owner.stop(true);
    owner = Bun.serve({
      unix: ownerPath,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response("Unavailable", { status: 400 }); },
      websocket: { message() { replacementCalls++; } },
    });
    await chmod(ownerPath, 0o600);
    expect(await identity(ownerPath)).not.toEqual(ownerIdentity);
    const probe = new Probe(gate.socketPath);
    try { await probe.closed("replaced owner"); }
    finally { probe.close(); }
    expect(replacementCalls).toBe(0);

    await new Promise<void>(resolveClose => state.close(() => resolveClose()));
    await rm(statePath, { force: true });
    await writeFile(statePath, "reserved", { flag: "wx" });
    await rename(statePath, join(root, "reserved-inode"));
    state = createServer(socket => socket.on("data", () => {
      replacementCalls++;
      socket.write('{"id":1,"result":"replacement"}\n');
    }));
    await new Promise<void>(resolveListen => state.listen(statePath, resolveListen));
    await chmod(statePath, 0o600);
    expect(await identity(statePath)).not.toEqual(stateIdentity);
    const client = createConnection({ path: gate.stateSocketPath });
    let response = "";
    await new Promise<void>((resolveClose, rejectClose) => {
      const timer = setTimeout(() => rejectClose(new Error("State gate did not reject replacement")), 3000);
      client.once("connect", () => client.write('{"id":1,"method":"hello"}\n'));
      client.once("data", chunk => { response += chunk.toString(); client.destroy(); });
      client.once("end", () => { clearTimeout(timer); client.destroy(); resolveClose(); });
      client.once("close", () => { clearTimeout(timer); resolveClose(); });
      client.once("error", () => {});
    });
    expect(replacementCalls).toBe(0);
    expect(response).toBe("");
  } finally {
    await gate?.close();
    owner.stop(true);
    await new Promise<void>(resolveClose => state.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
