import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

type Fields = Record<string, string | number | boolean | null>;
export type ChromeTraceProducer = Readonly<{
  chrome: string; observer: string; fixture: string; lock: string;
  coreBundle: string; dependencyVersion: string;
}>;
type TraceRecord = Fields & { sequence: number; elapsedMs: number; phase: string };
type Scope = { observer: ChromeTransportObserver; workspace: string | null; inputRoot: string | null };
const scopes = new AsyncLocalStorage<Scope>();
const categories = new Set([
  "Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.failRequest", "Fetch.requestPaused",
  "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached",
  "Inspector.targetCrashed", "Browser.getVersion",
]);
const phases = new Set([
  "setup", "open-broker", "fixture-start", "session-create", "navigate", "during-inventory",
  "session-stop", "after-inventory", "journal-inventory", "assertions", "broker-close",
  "fixture-stop", "finished",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** These are forwarding-site observations, not Playwright's callback state. */
export class ChromeTransportObserver {
  private readonly salt = randomBytes(32);
  private readonly started = performance.now();
  private readonly first: TraceRecord[] = [];
  private readonly recent: TraceRecord[] = [];
  private readonly pending = new Map<number, string>();
  private readonly boundaries = new Map<string, string>();
  private readonly connections = new Set<ChromeConnectionObservation>();
  private sequence = 0;
  private operation = 0;
  private phase = "setup";
  private finished = false;
  private droppedRecords = 0;
  private refused = 0;
  private observerErrors = 0;
  private sinkErrors = 0;
  private urgent = 0;
  readonly traceId = randomUUID();

  readonly producer: ChromeTraceProducer;
  constructor(producer: ChromeTraceProducer, private readonly sink: (value: unknown) => void) {
    const digest = (field: keyof ChromeTraceProducer) => {
      try { const value = producer[field]; return /^[a-f0-9]{64}$/.test(value) ? value : "not measured"; }
      catch { return "not measured"; }
    };
    let dependencyVersion = "not measured";
    try { if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(producer.dependencyVersion)) dependencyVersion = producer.dependencyVersion; } catch {}
    this.producer = { chrome: digest("chrome"), observer: digest("observer"), fixture: digest("fixture"), lock: digest("lock"), coreBundle: digest("coreBundle"), dependencyVersion };
  }

  private emit(value: unknown) {
    try { this.sink(value); } catch { this.sinkErrors++; }
  }
  record(fields: Fields, urgent = false) {
    if (this.finished) return;
    try {
      const row = { ...fields, sequence: ++this.sequence, elapsedMs: Math.round(performance.now() - this.started), phase: this.phase };
      if (this.first.length < 64) { this.first.push(row); this.emit({ chromeProtocolTrace: this.traceId, producer: this.producer, record: row }); }
      else {
        if (this.recent.length === 192) { this.recent.shift(); this.droppedRecords++; }
        this.recent.push(row);
        if (urgent && this.urgent++ < 16) this.emit({ chromeProtocolTrace: this.traceId, record: row });
      }
    } catch { this.observerErrors++; }
  }
  hash(value: unknown): string | null {
    if (typeof value !== "string") return null;
    if (value.length > 8192) { this.observerErrors++; return null; }
    return createHmac("sha256", this.salt).update(value).digest("hex");
  }
  unavailable() { this.observerErrors++; }
  isFinished() { return this.finished; }
  observe<T>(name: string, operation: () => T): T {
    if (this.finished) return operation();
    const phase = phases.has(name) ? name : "setup";
    this.phase = phase;
    this.boundaries.set(phase, "before");
    const id = ++this.operation;
    if (this.pending.size < 16) this.pending.set(id, phase);
    else this.observerErrors++;
    this.record({ kind: "fixture", stage: "before", operation: id });
    const settled = (stage: string) => {
      if (this.finished) return;
      this.pending.delete(id);
      this.boundaries.set(phase, stage);
      this.record({ kind: "fixture", stage, operation: id, operationPhase: phase });
    };
    try {
      const value = operation();
      if (value instanceof Promise) void value.then(() => settled("settled"), () => settled("rejected"));
      else settled("settled");
      return value;
    } catch (error) { settled("threw"); throw error; }
  }
  scope<T>(workspace: string, operation: () => T): T {
    let admitted: string | null = null, inputRoot: string | null = null;
    if (!this.finished) {
      try {
        const canonical = realpathSync(workspace), info = lstatSync(canonical);
        if (workspace === resolve(workspace) && info.isDirectory()
          && !info.isSymbolicLink() && (process.platform === "win32" || (info.mode & 0o077) === 0)
          && (process.getuid === undefined || info.uid === process.getuid())) { admitted = canonical; inputRoot = workspace; }
      } catch { this.observerErrors++; }
    }
    if (!admitted) this.refused++;
    return scopes.run({ observer: this, workspace: admitted, inputRoot }, operation);
  }
  connection(profile: string, workspace: string | null, inputRoot: string | null): ChromeConnectionObservation | undefined {
    if (this.finished || !workspace || this.connections.size === 8) { this.refused++; return undefined; }
    try {
      const input = resolve(profile);
      if (profile !== input || dirname(input) !== inputRoot || !basename(input).startsWith("profile-")) { this.refused++; return undefined; }
      const info = lstatSync(input), canonical = realpathSync(input);
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(canonical) !== workspace
        || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (process.getuid !== undefined && info.uid !== process.getuid())) { this.refused++; return undefined; }
      const connection = new ChromeConnectionObservation(this, this.connections.size + 1);
      this.connections.add(connection);
      this.record({ kind: "connection", stage: "admitted", connection: connection.ordinal,
        ownershipWitness: process.platform === "win32" ? "explicit-fixture-capability" : "canonical-private-posix-directory" });
      return connection;
    } catch { this.observerErrors++; return undefined; }
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.phase = "finished";
    this.emit({ chromeProtocolTrace: this.traceId, producer: this.producer, final: {
      sequence: this.sequence, first: this.first, recent: this.recent,
      pending: [...this.pending.values()], droppedRecords: this.droppedRecords,
      refused: this.refused, observerErrors: this.observerErrors, sinkErrors: this.sinkErrors,
      boundaries: [...phases].map(phase => ({ phase, state: this.boundaries.get(phase) ?? "not entered" })),
    } });
    this.pending.clear();
    for (const connection of this.connections) connection.finish();
    this.connections.clear();
  }
}

