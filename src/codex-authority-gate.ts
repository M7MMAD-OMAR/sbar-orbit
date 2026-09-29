import { randomBytes, createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { lstatSync } from "node:fs";
import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_PAGE_RESPONSE = 4 * 1024 * 1024;
const MAX_ACTIVE_PAGE_READERS = 4;
const MAX_HEADER = 8192;
const SIDEBAR_KEYS = new Set([
  "local-projects", "project-order", "project-appearances", "pinned-thread-ids",
  "pinned-project-ids", "sidebar-project-thread-orders", "sidebar-thread-metadata",
  "thread-project-assignments", "projectless-thread-ids",
]);
const READ_METHODS = new Set(["initialize", "account/read", "getAuthStatus", "configRequirements/read",
  "thread/list"]);
const THREAD_LIST_FIELDS = new Set(["limit", "cursor", "sortKey", "sortDirection", "modelProviders",
  "sourceKinds", "archived", "originators", "parentThreadId", "ancestorThreadId", "sectionId",
  "useStateDbOnly"]);

type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type PendingRequest = { method: string; key?: string };
export type GateSocketIdentity = { device: string; inode: string };
export type GateFieldShape = { key: string; kind: string; length?: number };
export type PaginatedPageRequest = {
  method: "thread/turns/list" | "thread/items/list";
  params: {
    threadId: string;
    readOnly: true;
    limit: number;
    cursor?: string | null;
    sortDirection?: "asc" | "desc";
    itemsView?: "summary" | "full";
    turnId?: string | null;
  };
};

function assertSocketIdentity(path: string, identity: GateSocketIdentity) {
  if (!/^\d+$/u.test(identity.device) || !/^\d+$/u.test(identity.inode))
    throw new Error("Invalid Codex owner socket identity");
  const info = lstatSync(path, { bigint: true });
  if (!info.isSocket() || info.isSymbolicLink() || info.dev !== BigInt(identity.device) ||
      info.ino !== BigInt(identity.inode) || info.uid !== BigInt(process.getuid?.() ?? -1) ||
      (info.mode & 0o077n) !== 0n || info.nlink !== 1n)
    throw new Error("Codex owner socket identity changed");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseMessage(text: string): RpcMessage {
  if (Buffer.byteLength(text) > MAX_MESSAGE) throw new Error("Codex gate message is too large");
  const value: unknown = JSON.parse(text);
  const parsed = record(value);
  if (!parsed) throw new Error("Codex gate message is not an object");
  return parsed as RpcMessage;
}

function requestId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 ? `s:${value}`
    : typeof value === "number" && Number.isSafeInteger(value) ? `n:${value}` : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_FIXTURE_TURN_TEXT_BYTES = 8192;
const PAGE_TURN_KEYS = new Set(["threadId", "readOnly", "cursor", "limit", "sortDirection", "itemsView"]);
const PAGE_ITEM_KEYS = new Set(["threadId", "readOnly", "turnId", "cursor", "limit", "sortDirection"]);

function safePaginatedPageRequest(message: RpcMessage): PaginatedPageRequest | null {
  const method = message.method;
  if (method !== "thread/turns/list" && method !== "thread/items/list") return null;
  if (requestId(message.id) === null ||
      Object.keys(message).some(key => key !== "id" && key !== "method" && key !== "params")) return null;
  const input = record(message.params);
  if (!input || Object.keys(input).some(key =>
    !(method === "thread/turns/list" ? PAGE_TURN_KEYS : PAGE_ITEM_KEYS).has(key)) ||
      typeof input.threadId !== "string" || !UUID.test(input.threadId) || input.readOnly !== true ||
      !Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 50) return null;
  if ("cursor" in input && input.cursor !== null &&
      (typeof input.cursor !== "string" || input.cursor.length < 1 || input.cursor.length > 4096 ||
       !/^[\x20-\x7e]+$/u.test(input.cursor))) return null;
  if ("sortDirection" in input && input.sortDirection !== "asc" && input.sortDirection !== "desc") return null;
  if ("itemsView" in input && input.itemsView !== "summary" && input.itemsView !== "full") return null;
  if ("turnId" in input && input.turnId !== null &&
      (typeof input.turnId !== "string" || !UUID.test(input.turnId))) return null;
  const params: PaginatedPageRequest["params"] = {
    threadId: input.threadId, readOnly: true, limit: input.limit as number,
  };
  if ("cursor" in input) params.cursor = input.cursor as string | null;
  if ("sortDirection" in input) params.sortDirection = input.sortDirection as "asc" | "desc";
  if ("itemsView" in input) params.itemsView = input.itemsView as "summary" | "full";
  if ("turnId" in input) params.turnId = input.turnId as string | null;
  return Object.freeze({ method, params: Object.freeze(params) });
}

function safeFixtureTurnStartRequest(message: RpcMessage, threadId: string | undefined): RpcMessage | null {
  if (!threadId || !UUID.test(threadId) || message.method !== "turn/start" ||
      requestId(message.id) === null ||
      Object.keys(message).some(key => key !== "id" && key !== "method" && key !== "params")) return null;
  const params = record(message.params);
  if (!params || Object.keys(params).length !== 2 ||
      !Object.hasOwn(params, "threadId") || !Object.hasOwn(params, "input") ||
      params.threadId !== threadId || !Array.isArray(params.input) || params.input.length !== 1) return null;
  const item = record(params.input[0]);
  if (!item || Object.keys(item).length !== 2 || item.type !== "text" ||
      typeof item.text !== "string" || item.text.length === 0 ||
      Buffer.byteLength(item.text) > MAX_FIXTURE_TURN_TEXT_BYTES || item.text.includes("\0")) return null;
  return { id: message.id, method: "turn/start", params: {
    threadId, input: [{ type: "text", text: item.text }], allowedTools: [],
  } };
}

function safeFixtureTurnStartResponse(message: RpcMessage): RpcMessage {
  if (message.error !== undefined)
    return { id: message.id, error: { code: -32000, message: "Codex fixture turn failed" } };
  const result = record(message.result);
  const turn = record(result?.turn);
  if (typeof turn?.id !== "string" || !UUID.test(turn.id) ||
      (turn.status !== "inProgress" && turn.status !== "completed" &&
       turn.status !== "interrupted" && turn.status !== "failed"))
    return { id: message.id, error: { code: -32000, message: "Codex fixture turn unavailable" } };
  return { id: message.id, result: { turn: { id: turn.id, status: turn.status,
    items: [], error: null } } };
}

function safePaginatedPageResponse(id: string | number, result: unknown,
                                   limit: number, maxMessageBytes: number): string | null {
  const serializedResult = JSON.stringify(result);
  if (typeof serializedResult !== "string" ||
      Buffer.byteLength(serializedResult) > Math.min(maxMessageBytes, MAX_PAGE_RESPONSE)) return null;
  const value = record(JSON.parse(serializedResult));
  if (!value || Object.keys(value).some(key =>
    key !== "data" && key !== "nextCursor" && key !== "backwardsCursor") ||
      !Array.isArray(value.data) || value.data.length > limit ||
      !value.data.every(item => record(item) !== null)) return null;
  for (const key of ["nextCursor", "backwardsCursor"] as const) {
    const cursor = value[key];
    if (cursor !== undefined && cursor !== null &&
        (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 4096 ||
         !/^[\x20-\x7e]+$/u.test(cursor))) return null;
  }
  const serialized = JSON.stringify({ id, result: value });
  if (Buffer.byteLength(serialized) > Math.min(maxMessageBytes, MAX_PAGE_RESPONSE) ||
      containsCredentialField(value)) return null;
  return serialized;
}

function sanitizedAuthStatus(result: unknown) {
  const value = record(result);
  const authMethod = value?.authMethod;
  return { authMethod: typeof authMethod === "string" && authMethod.length <= 64 ? authMethod : null };
}

function sanitizedAccount(result: unknown) {
  const value = record(result);
  const account = record(value?.account);
  const type = account?.type;
  const email = account?.email;
  const planType = account?.planType;
  const routing = type === "chatgpt" ? record(value?.workspaceRouting) : null;
  const accountId = routing?.chatgptAccountId;
  return {
    account: type === "chatgpt" || type === "apiKey" || type === "amazonBedrock"
      ? { type, ...(type === "chatgpt" ? {
        email: typeof email === "string" && email.length <= 320 ? email : null,
        planType: typeof planType === "string" && planType.length <= 64 ? planType : null,
      } : {}) } : null,
    requiresOpenaiAuth: value?.requiresOpenaiAuth === false ? false : true,
    workspaceRouting: typeof accountId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(accountId)
      ? { chatgptAccountId: accountId } : null,
  };
}

function sanitizedConfigRequirements(result: unknown) {
  const value = record(result);
  if (!value || Object.keys(value).length !== 1 || !("requirements" in value)) return null;
  if (value.requirements === null)
    return { requirements: { allowedLoginMethods: ["api", "chatgpt"], application: null } };
  const requirements = record(value.requirements);
  if (!requirements || requirements.application !== null ||
      !Array.isArray(requirements.allowedLoginMethods) ||
      requirements.allowedLoginMethods.length > 2) return null;
  if (Object.entries(requirements).some(([key, item]) =>
    key !== "allowedLoginMethods" && key !== "application" && item !== null)) return null;
  const allowedLoginMethods: Array<"api" | "chatgpt"> = [];
  for (const method of requirements.allowedLoginMethods) {
    if ((method !== "api" && method !== "chatgpt") || allowedLoginMethods.includes(method)) return null;
    allowedLoginMethods.push(method);
  }
  return { requirements: { allowedLoginMethods, application: null } };
}

function safeAppRequest(message: RpcMessage, allowLegacyThreadRead = false,
                        allowThreadMetadataRead = false): RpcMessage | null {
  if (requestId(message.id) === null || typeof message.method !== "string" ||
      (!READ_METHODS.has(message.method) &&
       !((allowLegacyThreadRead || allowThreadMetadataRead) && message.method === "thread/read"))) return null;
  const params = record(message.params);
  if (message.method === "thread/read") {
    if (!params || Object.keys(params).length !== 3 ||
        typeof params.threadId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(params.threadId) ||
        typeof params.includeTurns !== "boolean" || params.readOnly !== true ||
        (!allowLegacyThreadRead && params.includeTurns !== false)) return null;
    return { id: message.id, method: message.method,
      params: { threadId: params.threadId, includeTurns: params.includeTurns, readOnly: true } };
  }
  if (message.method === "initialize") {
    if (!params || !record(params.clientInfo) || !record(params.capabilities)) return null;
    return { id: message.id, method: message.method,
      params: { clientInfo: { name: "orbit_private_readonly", title: "Orbit private Codex", version: "1" },
        capabilities: { experimentalApi: true } } };
  }
  if (message.method === "getAuthStatus")
    return { id: message.id, method: message.method, params: { includeToken: false, refreshToken: false } };
  if (message.method === "account/read")
    return { id: message.id, method: message.method, params: { refreshToken: false } };
  if (message.method === "configRequirements/read") {
    if (message.params !== undefined && (!params || Object.keys(params).length !== 0)) return null;
    return { id: message.id, method: message.method, params: {} };
  }
  if (message.method === "thread/list") {
    if (message.params !== undefined && !params) return null;
    const input = params ?? {};
    if (Object.keys(input).some(key => !THREAD_LIST_FIELDS.has(key))) return null;
    const output: Record<string, unknown> = { useStateDbOnly: true };
    for (const [key, value] of Object.entries(input)) {
      if (key === "useStateDbOnly") { if (typeof value !== "boolean") return null; continue; }
      if (key === "limit") {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 200) return null;
      } else if (key === "archived") {
        if (typeof value !== "boolean") return null;
      } else if (key === "cursor") {
        if (value !== null && (typeof value !== "string" || value.length > 4096 ||
            !/^[\x20-\x7e]*$/u.test(value))) return null;
      } else if (key === "sortKey" || key === "sortDirection") {
        if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) return null;
      } else if (key === "parentThreadId" || key === "ancestorThreadId") {
        if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)))
          return null;
      } else if (key === "sectionId") {
        if (typeof value !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return null;
      } else if (key === "modelProviders" || key === "sourceKinds" || key === "originators") {
        if (value !== null && (!Array.isArray(value) || value.length > 32 ||
            !value.every(item => typeof item === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(item))))
          return null;
      }
      output[key] = value;
    }
    return { id: message.id, method: message.method, params: output };
  }
  if (message.params !== undefined && !params) return null;
  return { id: message.id, method: message.method, params: params ?? {} };
}

