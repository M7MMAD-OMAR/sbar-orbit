import { randomBytes, createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { lstatSync } from "node:fs";
import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_PAGE_RESPONSE = 4 * 1024 * 1024;
const MAX_THREAD_METADATA_RESPONSE = 64 * 1024;
const MAX_THREAD_SECTION_RESPONSE = 64 * 1024;
const MAX_ACTIVE_PAGE_READERS = 4;
const MAX_ACTIVE_SECTION_READERS = 4;
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
type PendingRequest = { method: string; key?: string; metadataThreadId?: string;
  fixtureThreadId?: string };
export type GateSocketIdentity = { device: string; inode: string };
export type GateFieldShape = { key: string; kind: string; length?: number };
export type GateNotificationShape = { method: string; keys: string[]; outcome: "allow" | "deny" };
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
export type ThreadSectionListRequest = {
  method: "threadSection/list";
  params: { cursor: string | null; limit: number };
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
const MAX_FIXTURE_NOTIFICATION_BYTES = 64 * 1024;
const MAX_FIXTURE_NOTIFICATION_BUFFER = 32;
const MAX_FIXTURE_NOTIFICATION_COUNT = 256;
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

function safeThreadSectionListRequest(message: RpcMessage): ThreadSectionListRequest | null {
  if (message.method !== "threadSection/list" || requestId(message.id) === null ||
      Object.keys(message).some(key => key !== "id" && key !== "method" && key !== "params")) return null;
  const input = message.params === undefined ? {} : record(message.params);
  if (!input || Object.keys(input).some(key => key !== "cursor" && key !== "limit")) return null;
  const cursor = input.cursor === undefined || input.cursor === null ? null : input.cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 4096 ||
      !/^[\x20-\x7e]+$/u.test(cursor))) return null;
  const limit = input.limit === undefined || input.limit === null ? 50 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) return null;
  return Object.freeze({ method: "threadSection/list", params: Object.freeze({
    cursor, limit: limit as number,
  }) });
}

function safeThreadSectionListResponse(id: string | number, result: unknown,
                                       limit: number, maxMessageBytes: number): string | null {
  const serializedResult = JSON.stringify(result);
  if (typeof serializedResult !== "string" ||
      Buffer.byteLength(serializedResult) > Math.min(maxMessageBytes, MAX_THREAD_SECTION_RESPONSE)) return null;
  const value = record(JSON.parse(serializedResult));
  if (!value || !Array.isArray(value.data) || value.data.length > limit ||
      containsCredentialField(value)) return null;
  const nextCursor = value.nextCursor === undefined ? null : value.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length < 1 ||
      nextCursor.length > 4096 || !/^[\x20-\x7e]+$/u.test(nextCursor))) return null;
  const data: Array<{ id: string; name: string;
    appearance: { icon: string | null; color: string | null } | null }> = [];
  for (const item of value.data) {
    const section = record(item);
    if (!section || typeof section.id !== "string" || !UUID.test(section.id) ||
        !boundedMetadataText(section.name, 512) || section.name.trim().length === 0) return null;
    const appearance = section.appearance === undefined || section.appearance === null
      ? null : record(section.appearance);
    if (section.appearance !== undefined && section.appearance !== null && !appearance) return null;
    const icon = appearance?.icon === undefined ? null : appearance.icon;
    const color = appearance?.color === undefined ? null : appearance.color;
    if (!nullableMetadataText(icon, 64) || !nullableMetadataText(color, 64)) return null;
    data.push({ id: section.id, name: section.name,
      appearance: appearance ? { icon: icon as string | null, color: color as string | null } : null });
  }
  const response = JSON.stringify({ id, result: { data, nextCursor } });
  return Buffer.byteLength(response) <= Math.min(maxMessageBytes, MAX_THREAD_SECTION_RESPONSE)
    ? response : null;
}