export class ChromeConnectionObservation {
  private readonly sent = new Map<string, string>();
  private readonly outcomes = new Map<string, string>();
  private readonly responses = new Set<string>();
  private overflow = 0;
  constructor(private readonly owner: ChromeTransportObserver, readonly ordinal: number) {}
  private key(session: string | null, id: number) { return `${session ?? "root"}:${id}`; }
  before(direction: "send" | "receive", message: unknown) {
    if (this.owner.isFinished()) return;
    try {
      if (!object(message)) { this.owner.unavailable(); return; }
      const id = integer(message.id), rawSession = message.sessionId, session = this.owner.hash(rawSession);
      const sessionKnown = rawSession === undefined || typeof rawSession === "string" && session !== null;
      if (!sessionKnown) this.overflow++;
      const method = typeof message.method === "string" && categories.has(message.method) ? message.method : "other";
      const fields: Fields = { kind: "protocol", stage: "before", direction, connection: this.ordinal, id, session, sessionKnown, category: method, mapComplete: this.overflow === 0, mapOverflow: this.overflow };
      if (direction === "send" && id !== null && sessionKnown) {
        const key = this.key(session, id);
        if (this.sent.size === 256 && !this.sent.has(key)) { const first = this.sent.keys().next().value; if (first !== undefined) { this.sent.delete(first); this.outcomes.delete(first); } this.overflow++; }
        this.sent.set(key, method);
        this.responses.delete(key);
        this.outcomes.set(key, "before");
      }
      if (direction === "receive" && id !== null && sessionKnown) {
        const key = this.key(session, id), sent = this.sent.get(key);
        fields.observedSend = sent !== undefined;
        fields.observedSendOutcome = this.outcomes.get(key) ?? "unavailable";
        fields.duplicateResponse = this.responses.has(key);
        fields.category = sent ?? "unmatched-response";
        fields.otherSessionSameId = [...this.sent.keys()].some(candidate => candidate !== key && candidate.endsWith(`:${id}`));
        if (this.responses.size === 256 && !this.responses.has(key)) { const first = this.responses.values().next().value; if (first !== undefined) this.responses.delete(first); this.overflow++; }
        this.responses.add(key);
        if (object(message.error)) {
          fields.errorCode = typeof message.error.code === "number" && Number.isFinite(message.error.code) ? message.error.code : null;
          fields.errorCategory = typeof message.error.message === "string" && message.error.message.length <= 8192 && /Invalid InterceptionId/i.test(message.error.message) ? "InvalidInterceptionId" : "other-error";
          fields.errorHash = this.owner.hash(message.error.message);
        }
        if (sent === "Browser.getVersion" && object(message.result)) {
          const product = message.result.product;
          if (typeof product === "string" && /^(?:Chrome|HeadlessChrome)\/\d{1,3}(?:\.\d{1,6}){1,3}$/.test(product)) fields.browserVersion = product;
        }
      }
      if (object(message.params) && categories.has(method)) {
        if (method === "Fetch.requestPaused" || method.startsWith("Fetch.")) {
          fields.interception = this.owner.hash(message.params.requestId);
          fields.network = this.owner.hash(message.params.networkId);
        }
        if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
          fields.childSession = this.owner.hash(message.params.sessionId);
          fields.target = this.owner.hash(message.params.targetId);
          if (method === "Target.attachedToTarget" && object(message.params.targetInfo)) fields.target = this.owner.hash(message.params.targetInfo.targetId);
        }
        if (method === "Inspector.detached") {
          fields.reasonHash = this.owner.hash(message.params.reason);
          fields.reasonCategory = message.params.reason === "target_closed" || message.params.reason === "replaced_with_devtools" ? message.params.reason : "other";
        }
      }
      fields.mapComplete = this.overflow === 0;
      fields.mapOverflow = this.overflow;
      this.owner.record(fields, fields.errorCategory === "InvalidInterceptionId");
    } catch { this.owner.unavailable(); }
  }
  after(direction: "send" | "receive", stage: "returned" | "threw", message: unknown) {
    if (this.owner.isFinished()) return;
    try {
      const id = object(message) ? integer(message.id) : null;
      const session = object(message) ? this.owner.hash(message.sessionId) : null;
      if (direction === "send" && id !== null) { const key = this.key(session, id); if (this.sent.has(key)) this.outcomes.set(key, stage); }
      this.owner.record({ kind: "protocol", connection: this.ordinal, direction, stage, id, session });
    } catch { this.owner.unavailable(); }
  }
  close() { this.owner.record({ kind: "connection", connection: this.ordinal, stage: "close-before" }); }
  unavailable(stage: "serialization-threw" | "parse-threw") { this.owner.record({ kind: "protocol", connection: this.ordinal, stage }); }
  finish() { this.sent.clear(); this.outcomes.clear(); this.responses.clear(); }
}

