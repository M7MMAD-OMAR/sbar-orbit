import { brokerIdentity } from "./managed-identity";
import { discoverApplications } from "./application-discovery";
import { managedUpdateRoot, requireUpdateAdmission } from "./update-admission";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NativeBackend, parseHandoff, parseNativeOpen, parseNativePresentation } from "./hyprland";
import { nativeOptionsFromEnv } from "./native-worker";
import { OrbitError, record, text } from "./errors";
import { resourceStatus } from "./resource-budget";
import { describeDesktopMachine } from "./desktop-machine";
import { decide, nativeApplicationPolicy, journalEntry, narrow, parseActionClasses, parseOrigins, parsePolicy, type JournalEntry, type SessionPolicy } from "./policy";
import { consultAdvisor } from "./advisor";
import { Diagnostics } from "./diagnostics";
import { autostartPaths } from "./autostart";

async function installedUnitDrift() {
  try {
    const { serviceUnitDrift } = await import("./service");
    const directory = autostartPaths().units;
    const drift = await serviceUnitDrift(directory);
    // Every unit absent means this is not a managed install, which is not drift and not worth a
    // remedy line telling a person to reinstall something they never installed.
    return drift.missing.length === 4 && !drift.drifted.length ? { managed: false } : { managed: true, ...drift };
  } catch { return undefined; }
}

type State = "running" | "pausing" | "paused" | "closing" | "closed";
interface Session {
  agentName: string; taskName: string; conversationName?: string; projectName?: string;
  activity?: { type: string; actor: string; state: string; sequence: number };
  createdAt: number; lastActivityAt: number;
  id: string; state: State; backend: NativeBackend; kind: "native"; lease: string;
  tail: Promise<unknown>; paused?: Promise<unknown>; closing?: Promise<unknown>; releasing?: Promise<void>;
  requests: Map<string, { fingerprint: string; result: Promise<unknown> }>;
  policy: SessionPolicy; journal: JournalEntry[]; journalPath: string; tainted: boolean;
}
const capabilities = ["windows", "cursor", "move", "click", "scroll", "text", "key", "state", "observe", "pause", "resume", "stop"];

const maxBatch = 16;
// The input actions that may share one call. Window metadata, state and closing stay single actions.
const batchable = ["click", "text", "key", "move", "scroll"];
// A click that moves keyboard focus into another process (a Firefox iframe) takes a moment to land.
// Keys sent in the same breath reach the old focus, so keyboard input right after a click waits briefly.
const clickFocusSettleMs = 200;
// A lost or failed commit may have reached the application, so these are never retried and the agent
// is told to inspect before sending more.
const uncertain = ["TIMEOUT", "DEADLINE_EXCEEDED", "BACKEND_ERROR", "NATIVE_FAILED"];
function expireCapture(result: unknown) {
  const body = record(result);
  if (!body.capture) return result;
  const { image: _image, ...frame } = record(body.capture);
  return { ...body, capture: { ...frame, expired: true } };
}

