import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
/** Emit only bounded diagnostic lines. A manifest acknowledges synchronous emission, not capture. */
export function createChromeTraceOutputSink(writeLine: (line: string) => void): (value: unknown) => void {
  let message = 0;
  let traceId: string | null = null;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const line = (value: unknown) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") + 1 > 4096) throw new Error("trace-output-line-bound");
    writeLine(serialized);
  };
  return value => {
    const ordinal = ++message;
    try {
      if (ordinal > 81) throw new Error("trace-output-message-cap");
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("trace-output-serialization");
      const bytes = Buffer.from(serialized, "utf8");
      if (bytes.length > 524288) throw new Error("trace-output-byte-cap");
      const parsed: unknown = JSON.parse(serialized);
      if (!object(parsed) || typeof parsed.chromeProtocolTrace !== "string" || parsed.chromeProtocolTrace.length !== 36 || !uuid.test(parsed.chromeProtocolTrace)) throw new Error("trace-output-identity");
      if (traceId !== null && traceId !== parsed.chromeProtocolTrace) throw new Error("trace-output-identity");
      traceId = parsed.chromeProtocolTrace;
      const count = Math.ceil(bytes.length / 2048);
      if (count < 1 || count > 256) throw new Error("trace-output-fragment-cap");
      const metadata = { chromeTraceFrame: "orbit-chrome-trace", schema: 1, traceId, message: ordinal, count, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      for (let index = 0; index < count; index++) {
        line({ ...metadata, kind: "fragment", index, payload: bytes.subarray(index * 2048, (index + 1) * 2048).toString("base64") });
      }
      line({ ...metadata, kind: "emission-manifest" });
    } catch (error) {
      // One best-effort refusal marker, never a success manifest or fragment retry.
      try { line({ chromeTraceFrame: "orbit-chrome-trace", schema: 1, kind: "incomplete", traceId, message: ordinal, reason: "output-refused-or-sink-threw" }); } catch {}
      throw error;
    }
  };
}

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
  /** Observe invocation only. Promises remain unhandled and retain their original identity.
   * A caller that already awaits the result may acknowledge that await with settled().
   * Rejected or unawaited promises stay pending unless the caller records an actual boundary.
   */
  observe<T>(name: string, operation: () => T): T {
    if (this.finished) return operation();
    const phase = phases.has(name) ? name : "setup";
    this.phase = phase;
    this.boundaries.set(phase, "before");
    const id = ++this.operation;
    if (this.pending.size < 16) this.pending.set(id, phase);
    else this.observerErrors++;
    this.record({ kind: "fixture", stage: "before", operation: id });
    try {
      const value = operation();
      if (!(value instanceof Promise)) this.complete(phase, "settled", id);
      return value;
    } catch (error) { this.complete(phase, "threw", id); throw error; }
  }
  /** Call only after the caller's existing await actually completed successfully. */
  settled(name: string) { this.complete(name, "settled"); }
  private complete(phase: string, stage: string, operation?: number) {
    if (this.finished) return;
    const entry = [...this.pending].findLast(([id, name]) => name === phase && (operation === undefined || id === operation));
    if (!entry) return;
    const [id] = entry;
    this.pending.delete(id);
    this.boundaries.set(phase, stage);
    this.record({ kind: "fixture", stage, operation: id, operationPhase: phase });
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
    const browserVersions = [...this.connections].map(connection => connection.versionEvidence());
    let browserVersion = "not measured";
    const firstVersion = browserVersions[0]?.browserVersion;
    if (firstVersion !== undefined && firstVersion !== "not measured" && browserVersions.every(value => value.browserVersion === firstVersion)) browserVersion = firstVersion;
    this.emit({ chromeProtocolTrace: this.traceId, producer: this.producer, final: {
      browserVersion, browserVersionSource: browserVersion === "not measured" ? "not measured" : "matched-existing-CDP-response",
      browserVersions, browserVersionLimit: "Protocol response only; executable identity is not measured",
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
  private browserVersion = "not measured";
  private versionState = "not observed";
  private versionRequest: { id: number; session: string | null } | undefined;
  versionEvidence() {
    return { connection: this.ordinal, browserVersion: this.browserVersion, state: this.versionState,
      requestId: this.versionRequest?.id ?? null, session: this.versionRequest?.session ?? null };
  }
  private versionResponse(product: unknown, id: number, session: string | null, duplicate: boolean, eligible: boolean) {
    const valid = typeof product === "string" && /^(?:Chrome|HeadlessChrome)\/\d{1,3}(?:\.\d{1,6}){1,3}$/.test(product);
    if (!eligible || !valid) {
      this.browserVersion = "not measured";
      this.versionState = "invalid or incomplete matched response";
      this.versionRequest = undefined;
      return;
    }
    if (this.versionState === "conflicting matched responses" || this.versionState === "invalid or incomplete matched response") return;
    if (this.browserVersion !== "not measured" && this.browserVersion !== product) {
      this.browserVersion = "not measured";
      this.versionState = "conflicting matched responses";
      this.versionRequest = undefined;
      return;
    }
    if (duplicate) return;
    this.browserVersion = product;
    this.versionState = "matched existing response";
    this.versionRequest = { id, session };
  }
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
        if (sent === "Browser.getVersion") {
          const product = object(message.result) ? message.result.product : undefined;
          const valid = typeof product === "string" && /^(?:Chrome|HeadlessChrome)\/\d{1,3}(?:\.\d{1,6}){1,3}$/.test(product);
          if (valid) fields.browserVersion = product;
          this.versionResponse(product, id, session, fields.duplicateResponse === true,
            this.outcomes.get(key) === "returned" && this.overflow === 0 && message.error === undefined);
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