export function currentChromeTransportObservation(profile: string): ChromeConnectionObservation | undefined {
  const scope = scopes.getStore();
  return scope?.observer.connection(profile, scope.workspace, scope.inputRoot);
}

/** Never handle the returned callback promise: its original failure must stay visible. */
export function forwardChromeProtocol<Receiver, Args extends unknown[], Result>(
  observer: ChromeConnectionObservation | undefined, direction: "send" | "receive",
  receiver: Receiver, callback: ((this: Receiver, ...args: Args) => Result) | undefined,
  args: Args, message: unknown,
): Result | undefined {
  try { observer?.before(direction, message); } catch {}
  try {
    const result: Result | undefined = callback === undefined || callback === null ? undefined : Reflect.apply(callback, receiver, args);
    try { observer?.after(direction, "returned", message); } catch {}
    return result;
  } catch (error) { try { observer?.after(direction, "threw", message); } catch {} throw error; }
}

export function forwardChromeSend<Receiver, Message, Result>(
  observer: ChromeConnectionObservation | undefined, receiver: Receiver,
  callback: (this: Receiver, value: string) => Result, message: Message,
): Result | undefined {
  let serialized: string;
  try { serialized = JSON.stringify(message); }
  catch (error) { try { observer?.unavailable("serialization-threw"); } catch {} throw error; }
  return forwardChromeProtocol(observer, "send", receiver, callback, [serialized], message);
}

export function forwardChromeReceive<Receiver, Message, Result>(
  observer: ChromeConnectionObservation | undefined, receiver: Receiver,
  callback: ((this: Receiver, message: Message) => Result) | undefined, data: unknown,
): Result | undefined {
  if (callback === undefined || callback === null) return undefined;
  let message: Message;
  try { message = JSON.parse(String(data)); }
  catch (error) { try { observer?.unavailable("parse-threw"); } catch {} throw error; }
  return forwardChromeProtocol(observer, "receive", receiver, callback, [message], message);
}

export function forwardChromeEvent<Receiver, Message, Result>(
  observer: ChromeConnectionObservation | undefined,
  receiver: Receiver & { onmessage?: (this: Receiver, message: Message) => Result },
  event: { readonly data: unknown },
): Result | undefined {
  const callback = receiver.onmessage;
  if (callback === undefined || callback === null) return undefined;
  let message: Message;
  try { message = JSON.parse(String(event.data)); }
  catch (error) { try { observer?.unavailable("parse-threw"); } catch {} throw error; }
  return forwardChromeProtocol(observer, "receive", receiver, callback, [message], message);
}