export class Sessions {
  private updateLease?: { token: string; expires: number };
  private sessions = new Map<string, Session>();
  private leases = new Set<string>();
  private creating = new Set<Promise<unknown>>();
  private creationTail: Promise<unknown> = Promise.resolve();
  private nativeOpens = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private nativePresentations = new Map<string, { fingerprint: string; result?: Promise<unknown> }>();
  private shuttingDown = false;
  private readonly releaseIdentity = brokerIdentity().catch(() => null);
  constructor(private root: string, _accountRoot?: string, readonly diagnostics = new Diagnostics(join(root, "diagnostics")), private native = nativeOptionsFromEnv(), private updateDirectory = managedUpdateRoot()) {}
  private get(id: unknown): Session {
    const session = this.sessions.get(text(id, "sessionId"));
    if (!session) throw new OrbitError("SESSION_NOT_FOUND", "Unknown session");
    return session;
  }
  private ensureOpen(session: Session) {
    if (["closing", "closed"].includes(session.state)) throw new OrbitError("SESSION_CLOSED", "Session is closed");
  }
  private info(session: Session) {
    return { sessionId: session.id, state: session.state, backend: "native", visible: true,
      agentName: session.agentName, taskName: session.taskName, conversationName: session.conversationName,
      projectName: session.projectName, activity: session.activity, createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt, capabilities: session.backend.capabilities,
      surface: session.backend.surface, policy: session.policy, handoff: session.backend.handoff };
  }
  create(input: Record<string, unknown>): Promise<unknown> {
    if (this.updateLease && this.updateLease.expires > Date.now())
      return Promise.reject(new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly"));
    if (this.shuttingDown) return Promise.reject(new OrbitError("SESSION_CLOSED", "Broker is stopping"));
    const operation = (async () => {
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
      return this.createOwned(input);
    })();
    this.creating.add(operation);
    operation.then(() => this.creating.delete(operation), () => this.creating.delete(operation));
    return operation;
  }
  private async createOwned(input: Record<string, unknown>) {
    if ((input.backend ?? "native") !== "native" || input.handoff === undefined)
      throw new OrbitError("UNSUPPORTED", "Private desktop sessions were removed. Use native.open for an original application or an explicit native application handoff.");
    const allowed = new Set(["backend", "agentName", "taskName", "conversationName", "projectName", "policy", "profileKey", "handoff"]);
    if (Object.keys(input).some(key => !allowed.has(key)))
      throw new OrbitError("UNSUPPORTED", "Private profiles, viewports and browser session options were removed");
    const handoff = parseHandoff(input.handoff);
    if (!this.native) throw new OrbitError("UNSUPPORTED", "The owner has not configured native application control");
    if (this.sessions.size + this.creating.size >= 32) throw new OrbitError("LIMIT_REACHED", "Native session limit reached");
    const label = (value: unknown, fallback: string) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
        throw new OrbitError("INVALID_REQUEST", "Session labels require 1 to 80 printable characters");
      return value.trim();
    };
    const suppliedPolicy = input.policy === undefined ? {} : record(input.policy);
    const policy = parsePolicy({ ...nativeApplicationPolicy, ...suppliedPolicy, origins: suppliedPolicy.origins === undefined ? "any" : suppliedPolicy.origins });
    if (policy.origins !== "any") throw new OrbitError("UNSUPPORTED", "Native origin enforcement is unavailable");
    const lease = input.profileKey === undefined ? crypto.randomUUID() : text(input.profileKey, "profileKey");
    if (this.leases.has(lease)) throw new OrbitError("PROFILE_BUSY", "Application lease is already held");
    const agentName = label(input.agentName, "SbarOrbit"), taskName = label(input.taskName, "Native application");
    const conversationName = input.conversationName === undefined ? undefined : label(input.conversationName, "");
    const projectName = input.projectName === undefined ? undefined : label(input.projectName, "");
    this.leases.add(lease);
    const options = this.native;
    const start = this.creationTail.then(async () => {
      await requireUpdateAdmission(this.updateDirectory);
      if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
      return NativeBackend.create("", options, handoff);
    });
    this.creationTail = start.catch(() => {});
    let backend: NativeBackend | undefined;
    try {
      backend = await start;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const id = crypto.randomUUID(), now = Date.now();
      const session: Session = { id, state: "running", backend, kind: "native", lease,
        agentName, taskName, conversationName, projectName, createdAt: now, lastActivityAt: now,
        tail: Promise.resolve(), requests: new Map(), policy, journal: [], tainted: false,
        journalPath: join(this.root, id + ".jsonl") };
      this.sessions.set(id, session);
      backend.onClose(() => { void this.stop(session).catch(() => {}); });
      return this.info(session);
    } catch (error) {
      this.leases.delete(lease);
      if (backend) await backend.close();
      throw error;
    }
  }
  private record(session: Session, entry: JournalEntry) {
    session.journal.push(entry);
    if (session.journal.length > 10000) session.journal.splice(0, session.journal.length - 10000);
    return appendFile(session.journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {});
  }
  private enqueue(session: Session, work: () => Promise<unknown>) {
    const result = session.tail.then(async () => {
      this.ensureOpen(session);
      try { return await work(); }
      catch (error) {
        this.ensureOpen(session);
        if (error instanceof Error && error.name === "TimeoutError") throw new OrbitError("DEADLINE_EXCEEDED", "Native operation timed out");
        throw error;
      }
    });
    session.tail = result.catch(() => {});
    return result;
  }
  act(input: Record<string, unknown>): Promise<unknown> {
    const session = this.get(input.sessionId);
    this.ensureOpen(session);
    const requestId = text(input.requestId, "requestId");
    if (input.actions !== undefined || input.capture !== undefined) return this.batch(session, input, requestId);
    const action = session.backend.parseAction(input.action);
    const fingerprint = JSON.stringify(action);
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OrbitError("REQUEST_CONFLICT", "Request ID already used with different arguments");
      return existing.result;
    }
    if (session.state !== "running") throw new OrbitError("PAUSED", "Session is paused or pausing");
    if (session.requests.size >= 10000) throw new OrbitError("LIMIT_REACHED", "Session action limit reached");
    const inputLength = "text" in action ? String(action.text ?? "").length : undefined;
    const result = this.decided(session, action, undefined, undefined, false, inputLength, requestId);
    session.requests.set(requestId, { fingerprint, result });
    return result;
  }
  private decided(session: Session, action: { type: string }, destination: string | undefined, method: string | undefined, methodIsImplied: boolean, inputLength: number | undefined, requestId: string): Promise<unknown> {
    return this.enqueue(session, this.admit(session, action, destination, method, methodIsImplied, inputLength, requestId));
  }
  /** Decide and journal now; the returned work runs the action later, in the session's queue. */
  private admit(session: Session, action: { type: string }, destination: string | undefined, method: string | undefined, methodIsImplied: boolean, inputLength: number | undefined, requestId: string): () => Promise<unknown> {
    const record = (decision: ReturnType<typeof decide>, decidedBy?: string, after?: SessionPolicy) => {
      void this.record(session, journalEntry({
        at: new Date().toISOString(), requestId,
        sequence: session.journal.length + 1, sessionId: session.id, actor: "agent",
        actionType: action.type, decision, url: destination,
        ...(decidedBy === undefined ? {} : { decidedBy }),
        ...(inputLength === undefined ? {} : { inputLength }),
        ...(after === undefined ? {} : { after }),
      }));
    };
    const refuse = (decision: Extract<ReturnType<typeof decide>, { outcome: "deny" }>, decidedBy?: string) => {
      // An immune deny contains the session as well as refusing the action. An autonomous agent that
      // has just attempted a credential change is either compromised or wrong, and in both cases the
      // next action should not run either. Narrowing is one way, so this cannot be undone.
      //
      // The line is written after the containment rather than before it, so it carries the boundary the
      // session is left with. A reader following an autonomous run should not have to replay the rule to
      // know what was still permitted afterwards.
      if (decision.immuneId) {
        // `read` only. It used to keep `navigate` too, which left a session that had just attempted
        // a money movement or a credential change still able to walk the agent anywhere inside its
        // origin allowlist. The containment fires precisely when the agent is either compromised or
        // wrong, and a compromised agent choosing the next page is the thing to stop. Reading what
        // is already on screen is what a person needs to see what happened.
        session.policy = narrow(session.policy, { allow: ["read"] });
        record(decision, decidedBy, session.policy);
      } else record(decision, decidedBy);
      throw new OrbitError("POLICY_DENIED", decision.reason);
    };
    const decision = decide(session.policy, action.type, destination, method, methodIsImplied);
    if (decision.outcome !== "consult") {
      if (decision.outcome === "deny") refuse(decision);
      record(decision);
      // A supervised session stops and waits for the person. An autonomous one never reaches here
      // with anything but an allow, which is what lets it finish a task without them.
      if (decision.outcome === "ask") throw new OrbitError("POLICY_CONFIRMATION_REQUIRED", decision.reason);
      return () => this.track(session, "agent", action.type, () => this.guarded(session, action));
    }
    // Accepted advisor work belongs to the same queue that pause drains. Otherwise a late allow
    // could apply input after pause has acknowledged that no agent work remains.
    return async () => {
      const pending = journalEntry({
        sequence: session.journal.length + 1, sessionId: session.id, actor: "agent",
        actionType: action.type, decision, url: destination,
        ...(inputLength === undefined ? {} : { inputLength }),
      });
      const answer = await consultAdvisor(session.policy.advisor!, {
        pending, tail: session.journal.slice(-20), reason: decision.reason, ruleId: decision.ruleId,
      });
      this.ensureOpen(session);
      if (answer.decision.outcome === "deny") return refuse(answer.decision, answer.decidedBy);
      record(answer.decision, answer.decidedBy);
      return this.track(session, "agent", action.type, () => this.guarded(session, action));
    };
  }
  /**
   * Several input actions in one call, in order, with one settled capture at the end.
   *
   * Every action is judged by the same policy, lease and guarded target path as a lone action. The
   * whole list is checked before any input is delivered, and again at its own turn, because a policy
   * can narrow in between. The first failure stops the list; actions after it are reported as not
   * attempted, never retried, and a lost reply is reported as uncertain rather than replayed.
   */
  private batch(session: Session, input: Record<string, unknown>, requestId: string): Promise<unknown> {
    if ((input.action === undefined) === (input.actions === undefined))
      throw new OrbitError("INVALID_REQUEST", "Give exactly one of action or actions");
    const raw = input.actions === undefined ? [input.action] : input.actions;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > maxBatch)
      throw new OrbitError("INVALID_REQUEST", `actions must hold 1 to ${maxBatch} native actions`);
    const actions = raw.map(value => session.backend.parseAction(value));
    for (const action of actions) {
      if (!batchable.includes(action.type)) throw new OrbitError("INVALID_REQUEST", `${String(action.type).slice(0, 40)} cannot be batched or captured; send it alone`);
      if (action.appId !== actions[0]!.appId || action.windowId !== actions[0]!.windowId)
        throw new OrbitError("INVALID_REQUEST", "A batch acts on one window");
    }
    let capture: { timeoutMs: number } | undefined;
    if (input.capture !== undefined) {
      const options = record(input.capture);
      if (Object.keys(options).some(key => key !== "timeoutMs") ||
          (options.timeoutMs !== undefined && (typeof options.timeoutMs !== "number" || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 3000)))
        throw new OrbitError("INVALID_REQUEST", "capture accepts only timeoutMs, an integer from 100 to 3000");
      capture = { timeoutMs: options.timeoutMs ?? 1500 };
    }
    const fingerprint = JSON.stringify({ actions, capture });
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OrbitError("REQUEST_CONFLICT", "Request ID already used with different arguments");
      return existing.result;
    }
    if (session.state !== "running") throw new OrbitError("PAUSED", "Session is paused or pausing");
    if (session.requests.size >= 10000) throw new OrbitError("LIMIT_REACHED", "Session action limit reached");
    for (const action of actions) {
      const decision = decide(session.policy, action.type);
      if (decision.outcome === "consult") throw new OrbitError("INVALID_REQUEST", "This action needs an advisor decision; send it alone");
      if (decision.outcome !== "allow") this.admit(session, action, undefined, undefined, false, undefined, requestId);
    }
    const full = this.enqueue(session, () => this.runBatch(session, actions, capture, requestId));
    // The replay keeps receipts and frame metadata, never pixels: ten thousand cached frames would be
    // a leak, and a replay must not re-execute anything to get one back.
    const kept = full.then(result => expireCapture(result));
    kept.catch(() => {});
    session.requests.set(requestId, { fingerprint, result: kept });
    return full;
  }
  private async runBatch(session: Session, actions: { type: string; [key: string]: unknown }[], capture: { timeoutMs: number } | undefined, requestId: string) {
    const target = { appId: String(actions[0]!.appId), windowId: String(actions[0]!.windowId) };
    const observing = capture === undefined ? undefined : decide(session.policy, "observe");
    let since: string | undefined;
    if (observing?.outcome === "allow") {
      // Before the first input, so a frame that differs from it can only be the result of the batch.
      try { since = await session.backend.baseline(target); } catch { since = undefined; }
    }
    const receipts: Record<string, unknown>[] = [];
    let stopped: string | undefined;
    for (const [index, action] of actions.entries()) {
      const base = { index, type: action.type };
      if (stopped === undefined && (session.state as State) !== "running") stopped = "PAUSED";
      if (stopped !== undefined) { receipts.push({ ...base, status: "not-attempted", reason: stopped }); continue; }
      try {
        if (actions[index - 1]?.type === "click" && (action.type === "text" || action.type === "key")) await new Promise(resolve => setTimeout(resolve, clickFocusSettleMs));
        const inputLength = "text" in action ? String(action.text ?? "").length : undefined;
        const result = await this.admit(session, action, undefined, undefined, false, inputLength, requestId)();
        receipts.push({ ...base, status: "ok", result });
      } catch (error) {
        this.ensureOpen(session);
        const code = error instanceof OrbitError ? error.code : error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "BACKEND_ERROR";
        const message = error instanceof OrbitError ? error.message : "Native action failed";
        const status = code.startsWith("POLICY_") ? "refused" : uncertain.includes(code) ? "uncertain" : "failed";
        receipts.push({ ...base, status, error: { code, message } });
        stopped = status === "uncertain" ? "PRIOR_UNCERTAIN" : "PRIOR_FAILED";
      }
    }
    const completed = receipts.filter(receipt => receipt.status === "ok").length;
    const result: Record<string, unknown> = { ok: completed === actions.length, completed, receipts };
    if (capture !== undefined) {
      if (observing?.outcome !== "allow") result.captureError = { code: "POLICY_DENIED", message: "Observation is not allowed for this session" };
      else if (receipts.every(receipt => receipt.status === "not-attempted")) result.captureError = { code: "NOT_ATTEMPTED", message: "No action ran, so there is nothing new to capture" };
      else {
        try {
          result.capture = await session.backend.observe(target, "image", { ...(since === undefined ? {} : { since }), timeoutMs: capture.timeoutMs });
          this.taintedBy(session, "observe");
          void this.record(session, journalEntry({
            at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
            actor: "agent", actionType: "observe", decision: { outcome: "allow" },
          }));
        } catch (error) {
          this.ensureOpen(session);
          result.captureError = { code: error instanceof OrbitError ? error.code : "BACKEND_ERROR",
            message: error instanceof OrbitError ? error.message : "Capture failed; observe separately" };
        }
      }
    }
    return result;
  }
  private taintedBy(session: Session, actionType: string) {
    if (["observe", "windows", "state"].includes(actionType)) session.tainted = true;
  }
  private async guarded(session: Session, action: { type: string }) {
    this.ensureOpen(session);
    const result = await session.backend.act(action);
    this.taintedBy(session, action.type);
    return result;
  }
  private async track(session: Session, actor: string, type: string, work: () => Promise<unknown>) {
    const activity = { actor, type, state: "working", sequence: (session.activity?.sequence ?? 0) + 1 };
    session.activity = activity;
    // Stamped at both ends. The activity object is mutated in place when the work settles, so a
    // single stamp at the start would leave "last activity" frozen at the moment a long action
    // began, which is the one reading a person would call wrong.
    session.lastActivityAt = Date.now();
    try { const result = await work(); activity.state = "done"; return result; }
    catch (error) { activity.state = "failed"; throw error; }
    finally { session.lastActivityAt = Date.now(); }
  }
  async stop(session: Session) {
    if (session.closing) return session.closing;
    if (session.state === "closed") return this.info(session);
    session.state = "closing";
    session.closing = (async () => {
      await session.backend.close();
      await session.tail;
      this.leases.delete(session.lease);
      session.state = "closed";
      session.lastActivityAt = Date.now();
      return this.info(session);
    })();
    const closing = session.closing;
    void closing.catch(() => { if (session.closing === closing) session.closing = undefined; });
    return closing;
  }
  async dispatch(value: unknown): Promise<unknown> {
    if (value && typeof value === "object" && "method" in value && value.method === "diagnostics.report") return this.diagnostics.report();
    if (value && typeof value === "object" && "method" in value && value.method === "diagnostics.status") return this.diagnostics.status();
    const request = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const session = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    return this.diagnostics.run({ ...request, params: { ...params, backend: session?.kind ?? params.backend } }, () => this.dispatchRequest(value));
  }
  private async dispatchRequest(value: unknown): Promise<unknown> {
    const request = record(value);
    const params = request.params === undefined ? {} : record(request.params);
    if (request.method === "applications.list") {
      if (Object.keys(params).some(key => key !== "query") ||
          (params.query !== undefined && (typeof params.query !== "string" || params.query.length > 80)))
        throw new OrbitError("INVALID_REQUEST", "Application discovery accepts only an optional query up to 80 characters");
      return discoverApplications({ query: params.query as string | undefined });
    }
    if (request.method === "update.begin") {
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "Another update is in progress");
      if (this.creating.size || [...this.sessions.values()].some(session => session.state !== "closed"))
        throw new OrbitError("PROFILE_BUSY", "A session is open or starting; update waits until it closes");
      this.updateLease = { token: crypto.randomUUID(), expires: Date.now() + 120_000 };
      return this.updateLease;
    }
    if (request.method === "update.end") {
      if (params.token === this.updateLease?.token) this.updateLease = undefined;
      return { released: !this.updateLease };
    }
    // Doctor is what a person on an unverified platform runs first, and what a community bug report
    // is built from, so it carries the probed capabilities rather than an assumption about Linux.
    if (request.method === "doctor") return { managedIdentity: await this.releaseIdentity,
      version: (await import("../package.json")).version, platform: process.platform, backend: "native",
      backends: this.native ? ["native"] : [], sessionMode: "native-only", capabilities,
      sessions: this.sessions.size, resources: await resourceStatus(), machine: await describeDesktopMachine(),
      units: process.platform === "linux" ? await installedUnitDrift() : undefined };
    if (request.method === "session.create") return this.create(params);
    if (request.method === "native.open") {
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
      if (!this.native) throw new OrbitError("UNSUPPORTED", "Native opening is not configured");
      if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
      const requestId = text(params.requestId, "requestId");
      if (requestId.length > 128) throw new OrbitError("INVALID_REQUEST", "Opening request identity is too long");
      if (Object.keys(params).some(key => !["requestId", "workspace", "applicationId", "window"].includes(key)))
        throw new OrbitError("INVALID_REQUEST", "Unknown native opening field");
      const opening = parseNativeOpen({ workspace: params.workspace, applicationId: params.applicationId, ...(params.window === undefined ? {} : { window: params.window }) });
      const fingerprint = JSON.stringify(opening);
      const previous = this.nativeOpens.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new OrbitError("REQUEST_CONFLICT", "Opening request identity conflicts");
        return previous.result;
      }
      if (this.nativeOpens.size >= 256) throw new OrbitError("LIMIT_REACHED", "Native opening request limit reached");
      const options = this.native;
      const result = this.creationTail.then(async () => {
        await requireUpdateAdmission(this.updateDirectory);
        if (this.updateLease && this.updateLease.expires > Date.now())
          throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
        if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
        return NativeBackend.openApplication(options, opening);
      });
      this.creationTail = result.catch(() => {});
      this.nativeOpens.set(requestId, { fingerprint, result });
      this.creating.add(result);
      void result.then(() => this.creating.delete(result), () => this.creating.delete(result));
      void result.catch(error => {
        if (error instanceof OrbitError && error.code === "APPROVAL_REQUIRED") this.nativeOpens.delete(requestId);
      });
      return result;
    }
    if (request.method === "native.candidates") {
      if (!this.native) throw new OrbitError("UNSUPPORTED", "Native handoff is not configured");
      return NativeBackend.candidates(this.native, parseHandoff(params));
    }
    if (request.method === "native.monitors" || request.method === "native.present") {
      const presentation = request.method === "native.present";
      let requestId = "", selected: ReturnType<typeof parseNativePresentation> | undefined;
      if (presentation) {
        if (Object.keys(params).some(key => !["requestId", "workspace", "monitor"].includes(key)))
          throw new OrbitError("INVALID_REQUEST", "Unknown native presentation field");
        requestId = text(params.requestId, "requestId");
        if (requestId.length > 128) throw new OrbitError("INVALID_REQUEST", "Presentation request identity is too long");
        selected = parseNativePresentation({ workspace: params.workspace, monitor: params.monitor });
      } else if (Object.keys(params).length) {
        throw new OrbitError("INVALID_REQUEST", "Monitor discovery accepts no parameters");
      }
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
      if (!this.native) throw new OrbitError("UNSUPPORTED", "Native monitor control is not configured");
      if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
      const fingerprint = selected ? JSON.stringify(selected) : "";
      if (presentation) {
        const previous = this.nativePresentations.get(requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new OrbitError("REQUEST_CONFLICT", "Presentation request identity conflicts");
          if (previous.result) return previous.result;
        }
        if (!previous && this.nativePresentations.size >= 256) throw new OrbitError("LIMIT_REACHED", "Native presentation request limit reached");
      }
      const options = this.native, target = selected;
      let dispatched = false;
      const result = this.creationTail.then(async () => {
        await requireUpdateAdmission(this.updateDirectory);
        if (this.updateLease && this.updateLease.expires > Date.now())
          throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
        if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
        if (target) {
          dispatched = true;
          return NativeBackend.present(options, target);
        }
        return NativeBackend.monitors(options);
      });
      this.creationTail = result.catch(() => {});
      if (presentation) {
        this.nativePresentations.set(requestId, { fingerprint, result });
        void result.catch(error => {
          if (this.nativePresentations.get(requestId)?.result !== result) return;
          if (!dispatched || (error instanceof OrbitError && error.code === "PRESENTATION_NOT_READY"))
            this.nativePresentations.set(requestId, { fingerprint });
          else if (error instanceof OrbitError && ["APPROVAL_REQUIRED", "NATIVE_INCOMPATIBLE"].includes(error.code))
            this.nativePresentations.delete(requestId);
        });
      }
      this.creating.add(result);
      void result.then(() => this.creating.delete(result), () => this.creating.delete(result));
      return result;
    }
    if (request.method === "session.list") return [...this.sessions.values()].map(s => this.info(s));
    if (request.method === "session.act") return this.act(params);
    /*
     * Removing a finished session from the list, which is the only thing a person can still do to
     * one. It drops the entry and nothing else: the journal file stays where it is, because that
     * record is what a run is reviewed from afterwards and a person tidying their list is not
     * asking to lose it. An id nobody knows succeeds quietly, so a second click on a card that has
     * already gone is not an error on screen.
     */
    if (request.method === "session.forget") {
      const id = text(params.sessionId, "sessionId");
      const known = this.sessions.get(id);
      if (known && known.state !== "closed") throw new OrbitError("SESSION_OPEN", "End the session before removing it from the list");
      if (known) {
        // A backend exit marks it closed before asynchronous resource release finishes.
        // Keep the entry if cleanup fails so stop and broker shutdown still report it.
        await known.releasing;
        this.sessions.delete(id);
      }
      return { sessionId: id, forgotten: known !== undefined };
    }
    if (!["session.pause", "session.resume", "session.stop", "session.observe", "session.presence", "session.control", "session.journal", "session.narrow"].includes(String(request.method))) throw new OrbitError("UNSUPPORTED", "Unknown method");
    const session = this.get(params.sessionId);
    // What the session did, for a person reading afterwards rather than approving in advance.
    if (request.method === "session.journal") return { sessionId: session.id, policy: session.policy,
      entries: session.journal, path: session.journalPath, tainted: session.tainted };
    // Narrowing only. There is deliberately no method that widens a running session, because the
    // value of the allowlist is that a page the agent reads cannot cause it to grow.
    if (request.method === "session.narrow") {
      if (session.backend instanceof NativeBackend && params.origins !== undefined)
        throw new OrbitError("UNSUPPORTED", "Native network origin enforcement is not implemented; narrow action classes instead");
      if (params.origins === undefined && params.allow === undefined)
        throw new OrbitError("INVALID_REQUEST", "Narrowing needs origins, allow, or both");
      // Validated field by field. Going through parsePolicy would apply its cross field rule, which
      // requires an origin whenever navigate is allowed, and that rule is about creating a session
      // rather than about tightening one.
      const limits = {
        ...(params.origins === undefined ? {} : { origins: parseOrigins(params.origins) }),
        ...(params.allow === undefined ? {} : { allow: parseActionClasses(params.allow) }),
      };
      session.policy = narrow(session.policy, limits);
      // Recorded so a reader can see that a narrowing happened, and whether it happened before or
      // after a page had spoken to the session.
      void this.record(session, journalEntry({
        at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
        actor: "person", actionType: "session.narrow",
        decision: { outcome: "allow" }, after: session.policy,
      }));
      return { sessionId: session.id, policy: session.policy, tainted: session.tainted };
    }
    if (request.method === "session.stop") return this.stop(session);
    this.ensureOpen(session);
    // Presence is what a desktop indicator polls, so it must not cost a frame or wait behind an action.
    if (request.method === "session.presence") return session.backend.presence().catch(error => { this.ensureOpen(session); throw error; });
    if (request.method === "session.control") {
      if (session.state !== "paused") throw new OrbitError("NOT_PAUSED", "Pause and wait for acknowledgement before manual input");
      return this.enqueue(session, () => this.track(session, "human", String(record(params.input).type), () => session.backend.control(params.input)));
    }
    if (request.method === "session.pause") {
      if (!session.paused) {
        session.state = "pausing";
        session.paused = session.tail.then(async () => {
          this.ensureOpen(session);
          if (session.backend instanceof NativeBackend) await session.backend.pauseLease();
          this.ensureOpen(session);
          session.state = "paused"; return this.info(session);
        }).catch(error => { session.paused = undefined; throw error; });
      }
      return session.paused;
    }
    if (request.method === "session.resume") {
      if (session.state === "pausing") throw new OrbitError("PAUSED", "Wait for pause acknowledgement before resuming");
      if (session.backend instanceof NativeBackend) await session.backend.resumeLease();
      this.ensureOpen(session);
      // Other requests can change the state while the native response is pending.
      if ((session.state as State) === "pausing") throw new OrbitError("PAUSED", "A newer pause is awaiting acknowledgement");
      session.state = "running"; session.paused = undefined;
      return this.info(session);
    }
    const decision = decide(session.policy, "observe");
    if (decision.outcome === "deny") {
      void this.record(session, journalEntry({
        at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
        actor: "agent", actionType: "observe", decision, after: session.policy,
      }));
      throw new OrbitError("POLICY_DENIED", decision.reason);
    }
    if (Object.keys(params).some(key => !["sessionId", "appId", "windowId", "format"].includes(key)))
      throw new OrbitError("INVALID_REQUEST", "Unknown native observation fields");
    if (params.format !== undefined && !["image", "text", "both"].includes(String(params.format)))
      throw new OrbitError("INVALID_REQUEST", "Observation format must be image, text or both");
    const selected = params.appId === undefined && params.windowId === undefined ? undefined
      : { appId: params.appId, windowId: params.windowId };
    const frame = await session.backend.observe(selected, params.format as "image" | "text" | "both" | undefined);
    this.taintedBy(session, "observe");
    return frame;
  }
  async close() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.creating]);
    const results = await Promise.allSettled([...this.sessions.values()].map(session => this.stop(session)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Native application handback remains incomplete");
  }
}