function safeFixtureTurnStartRequest(message: RpcMessage, threadId: string | undefined,
                                     allowOrbitTool: boolean): RpcMessage | null {
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
    threadId, input: [{ type: "text", text: item.text }],
    allowedTools: allowOrbitTool ? [{ namespace: "mcp__orbit_private", name: "orbit_act" }] : [],
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

function fixtureAgentMessage(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item || item.type !== "agentMessage" || typeof item.id !== "string" ||
      item.id.length < 1 || item.id.length > 128 || typeof item.text !== "string" ||
      Buffer.byteLength(item.text) > 32768) return null;
  return { type: "agentMessage", id: item.id, text: item.text };
}

function fixtureTurn(value: unknown, expectedTurnId: string): Record<string, unknown> | null {
  const turn = record(value);
  if (!turn || turn.id !== expectedTurnId ||
      !["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status)) ||
      !Array.isArray(turn.items) || turn.items.length > 16) return null;
  const items: Record<string, unknown>[] = [];
  for (const item of turn.items) {
    const projected = fixtureAgentMessage(item);
    if (projected) items.push(projected);
  }
  return { id: expectedTurnId, status: turn.status, items, error: null };
}

function fixtureNotification(message: RpcMessage, threadId: string, turnId: string): string | null {
  if (message.id !== undefined || typeof message.method !== "string" ||
      containsCredentialField(message.params)) return null;
  const params = record(message.params);
  if (!params || params.threadId !== threadId) return null;
  let projected: Record<string, unknown> | null = null;
  if (message.method === "turn/started" || message.method === "turn/completed") {
    const turn = fixtureTurn(params.turn, turnId);
    if (turn) projected = { threadId, turn };
  } else if (message.method === "item/started" || message.method === "item/completed") {
    if (params.turnId !== turnId) return null;
    const item = fixtureAgentMessage(params.item);
    if (item) projected = { threadId, turnId, item,
      ...(message.method === "item/started" && Number.isSafeInteger(params.startedAtMs)
        ? { startedAtMs: params.startedAtMs } : {}),
      ...(message.method === "item/completed" && Number.isSafeInteger(params.completedAtMs)
        ? { completedAtMs: params.completedAtMs } : {}) };
  } else if (message.method === "item/agentMessage/delta") {
    if (params.turnId !== turnId || typeof params.itemId !== "string" ||
        params.itemId.length < 1 || params.itemId.length > 128 ||
        typeof params.delta !== "string" || Buffer.byteLength(params.delta) > 8192) return null;
    projected = { threadId, turnId, itemId: params.itemId, delta: params.delta };
  }
  if (!projected) return null;
  const output = JSON.stringify({ method: message.method, params: projected });
  return Buffer.byteLength(output) <= MAX_FIXTURE_NOTIFICATION_BYTES ? output : null;
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

function boundedMetadataText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes && !value.includes("\0");
}

function nullableMetadataText(value: unknown, maxBytes: number): boolean {
  return value === null || boundedMetadataText(value, maxBytes);
}

function metadataTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sanitizedThreadMetadata(result: unknown, requestedThreadId: string): Record<string, unknown> | null {
  const response = record(result);
  const thread = record(response?.thread);
  if (!response || !thread || !UUID.test(requestedThreadId) ||
      thread.id !== requestedThreadId || !Array.isArray(thread.turns) || thread.turns.length !== 0 ||
      typeof thread.sessionId !== "string" || !UUID.test(thread.sessionId) ||
      !nullableMetadataText(thread.forkedFromId, 128) ||
      (thread.forkedFromId !== null && !UUID.test(thread.forkedFromId as string)) ||
      !nullableMetadataText(thread.parentThreadId, 128) ||
      (thread.parentThreadId !== null && !UUID.test(thread.parentThreadId as string)) ||
      !boundedMetadataText(thread.preview, 8192) || typeof thread.ephemeral !== "boolean" ||
      !nullableMetadataText(thread.projectId, 128) ||
      (thread.historyMode !== "legacy" && thread.historyMode !== "paginated") ||
      !boundedMetadataText(thread.modelProvider, 128) ||
      !metadataTimestamp(thread.createdAt) || !metadataTimestamp(thread.updatedAt) ||
      (thread.recencyAt !== null && !metadataTimestamp(thread.recencyAt)) ||
      !boundedMetadataText(thread.cwd, 4096) || !thread.cwd.startsWith("/") ||
      !nullableMetadataText(thread.name, 1024) ||
      !nullableMetadataText(thread.threadSource, 128)) return null;
  const status = record(thread.status);
  if (!status || (status.type !== "notLoaded" && status.type !== "idle" &&
      status.type !== "systemError" && status.type !== "active")) return null;
  let safeStatus: Record<string, unknown> = { type: status.type };
  if (status.type === "active") {
    if (!Array.isArray(status.activeFlags) || status.activeFlags.length > 2 ||
        !status.activeFlags.every(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput"))
      return null;
    safeStatus = { type: "active", activeFlags: [...new Set(status.activeFlags)] };
  }
  let safeSection: Record<string, unknown> | null = null;
  if (thread.section !== null) {
    const section = record(thread.section);
    if (!section || typeof section.id !== "string" || !UUID.test(section.id) ||
        !boundedMetadataText(section.name, 512)) return null;
    let appearance: Record<string, unknown> | null = null;
    if (section.appearance !== null) {
      const details = record(section.appearance);
      if (!details || !nullableMetadataText(details.icon, 128) ||
          !nullableMetadataText(details.color, 128)) return null;
      appearance = { icon: details.icon, color: details.color };
    }
    safeSection = { id: section.id, name: section.name, appearance };
  }
  if (thread.sectionEnteredAt !== null && !metadataTimestamp(thread.sectionEnteredAt)) return null;
  let safeGitInfo: Record<string, unknown> | null = null;
  if (thread.gitInfo !== null) {
    const git = record(thread.gitInfo);
    if (!git || !nullableMetadataText(git.sha, 128) || !nullableMetadataText(git.branch, 512))
      return null;
    safeGitInfo = { sha: git.sha, branch: git.branch, originUrl: null };
  }
  const source = thread.source;
  if (typeof source !== "string" && record(source) === null) return null;
  const safeSource = source === "cli" || source === "vscode" || source === "exec" ||
    source === "appServer" || source === "unknown" ? source : "unknown";
  const projected = { thread: {
    id: thread.id, sessionId: thread.sessionId, forkedFromId: thread.forkedFromId,
    parentThreadId: thread.parentThreadId, preview: thread.preview, ephemeral: thread.ephemeral,
    section: safeSection, sectionEnteredAt: thread.sectionEnteredAt, projectId: thread.projectId,
    historyMode: thread.historyMode, modelProvider: thread.modelProvider,
    createdAt: thread.createdAt, updatedAt: thread.updatedAt, recencyAt: thread.recencyAt,
    status: safeStatus, path: null, cwd: thread.cwd, source: safeSource,
    threadSource: thread.threadSource, gitInfo: safeGitInfo, name: thread.name, turns: [],
  } };
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_THREAD_METADATA_RESPONSE) return null;
  return projected;
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

function appResponse(message: RpcMessage, method: string, metadataThreadId?: string): RpcMessage {
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
  if (method === "thread/read" && metadataThreadId) {
    const metadata = sanitizedThreadMetadata(message.result, metadataThreadId);
    return metadata ? { id: message.id, result: metadata }
      : { id: message.id, error: { code: -32000, message: "Codex thread metadata unavailable" } };
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

type FixtureTurnScope = { threadId: string; pendingId: string | null; turnId: string | null;
  buffered: RpcMessage[]; count: number };
type ClientData = { owner?: OwnerWebSocket; queue: string[]; pending: Map<string, PendingRequest>;
  pages: Set<string>; fixtureTurn?: FixtureTurnScope };

export async function startCodexReadOnlyGate(session: string, ownerSocketPath: string, ownerStatePath: string,
                                             options: { ownerIdentity: GateSocketIdentity;
                                               stateIdentity: GateSocketIdentity;
                                               maxMessageBytes?: number;
                                               allowLegacyThreadRead?: boolean;
                                               allowThreadMetadataRead?: boolean;
                                               allowPaginatedThreadPages?: boolean;
                                               readPaginatedThreadPage?: (request: PaginatedPageRequest) => Promise<unknown>;
                                               allowFixtureThreadSections?: boolean;
                                               fixtureThreadSectionReader?: (request: ThreadSectionListRequest) => Promise<unknown>;
                                               fixtureTurnThreadId?: string;
                                               fixtureAllowOrbitTool?: boolean;
                                               fixturePollSavedTurn?: boolean;
                                               auditMethod?: (method: string, outcome: "allow" | "deny") => void;
                                               auditFixtureNotificationShape?: (shape: GateNotificationShape) => void;
                                               auditThreadListShape?: (fields: GateFieldShape[]) => void }) {
  const maxMessageBytes = options.maxMessageBytes === undefined ? MAX_MESSAGE
    : Number.isSafeInteger(options.maxMessageBytes) && options.maxMessageBytes >= 1024 &&
      options.maxMessageBytes <= MAX_MESSAGE ? options.maxMessageBytes : 0;
  if (maxMessageBytes === 0) throw new Error("Invalid Codex gate message limit");
  if (options.fixtureTurnThreadId !== undefined && !UUID.test(options.fixtureTurnThreadId))
    throw new Error("Invalid Codex fixture thread ID");
  if (options.fixtureAllowOrbitTool && (!options.fixtureTurnThreadId ||
      !options.readPaginatedThreadPage || options.allowPaginatedThreadPages !== true))
    throw new Error("Codex fixture Orbit tool needs one pinned thread and an isolated page reader");
  if (options.fixturePollSavedTurn &&
      (!options.fixtureTurnThreadId || !options.readPaginatedThreadPage ||
       options.allowPaginatedThreadPages !== true))
    throw new Error("Codex fixture polling needs one thread and an isolated page reader");
  const suffix = randomBytes(5).toString("hex");
  const socketPath = join(session, `codex-gate-${suffix}.sock`);
  const stateSocketPath = `${socketPath}.state`;
  const clients = new Set<ServerWebSocket<ClientData>>();
  const stateClients = new Set<Socket>();
  let activePageReaders = 0;
  let activeSectionReaders = 0;
  let server: ReturnType<typeof Bun.serve<ClientData>> | undefined;
  let stateServer: ReturnType<typeof createServer> | undefined;
  const pollSavedFixtureTurn = async (client: ServerWebSocket<ClientData>, scope: FixtureTurnScope) => {
    const reader = options.readPaginatedThreadPage;
    if (!reader || !scope.turnId) return;
    const deadline = Date.now() + 12000;
    for (let attempt = 0; attempt < 40 && Date.now() < deadline &&
         client.data.fixtureTurn === scope; attempt++) {
      try {
        const raw = await reader({ method: "thread/turns/list", params: {
          threadId: scope.threadId, readOnly: true, limit: 50,
          sortDirection: "asc", itemsView: "full",
        } });
        const serialized = safePaginatedPageResponse("fixture-poll", raw, 50, maxMessageBytes);
        const result = serialized ? record(record(JSON.parse(serialized))?.result) : null;
        const saved = result?.data && Array.isArray(result.data)
          ? result.data.find(item => record(item)?.id === scope.turnId) : undefined;
        const turn = fixtureTurn(saved, scope.turnId);
        if (turn && turn.status !== "inProgress" && client.data.fixtureTurn === scope) {
          const item = (turn.items as Record<string, unknown>[]).find(candidate =>
            candidate.type === "agentMessage");
          if (item) {
            const event = JSON.stringify({ method: "item/completed", params: {
              threadId: scope.threadId, turnId: scope.turnId, item,
            } });
            if (Buffer.byteLength(event) <= MAX_FIXTURE_NOTIFICATION_BYTES) client.send(event);
          }
          const completion = JSON.stringify({ method: "turn/completed", params: {
            threadId: scope.threadId, turn,
          } });
          if (Buffer.byteLength(completion) > MAX_FIXTURE_NOTIFICATION_BYTES)
            throw new Error("Fixture completion notification is too large");
          client.send(completion);
          options.auditFixtureNotificationShape?.({ method: "fixture/savedTurn/completed",
            keys: ["threadId", "turn"], outcome: "allow" });
          client.data.fixtureTurn = undefined;
          return;
        }
      } catch { /* A transient fake page read can retry within the bounded window. */ }
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 250));
    }
  };
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
              if (id === null && message.id === undefined && message.method !== undefined) {
                const audit = (outcome: "allow" | "deny") => {
                  if (!options.fixtureTurnThreadId) return;
                  const method = typeof message.method === "string" &&
                    /^[A-Za-z0-9/_-]{1,80}$/u.test(message.method) ? message.method : "invalid";
                  const keys = Object.keys(record(message.params) ?? {}).slice(0, 16).map(key =>
                    /^[A-Za-z0-9_]{1,64}$/u.test(key) ? key : "invalid");
                  options.auditFixtureNotificationShape?.({ method, keys, outcome });
                };
                const scope = data.fixtureTurn;
                if (!scope || message.method === undefined) { audit("deny"); return; }
                if (Buffer.byteLength(text) > MAX_FIXTURE_NOTIFICATION_BYTES) { audit("deny"); return; }
                const params = record(message.params);
                if (params?.threadId !== scope.threadId || containsCredentialField(message.params)) {
                  audit("deny"); return;
                }
                if (scope.turnId === null) {
                  if (scope.pendingId === null || scope.buffered.length >= MAX_FIXTURE_NOTIFICATION_BUFFER) {
                    audit("deny");
                    return;
                  }
                  scope.buffered.push(message);
                  return;
                }
                const notification = fixtureNotification(message, scope.threadId, scope.turnId);
                if (!notification) { audit("deny"); return; }
                if (++scope.count > MAX_FIXTURE_NOTIFICATION_COUNT) throw new Error("Fixture notification limit reached");
                client.send(notification);
                audit("allow");
                if (message.method === "turn/completed") data.fixtureTurn = undefined;
                return;
              }
              if (id === null || message.method !== undefined) return;
              const pending = data.pending.get(id);
              if (!pending) return;
              data.pending.delete(id);
              if (pending.method !== "account/read" && pending.method !== "getAuthStatus" &&
                  containsCredentialField(message.result))
                throw new Error("Codex owner returned credential fields");
              const response = appResponse(message, pending.method, pending.metadataThreadId);
              client.send(JSON.stringify(response));
              if (pending.fixtureThreadId) {
                const scope = data.fixtureTurn;
                const result = record(response.result);
                const turn = record(result?.turn);
                if (!scope || scope.pendingId !== id || scope.threadId !== pending.fixtureThreadId ||
                    typeof turn?.id !== "string" || !UUID.test(turn.id)) {
                  data.fixtureTurn = undefined;
                  return;
                }
                scope.pendingId = null;
                scope.turnId = turn.id;
                for (const buffered of scope.buffered) {
                  const notification = fixtureNotification(buffered, scope.threadId, scope.turnId);
                  if (!notification) {
                    if (options.auditFixtureNotificationShape) {
                      const method = typeof buffered.method === "string" &&
                        /^[A-Za-z0-9/_-]{1,80}$/u.test(buffered.method) ? buffered.method : "invalid";
                      const keys = Object.keys(record(buffered.params) ?? {}).slice(0, 16).map(key =>
                        /^[A-Za-z0-9_]{1,64}$/u.test(key) ? key : "invalid");
                      options.auditFixtureNotificationShape({ method, keys, outcome: "deny" });
                    }
                    continue;
                  }
                  if (++scope.count > MAX_FIXTURE_NOTIFICATION_COUNT)
                    throw new Error("Fixture notification limit reached");
                  client.send(notification);
                  if (options.auditFixtureNotificationShape) {
                    const method = typeof buffered.method === "string" &&
                      /^[A-Za-z0-9/_-]{1,80}$/u.test(buffered.method) ? buffered.method : "invalid";
                    const keys = Object.keys(record(buffered.params) ?? {}).slice(0, 16).map(key =>
                      /^[A-Za-z0-9_]{1,64}$/u.test(key) ? key : "invalid");
                    options.auditFixtureNotificationShape({ method, keys, outcome: "allow" });
                  }
                  if (buffered.method === "turn/completed") data.fixtureTurn = undefined;
                }
                scope.buffered = [];
                if (options.fixturePollSavedTurn && data.fixtureTurn === scope) {
                  if (scope.count === 0) client.send(JSON.stringify({ method: "turn/started", params: {
                    threadId: scope.threadId, turn: { id: scope.turnId, status: "inProgress",
                      items: [], error: null },
                  } }));
                  void pollSavedFixtureTurn(client, scope);
                }
              }
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
            const section = options.allowFixtureThreadSections === true && options.fixtureThreadSectionReader
              ? safeThreadSectionListRequest(request) : null;
            const safe = page || section ? null : safeAppRequest(request, options.allowLegacyThreadRead === true,
              options.allowThreadMetadataRead === true);
            const fixtureTurn = !page && !section && !safe
              ? safeFixtureTurnStartRequest(request, options.fixtureTurnThreadId,
                options.fixtureAllowOrbitTool === true) : null;
            const methodName = typeof request.method === "string" &&
              /^[A-Za-z0-9/_-]{1,80}$/u.test(request.method) ? request.method : "invalid";
            options.auditMethod?.(methodName, safe || page || section || fixtureTurn ? "allow" : "deny");
            if (methodName === "thread/list" && options.auditThreadListShape) {
              const fields = Object.entries(record(request.params) ?? {}).slice(0, 32).map(([key, value]) => ({
                key: /^[A-Za-z0-9_]{1,64}$/u.test(key) ? key : "invalid",
                kind: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
                ...(typeof value === "string" || Array.isArray(value) ? { length: value.length } : {}),
              }));
              options.auditThreadListShape(fields);
            }
            if (!safe && !page && !section && !fixtureTurn) {
              client.send(JSON.stringify(denied(request.id))); return;
            }
            if (fixtureTurn && client.data.fixtureTurn) {
              client.send(JSON.stringify(denied(request.id))); return;
            }
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
            if (section) {
              const reader = options.fixtureThreadSectionReader;
              if (!reader) throw new Error("Codex fixture section reader is unavailable");
              if (activeSectionReaders >= MAX_ACTIVE_SECTION_READERS) {
                client.send(JSON.stringify({ id: request.id,
                  error: { code: -32000, message: "Codex sections unavailable" } }));
                return;
              }
              client.data.pages.add(id);
              activeSectionReaders++;
              const work = Promise.resolve().then(() => reader(section));
              void work.then(() => { activeSectionReaders--; }, () => { activeSectionReaders--; });
              void (async () => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const result = await Promise.race([
                    work,
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error("Codex fixture sections timed out")), 5000);
                    }),
                  ]);
                  const response = safeThreadSectionListResponse(request.id as string | number, result,
                    section.params.limit, maxMessageBytes);
                  client.send(response ?? JSON.stringify({ id: request.id,
                    error: { code: -32000, message: "Codex sections unavailable" } }));
                } catch {
                  try { client.send(JSON.stringify({ id: request.id,
                    error: { code: -32000, message: "Codex sections unavailable" } })); }
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
            const forwardedParams = record(forwarded.params);
            if (fixtureTurn && typeof forwardedParams?.threadId === "string")
              client.data.fixtureTurn = { threadId: forwardedParams.threadId,
                pendingId: id, turnId: null, buffered: [], count: 0 };
            client.data.pending.set(id, { method: forwarded.method ?? "",
              fixtureThreadId: fixtureTurn && typeof forwardedParams?.threadId === "string"
                ? forwardedParams.threadId : undefined,
              metadataThreadId: forwarded.method === "thread/read" &&
                forwardedParams?.includeTurns === false && typeof forwardedParams.threadId === "string"
                ? forwardedParams.threadId : undefined });
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
          client.data.fixtureTurn = undefined;
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
