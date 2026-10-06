import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserBackend, captureTimeoutMs } from "../src/browser";
import { defaultChromeExecutable } from "../src/chrome";
import type { Sessions } from "../src/session";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Fixture = "mcp" | "observe-policy" | "preview-concurrent";
type Entry = { fixture: Fixture; restore: (() => void)[]; pending: Map<string, string>; invalid: boolean;
  cleanupConfirmed: boolean; active: boolean };
type Scope = { entry: Entry; request: string; observation?: string };
const scope = new AsyncLocalStorage<Scope>();
const entries = new Map<Sessions, Entry>();
let sequence = 0;
let restoreFactory: (() => void) | undefined;
const enabled = () => process.platform === "darwin" && process.env.ORBIT_TEST_CAPTURE_DIAGNOSTIC === "1";

/** Pure bookkeeping controls do not exercise a browser or establish capture evidence. */
export class ReferenceRegistrations<T extends object> {
  private refs = new Map<T, { count: number; restore: () => void }>();
  acquire(owner: T, install: () => () => void): () => void {
    const existing = this.refs.get(owner);
    if (existing) existing.count++;
    else this.refs.set(owner, { count: 1, restore: install() });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.refs.get(owner);
      if (!entry || --entry.count > 0) return;
      this.refs.delete(owner);
      entry.restore();
    };
  }
  get size() { return this.refs.size; }
}
const registrations = new ReferenceRegistrations<Sessions>();

/** Observe settlement while returning the exact promise supplied by the real method. */
export function observePromise<T>(promise: Promise<T>, fulfilled: (value: T) => void,
  rejected: (error: unknown) => void, observerFailed: () => void): Promise<T> {
  const protect = (operation: () => void) => {
    try { operation(); } catch { try { observerFailed(); } catch {} }
  };
  try { void promise.then(value => protect(() => fulfilled(value)), error => protect(() => rejected(error))); }
  catch { protect(observerFailed); }
  return promise;
}

function hash(value: string) { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
type SafeError = { code?: string; diagnosticId?: string; messageCategory: string;
  captureBudgetMs?: number; messageBytes?: number; messageSha256?: string; codeSha256?: string };
export function sanitizedCaptureError(value: unknown): SafeError {
  try { return sanitizedErrorFields(value); }
  catch { return { messageCategory: "unreadable error metadata" }; }
}
function sanitizedErrorFields(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const codes = ["TIMEOUT", "BACKEND_FAILED", "BACKEND_ERROR", "BROKER_UNAVAILABLE", "POLICY_DENIED",
    "SESSION_CLOSED", "SESSION_NOT_FOUND", "RESOURCE_LIMIT_REQUIRED", "USAGE_STATE_INVALID", "INVALID_REQUEST", "DEADLINE_EXCEEDED"];
  const code = typeof record.code === "string" && codes.includes(record.code) ? record.code : undefined;
  const diagnosticId = typeof record.diagnosticId === "string" && /^[a-f0-9-]{36}$/.test(record.diagnosticId)
    ? record.diagnosticId : undefined;
  const message = typeof record.message === "string" ? record.message : "";
  const timeout = /^The page did not produce a frame within (\d+) ms \(capturing pixels\)\./.exec(message);
  return { code, codeSha256: !code && typeof record.code === "string" ? hash(record.code) : undefined,
    diagnosticId, messageCategory: timeout ? "capture timeout"
    : message === "Cannot reach the Orbit broker" ? "broker unavailable" : "other error message",
    captureBudgetMs: timeout ? Number(timeout[1]) : undefined, messageBytes: Buffer.byteLength(message),
    messageSha256: hash(message) };
}

function emit(current: Scope, phase: string, fields: Record<string, unknown> = {}) {
  try { console.error(JSON.stringify({ captureDiagnostic: phase, sequence: ++sequence,
    fixture: current.entry.fixture, request: current.request, observation: current.observation,
    monotonicMs: performance.now(), ...fields })); }
  catch { current.entry.invalid = true; }
}
function invalid(current: Scope) {
  current.entry.invalid = true;
  emit(current, "diagnostic.invalid");
}
function operation<T>(current: Scope, phase: string, invoke: () => Promise<T>, fulfilled?: (value: T) => void) {
  const operationId = crypto.randomUUID(), started = performance.now();
  current.entry.pending.set(operationId, phase);
  emit(current, `${phase}.start`, { operation: operationId });
  const settled = (status: string, error?: unknown) => {
    current.entry.pending.delete(operationId);
    emit(current, `${phase}.settled`, { operation: operationId, status,
      elapsedMs: performance.now() - started, ...(status === "rejected" ? sanitizedCaptureError(error) : {}) });
  };
  let promise: Promise<T>;
  try { promise = invoke(); }
  catch (error) { settled("rejected", error); throw error; }
  return observePromise(promise, value => { settled("fulfilled"); fulfilled?.(value); },
    error => settled("rejected", error), () => invalid(current));
}

/** Restore the original own descriptor or remove our temporary inherited-method shadow. */
function replaceMethod<T extends object, K extends keyof T>(owner: T, key: K, value: T[K]) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  Object.defineProperty(owner, key, { configurable: true, writable: true,
    enumerable: descriptor?.enumerable ?? false, value });
  return () => {
    if (owner[key] !== value) throw new Error("Diagnostic method changed before restoration");
    if (descriptor) Object.defineProperty(owner, key, descriptor);
    else Reflect.deleteProperty(owner, key);
  };
}