function appResponse(message: RpcMessage, method: string): RpcMessage {
  if (method === "turn/start") return safeFixtureTurnStartResponse(message);
  if (message.error !== undefined)
    return { id: message.id, error: { code: -32000, message: "Codex owner request failed" } };
  if (method === "getAuthStatus")
    return { id: message.id, result: sanitizedAuthStatus(message.result) };
  if (method === "account/read")
    return { id: message.id, result: sanitizedAccount(message.result) };
  if (method === "configRequirements/read") {
    const requirements = sanitizedConfigRequirements(message.result);
    return requirements ? { id: message.id, result: requirements }
      : { id: message.id, error: { code: -32000, message: "Codex owner requirements unavailable" } };
  }
  return { id: message.id, result: message.result };
}

function containsCredentialField(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some(item => containsCredentialField(item, depth + 1));
  const object = record(value);
  if (!object) return false;
  return Object.entries(object).some(([key, item]) =>
    /^(?:token|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|authorization|api[_-]?key|password|secret|client[_-]?secret|cookie|credential|credentials|private[_-]?key|session[_-]?(?:key|token))$/iu.test(key) ||
    containsCredentialField(item, depth + 1));
}

function denied(id: string | number | undefined): RpcMessage {
  return { id, error: { code: -32601, message: "Codex private client is read only" } };
}