function instrumentBackend(backend: BrowserBackend, current: Scope) {
  const entry = current.entry, originalObserve = backend.observe;
  entry.restore.push(replaceMethod(backend, "observe", function(this: BrowserBackend) {
    const active = scope.getStore();
    if (active?.entry !== entry || !entry.active) return originalObserve.call(this);
    const selected = { ...active, observation: crypto.randomUUID() };
    emit(selected, "capture.budget", { budgetMs: captureTimeoutMs() });
    return scope.run(selected, () => operation(selected, "observe", () => originalObserve.call(this)));
  }));
  const context = backend.context, originalAttach = context.newCDPSession;
  const channels = new WeakSet<object>();
  entry.restore.push(replaceMethod(context, "newCDPSession", function(this: typeof context, ...args: Parameters<typeof originalAttach>) {
    const active = scope.getStore();
    if (active?.entry !== entry || !entry.active || !active.observation) return originalAttach.apply(this, args);
    return operation(active, "attachment", () => originalAttach.apply(this, args), channel => {
      if (!entry.active) return;
      if (channels.has(channel)) return;
      channels.add(channel);
      const originalSend = channel.send;
      entry.restore.push(replaceMethod(channel, "send", function(this: typeof channel, ...sendArgs: Parameters<typeof originalSend>) {
        const capturing = scope.getStore();
        if (capturing?.entry !== entry || !entry.active || !capturing.observation || sendArgs[0] !== "Page.captureScreenshot")
          return originalSend.apply(this, sendArgs);
        return operation(capturing, "screenshot", () => originalSend.apply(this, sendArgs));
      } as typeof originalSend));
    });
  }));
  const version = backend.context.browser()?.version();
  emit(current, "browser.connected", { version: version && /^[\d.]+$/.test(version) ? version : undefined });
}

function installFactory() {
  if (restoreFactory) return;
  const original = BrowserBackend.create;
  restoreFactory = replaceMethod(BrowserBackend, "create", function(this: typeof BrowserBackend, ...args: Parameters<typeof original>) {
    const current = scope.getStore();
    const promise = original.apply(this, args);
    if (!current?.entry.active) return promise;
    let executable: string | undefined;
    try { executable = args[2]?.executable ?? defaultChromeExecutable(); }
    catch { invalid(current); }
    return observePromise(promise, backend => {
      if (!current.entry.active) { emit(current, "backend.created.after-close"); return; }
      instrumentBackend(backend, current);
      if (!executable) { invalid(current); return; }
      const digest = Bun.file(executable).arrayBuffer();
      operation(current, "browser.identity", () => digest, bytes => emit(current, "browser.identity.bytes", {
        executableSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      }));
    }, () => {}, () => invalid(current));
  });
}

export function installCaptureDiagnostic(sessions: Sessions, fixture: Fixture): (cleanupConfirmed?: boolean) => void {
  if (!enabled()) return () => {};
  const release = registrations.acquire(sessions, () => {
    installFactory();
    const entry: Entry = { fixture, restore: [], pending: new Map(), invalid: false, cleanupConfirmed: false, active: true };
    entries.set(sessions, entry);
    const original = sessions.dispatch;
    entry.restore.push(replaceMethod(sessions, "dispatch", function(this: Sessions, ...args: Parameters<typeof original>) {
      const current = { entry, request: crypto.randomUUID() };
      return scope.run(current, () => {
        const request = args[0];
        const method = request !== null && typeof request === "object" && "method" in request && typeof request.method === "string"
          ? request.method : undefined;
        const phase = entry.fixture === "preview-concurrent"
          ? method === "session.act" ? "pending.action" : method === "session.observe" ? "dispatch.observe"
            : method === "session.stop" ? "session.stop" : method === "session.create" ? "session.create" : undefined
          : undefined;
        return phase ? operation(current, phase, () => original.apply(this, args)) : original.apply(this, args);
      });
    }));
    return () => {
      const current = { entry, request: crypto.randomUUID() };
      entry.active = false;
      for (const restore of entry.restore.reverse()) { try { restore(); } catch { invalid(current); } }
      entries.delete(sessions);
      emit(current, "registration.closed", { pending: [...entry.pending.values()], invalid: entry.invalid,
        cleanupConfirmed: entry.cleanupConfirmed });
      if (!entries.size) { try { restoreFactory?.(); } catch { invalid(current); } finally { restoreFactory = undefined; } }
    };
  });
  return (cleanupConfirmed = false) => {
    const entry = entries.get(sessions);
    if (entry) entry.cleanupConfirmed ||= cleanupConfirmed;
    release();
  };
}

export function observeCaptureCleanup<T>(sessions: Sessions, invoke: () => Promise<T>): Promise<T> {
  const entry = enabled() ? entries.get(sessions) : undefined;
  if (!entry?.active) return invoke();
  return operation({ entry, request: crypto.randomUUID() }, "broker.close", invoke);
}

export function reportMcpObserve(result: CallToolResult) {
  if (!enabled()) return;
  try { reportResult(result); }
  catch { try { console.error(JSON.stringify({ captureDiagnostic: "diagnostic.invalid", fixture: "mcp" })); } catch {} }
}
function reportResult(result: CallToolResult) {
  const text = result.content.find(block => block.type === "text");
  let error: Record<string, unknown> = {};
  if (result.isError && text?.type === "text") {
    try { error = sanitizedCaptureError(JSON.parse(text.text)); }
    catch { error = { messageCategory: "unparseable error", textBytes: Buffer.byteLength(text.text), textSha256: hash(text.text) }; }
  }
  console.error(JSON.stringify({ captureDiagnostic: "mcp.result", fixture: "mcp",
    isError: result.isError === true, contentTypes: result.content.map(block => block.type), ...error }));
}