class OwnerWebSocket {
  readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private open = false;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private handshakeKey: string;
  private timer!: ReturnType<typeof setTimeout>;
  private settled = false;
  readonly ready: Promise<void>;

  constructor(private readonly path: string, private readonly identity: GateSocketIdentity,
              private readonly onMessage: (text: string) => void,
              private readonly onClose: () => void) {
    assertSocketIdentity(this.path, identity);
    this.handshakeKey = randomBytes(16).toString("base64");
    this.socket = createConnection({ path: this.path });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const fail = (error: Error) => {
        if (!this.settled) { this.settled = true; rejectReady(error); }
        this.socket.destroy();
      };
      this.timer = setTimeout(() => fail(new Error("Codex owner WebSocket timed out")), 5000);
      this.socket.once("connect", () => {
        try {
          assertSocketIdentity(this.path, identity);
          this.socket.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${this.handshakeKey}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      this.socket.on("data", chunk => {
        try {
          if (this.buffer.length + chunk.length > MAX_MESSAGE + MAX_HEADER)
            throw new Error("Codex owner WebSocket data is too large");
          this.buffer = Buffer.concat([this.buffer, chunk]);
          if (!this.open) {
            const end = this.buffer.indexOf("\r\n\r\n");
            if (end < 0) {
              if (this.buffer.length > MAX_HEADER) throw new Error("Codex owner handshake too large");
              return;
            }
            if (end > MAX_HEADER) throw new Error("Codex owner handshake too large");
            const headers = this.buffer.subarray(0, end).toString("latin1");
            const expected = createHash("sha1").update(this.handshakeKey +
              "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            if (!/^HTTP\/1\.1 101 /u.test(headers) ||
                !headers.toLowerCase().includes("upgrade: websocket") ||
                !headers.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`) ||
                /sec-websocket-extensions:/iu.test(headers))
              throw new Error("Codex owner WebSocket handshake is invalid");
            this.buffer = this.buffer.subarray(end + 4);
            this.open = true;
            clearTimeout(this.timer);
            if (!this.settled) { this.settled = true; resolveReady(); }
          }
          this.consumeFrames();
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      this.socket.once("error", error => fail(error));
      this.socket.once("close", () => {
        clearTimeout(this.timer);
        if (!this.settled) { this.settled = true; rejectReady(new Error("Codex owner disconnected")); }
        this.onClose();
      });
    });
  }

  private consumeFrames() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      if (first === undefined || second === undefined || (first & 0x70) !== 0 || (second & 0x80) !== 0)
        throw new Error("Invalid Codex owner WebSocket frame");
      const opcode = first & 15;
      const fin = (first & 0x80) !== 0;
      let header = 2;
      let length = second & 127;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        header = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(MAX_MESSAGE)) throw new Error("Codex owner WebSocket frame is too large");
        length = Number(large);
        header = 10;
      }
      if (length > MAX_MESSAGE || this.fragmentBytes + length > MAX_MESSAGE)
        throw new Error("Codex owner WebSocket message is too large");
      if (this.buffer.length < header + length) return;
      const payload = this.buffer.subarray(header, header + length);
      this.buffer = this.buffer.subarray(header + length);
      if (opcode === 8) { this.socket.destroy(); return; }
      if (opcode === 9) { if (!fin || length > 125) throw new Error("Invalid Codex owner ping"); this.frame(10, payload); continue; }
      if (opcode === 10) { if (!fin || length > 125) throw new Error("Invalid Codex owner pong"); continue; }
      if (opcode !== 0 && opcode !== 1) throw new Error("Codex owner sent unsupported WebSocket data");
      if (opcode === 1 && this.fragments.length) throw new Error("Codex owner WebSocket fragments overlap");
      if (opcode === 0 && !this.fragments.length) throw new Error("Codex owner WebSocket continuation is unexpected");
      this.fragments.push(payload);
      this.fragmentBytes += length;
      if (fin) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.fragments));
        this.fragments = [];
        this.fragmentBytes = 0;
        assertSocketIdentity(this.path, this.identity);
        this.onMessage(text);
      }
    }
  }

  private frame(opcode: number, payload: Buffer) {
    if (!this.open || this.socket.destroyed || payload.length > MAX_MESSAGE) throw new Error("Codex owner is unavailable");
    const mask = randomBytes(4);
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length <= 65535 ? Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255])
      : Buffer.from([0x80 | opcode, 0x80 | 127, 0, 0, 0, 0,
        (payload.length / 0x1000000) & 255, (payload.length >> 16) & 255,
        (payload.length >> 8) & 255, payload.length & 255]);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index++) masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text: string) {
    assertSocketIdentity(this.path, this.identity);
    this.frame(1, Buffer.from(text, "utf8"));
  }
  close() { this.socket.destroy(); }
}

type ClientData = { owner?: OwnerWebSocket; queue: string[]; pending: Map<string, PendingRequest>;
  pages: Set<string> };

export async function startCodexReadOnlyGate(session: string, ownerSocketPath: string, ownerStatePath: string,
                                             options: { ownerIdentity: GateSocketIdentity;
                                               stateIdentity: GateSocketIdentity;
                                               maxMessageBytes?: number;
                                               allowLegacyThreadRead?: boolean;
                                               allowThreadMetadataRead?: boolean;
                                               allowPaginatedThreadPages?: boolean;
                                               readPaginatedThreadPage?: (request: PaginatedPageRequest) => Promise<unknown>;
                                               fixtureTurnThreadId?: string;
                                               auditMethod?: (method: string, outcome: "allow" | "deny") => void;
                                               auditThreadListShape?: (fields: GateFieldShape[]) => void }) {
  const maxMessageBytes = options.maxMessageBytes === undefined ? MAX_MESSAGE
    : Number.isSafeInteger(options.maxMessageBytes) && options.maxMessageBytes >= 1024 &&
      options.maxMessageBytes <= MAX_MESSAGE ? options.maxMessageBytes : 0;
  if (maxMessageBytes === 0) throw new Error("Invalid Codex gate message limit");
  if (options.fixtureTurnThreadId !== undefined && !UUID.test(options.fixtureTurnThreadId))
    throw new Error("Invalid Codex fixture thread ID");
  const suffix = randomBytes(5).toString("hex");
  const socketPath = join(session, `codex-gate-${suffix}.sock`);
  const stateSocketPath = `${socketPath}.state`;
  const clients = new Set<ServerWebSocket<ClientData>>();
  const stateClients = new Set<Socket>();
  let activePageReaders = 0;
  let server: ReturnType<typeof Bun.serve<ClientData>> | undefined;
  let stateServer: ReturnType<typeof createServer> | undefined;
  try {
    assertSocketIdentity(ownerSocketPath, options.ownerIdentity);
    assertSocketIdentity(ownerStatePath, options.stateIdentity);
    server = Bun.serve<ClientData>({
      unix: socketPath,
      fetch(request, instance) {
        if (new URL(request.url).pathname !== "/rpc") return new Response("Not found", { status: 404 });
        if (instance.upgrade(request, { data: { queue: [], pending: new Map(), pages: new Set() } })) return undefined;
        return new Response("WebSocket required", { status: 400 });
      },
      websocket: {
        maxPayloadLength: maxMessageBytes,
        open(client) {
          clients.add(client);
          const data = client.data;
          let owner: OwnerWebSocket;
          try { owner = new OwnerWebSocket(ownerSocketPath, options.ownerIdentity, text => {
            try {
              const message = parseMessage(text);
              const id = requestId(message.id);
              if (id === null || message.method !== undefined) return;
              const pending = data.pending.get(id);
              if (!pending) return;
              data.pending.delete(id);
              if (pending.method !== "account/read" && pending.method !== "getAuthStatus" &&
                  containsCredentialField(message.result))
                throw new Error("Codex owner returned credential fields");
              client.send(JSON.stringify(appResponse(message, pending.method)));
            } catch { client.terminate(); }
          }, () => client.terminate()); }
          catch { client.terminate(); return; }
          data.owner = owner;
          void owner.ready.then(() => {
            for (const message of data.queue) owner.send(message);
            data.queue = [];
          }).catch(() => client.terminate());
        },
        message(client, input) {
          try {
            if (typeof input !== "string") throw new Error("Binary Codex RPC is unavailable");
            const request = parseMessage(input);
            const id = requestId(request.id);
            if (id === null && request.id === undefined && request.method === "initialized" &&
                (request.params === undefined || Object.keys(record(request.params) ?? {}).length === 0)) {
              options.auditMethod?.("initialized", "allow");
              const serialized = JSON.stringify({ method: "initialized", params: {} });
              if (client.data.owner && client.data.queue.length === 0) {
                try { client.data.owner.send(serialized); }
                catch { client.data.queue.push(serialized); }
              } else {
                if (client.data.queue.length >= 8) throw new Error("Codex gate request queue is full");
                client.data.queue.push(serialized);
              }
              return;
            }
            if (id === null) throw new Error("Codex RPC needs an id");
            const page = options.allowPaginatedThreadPages === true && options.readPaginatedThreadPage
              ? safePaginatedPageRequest(request) : null;
            const safe = page ? null : safeAppRequest(request, options.allowLegacyThreadRead === true,
              options.allowThreadMetadataRead === true);
            const fixtureTurn = !page && !safe
              ? safeFixtureTurnStartRequest(request, options.fixtureTurnThreadId) : null;
            const methodName = typeof request.method === "string" &&
              /^[A-Za-z0-9/_-]{1,80}$/u.test(request.method) ? request.method : "invalid";
            options.auditMethod?.(methodName, safe || page || fixtureTurn ? "allow" : "deny");
            if (methodName === "thread/list" && options.auditThreadListShape) {
              const fields = Object.entries(record(request.params) ?? {}).slice(0, 32).map(([key, value]) => ({
                key: /^[A-Za-z0-9_]{1,64}$/u.test(key) ? key : "invalid",
                kind: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
                ...(typeof value === "string" || Array.isArray(value) ? { length: value.length } : {}),
              }));
              options.auditThreadListShape(fields);
            }
            if (!safe && !page && !fixtureTurn) { client.send(JSON.stringify(denied(request.id))); return; }
            if (client.data.pending.size + client.data.pages.size >= 64)
              throw new Error("Too many Codex gate requests");
            if (client.data.pending.has(id) || client.data.pages.has(id))
              throw new Error("Duplicate Codex RPC id");
            if (page) {
              const reader = options.readPaginatedThreadPage;
              if (!reader) throw new Error("Codex page reader is unavailable");
              if (activePageReaders >= MAX_ACTIVE_PAGE_READERS) {
                client.send(JSON.stringify({ id: request.id,
                  error: { code: -32000, message: "Codex page unavailable" } }));
                return;
              }
              client.data.pages.add(id);
              activePageReaders++;
              const work = Promise.resolve().then(() => reader(page));
              void work.then(() => { activePageReaders--; }, () => { activePageReaders--; });
              void (async () => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const result = await Promise.race([
                    work,
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error("Codex page reader timed out")), 5000);
                    }),
                  ]);
                  const response = safePaginatedPageResponse(request.id as string | number, result,
                    page.params.limit, maxMessageBytes);
                  client.send(response ?? JSON.stringify({ id: request.id,
                    error: { code: -32000, message: "Codex page unavailable" } }));
                } catch {
                  try { client.send(JSON.stringify({ id: request.id,
                    error: { code: -32000, message: "Codex page unavailable" } })); }
                  catch { client.terminate(); }
                } finally {
                  if (timer) clearTimeout(timer);
                  client.data.pages.delete(id);
                }
              })();
              return;
            }
            const forwarded = safe ?? fixtureTurn;
            if (!forwarded) throw new Error("Codex request is unavailable");
            client.data.pending.set(id, { method: forwarded.method ?? "" });
            const serialized = JSON.stringify(forwarded);
            if (client.data.owner && client.data.queue.length === 0) {
              try { client.data.owner.send(serialized); }
              catch { client.data.queue.push(serialized); }
            } else {
              if (client.data.queue.length >= 8) throw new Error("Codex gate request queue is full");
              client.data.queue.push(serialized);
            }
          } catch { client.terminate(); }
        },
        close(client) {
          clients.delete(client);
          client.data.owner?.close();
        },
      },
    });
    await chmod(socketPath, 0o600);
    stateServer = createServer(client => {
      stateClients.add(client);
      let owner: Socket;
      try {
        assertSocketIdentity(ownerStatePath, options.stateIdentity);
        owner = createConnection({ path: ownerStatePath });
      } catch { client.end(); stateClients.delete(client); return; }
      let inbound = "";
      let outbound = "";
      let ownerReady = false;
      const queue: string[] = [];
      const pending = new Map<string, PendingRequest>();
      const close = () => { client.destroy(); owner.destroy(); stateClients.delete(client); };
      client.setEncoding("utf8");
      owner.setEncoding("utf8");
      owner.once("connect", () => {
        try {
          assertSocketIdentity(ownerStatePath, options.stateIdentity);
          ownerReady = true;
          for (const entry of queue) owner.write(entry);
          queue.length = 0;
        } catch { close(); }
      });
      client.on("data", chunk => {
        try {
          inbound += chunk;
          if (Buffer.byteLength(inbound) > MAX_MESSAGE) throw new Error("State request too large");
          for (;;) {
            const end = inbound.indexOf("\n");
            if (end < 0) break;
            const message = parseMessage(inbound.slice(0, end));
            inbound = inbound.slice(end + 1);
            const id = requestId(message.id);
            if (id === null || pending.has(id)) throw new Error("Invalid state request id");
            const params = record(message.params);
            if (message.method !== "hello" && message.method !== "snapshot" &&
                !(message.method === "read" && typeof params?.key === "string" && SIDEBAR_KEYS.has(params.key))) {
              client.write(JSON.stringify(denied(message.id)) + "\n");
              continue;
            }
            pending.set(id, { method: message.method, key: typeof params?.key === "string" ? params.key : undefined });
            const request = JSON.stringify({ id: message.id, method: message.method,
              params: message.method === "read" ? { key: params?.key } : {} }) + "\n";
            if (ownerReady) {
              assertSocketIdentity(ownerStatePath, options.stateIdentity);
              owner.write(request);
            } else {
              if (queue.length >= 8) throw new Error("Codex owner state queue is full");
              queue.push(request);
            }
          }
        } catch { close(); }
      });
      owner.on("data", chunk => {
        try {
          assertSocketIdentity(ownerStatePath, options.stateIdentity);
          outbound += chunk;
          if (Buffer.byteLength(outbound) > MAX_MESSAGE) throw new Error("State response too large");
          for (;;) {
            const end = outbound.indexOf("\n");
            if (end < 0) break;
            const message = parseMessage(outbound.slice(0, end));
            outbound = outbound.slice(end + 1);
            const id = requestId(message.id);
            if (id === null) continue;
            const original = pending.get(id);
            if (!original) continue;
            pending.delete(id);
            if (message.error !== undefined) {
              client.write(JSON.stringify({ id: message.id, error: "Codex owner state request failed" }) + "\n");
              continue;
            }
            if (original.method === "snapshot" && message.error === undefined) {
              const snapshot = record(message.result);
              if (!snapshot) throw new Error("Invalid state snapshot");
              message.result = Object.fromEntries([...SIDEBAR_KEYS].map(key => [key, snapshot[key]]));
            }
            if (original.method === "hello" && message.error === undefined) {
              const hello = record(message.result);
              const identity = record(hello?.ownerIdentity);
              if (hello?.version !== 1 || typeof hello.ownerCodexHome !== "string" ||
                  typeof identity?.dev !== "number" || typeof identity?.ino !== "number")
                throw new Error("Invalid state owner identity");
              message.result = { version: 1, ownerCodexHome: hello.ownerCodexHome,
                ownerIdentity: { dev: identity.dev, ino: identity.ino } };
            }
            client.write(JSON.stringify(message) + "\n");
          }
        } catch { close(); }
      });
      client.once("close", close);
      owner.once("close", close);
      client.once("error", close);
      owner.once("error", close);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      stateServer?.once("error", rejectListen);
      stateServer?.listen(stateSocketPath, resolveListen);
    });
    await chmod(stateSocketPath, 0o600);
    const socketInfo = await lstat(socketPath);
    const stateInfo = await lstat(stateSocketPath);
    if (!socketInfo.isSocket() || !stateInfo.isSocket() || socketInfo.uid !== process.getuid?.() ||
        stateInfo.uid !== process.getuid?.()) throw new Error("Codex gate sockets are unavailable");
    return {
      socketPath,
      stateSocketPath,
      async close() {
        for (const client of clients) client.close(1001, "Session stopped");
        for (const client of stateClients) client.destroy();
        server?.stop(true);
        await new Promise<void>(resolveClose => stateServer?.close(() => resolveClose()));
        await rm(socketPath, { force: true });
        await rm(stateSocketPath, { force: true });
      },
    };
  } catch (error) {
    server?.stop(true);
    if (stateServer?.listening) await new Promise<void>(resolveClose => stateServer?.close(() => resolveClose()));
    await rm(socketPath, { force: true });
    await rm(stateSocketPath, { force: true });
    throw error;
  }
}
