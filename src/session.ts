import { mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { AccountLease } from "./profiles";
import { join } from "node:path";
import { BrowserBackend } from "./browser";
import { FedoraBackend } from "./fedora";
import { OrbitError, record, text } from "./errors";
import { resourceStatus } from "./resource-budget";
import { defaultViewport, parseViewport } from "./viewport";

type State = "running" | "pausing" | "paused" | "closing" | "closed";
interface Session {
  agentName: string; taskName: string; activity?: { type: string; actor: string; state: string; sequence: number };
  id: string; state: State; backend: BrowserBackend | FedoraBackend; kind: string; lease: string;
  tail: Promise<unknown>; paused?: Promise<unknown>; closing?: Promise<unknown>;
  observing?: Promise<unknown>; account?: AccountLease; releasing?: Promise<void>;
  requests: Map<string, { fingerprint: string; result: Promise<unknown> }>;
}
// Reported by doctor before any session exists. A live session reports its own backend's list.
const capabilities = ["navigate", "fill", "click", "scroll", "read", "select-tab", "close-tab", "resize", "observe", "pause", "resume", "stop"];
export class Sessions {
  private sessions = new Map<string, Session>();
  private leases = new Set<string>();
  private creating = new Set<Promise<unknown>>();
  private shuttingDown = false;
  constructor(private root: string, private accountRoot = process.env.ORBIT_ACCOUNT_DIR ?? join(homedir(), ".local/state/sbar-orbit/accounts")) {}
  private get(id: unknown): Session {
    const session = this.sessions.get(text(id, "sessionId"));
    if (!session) throw new OrbitError("SESSION_NOT_FOUND", "Unknown session");
    return session;
  }
  private ensureOpen(session: Session) {
    if (["closing", "closed"].includes(session.state)) throw new OrbitError("SESSION_CLOSED", "Session is closed");
  }
  private info(session: Session) { return { sessionId: session.id, state: session.state, backend: session.kind, agentName: session.agentName, taskName: session.taskName, activity: session.activity, accountName: session.account?.name, capabilities: session.backend.capabilities, surface: session.backend.surface }; }
  create(input: Record<string, unknown>): Promise<unknown> {
    if (this.shuttingDown) return Promise.reject(new OrbitError("SESSION_CLOSED", "Broker is stopping"));
    const operation = this.createOwned(input);
    this.creating.add(operation);
    operation.then(() => this.creating.delete(operation), () => this.creating.delete(operation));
    return operation;
  }
  private async createOwned(input: Record<string, unknown>) {
    if (!["browser", "fedora"].includes(String(input.backend))) throw new OrbitError("UNSUPPORTED", "Unknown backend");
    if (this.sessions.size + this.creating.size >= 32) throw new OrbitError("LIMIT_REACHED", "Restart the broker after 32 sessions");
    const label = (value: unknown, fallback: string) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
        throw new OrbitError("INVALID_REQUEST", "Session labels require 1 to 80 printable characters");
      return value.trim();
    };
    const agentName = label(input.agentName, "SbarOrbit"), taskName = label(input.taskName, "Agent workspace");
    const lease = input.profileKey === undefined ? crypto.randomUUID() : text(input.profileKey, "profileKey");
    if (this.leases.has(lease)) throw new OrbitError("PROFILE_BUSY", "Profile key is leased to another session");
    this.leases.add(lease);
    let account: AccountLease | undefined;
    try {
      if (input.accountName !== undefined) {
        if (input.backend !== "browser") throw new OrbitError("UNSUPPORTED", "Saved accounts require the browser backend");
        account = await AccountLease.acquire(this.accountRoot, input.accountName);
      }
      const restoredState = await account?.restore();
      const profile = await mkdtemp(join(this.root, "profile-"));
      const surface = input.viewport === undefined ? defaultViewport : parseViewport(input.viewport);
      const backend = input.backend === "fedora" ? await FedoraBackend.create(surface) : await BrowserBackend.create(profile, surface);
      if (account && backend instanceof BrowserBackend) {
        try { if (restoredState) await backend.context.setStorageState(restoredState); }
        catch (error) { await backend.close(); throw error; }
      }
      const id = crypto.randomUUID();
      const session: Session = { id, agentName, taskName, state: "running", backend, account, kind: String(input.backend), lease, tail: Promise.resolve(), requests: new Map() };
      this.sessions.set(id, session);
      backend.onClose(() => { session.state = "closed"; this.leases.delete(lease); session.releasing ??= session.tail.then(() => account?.release()); });
      account?.onLost(() => { void this.stop(session); });
      return this.info(session);
    } catch (error) {
      await account?.release();
      this.leases.delete(lease);
      const failure = error as { code?: string; syscall?: string } | null;
      if (failure?.code === "EAGAIN" && ["posix_spawn", "spawn"].includes(failure.syscall ?? ""))
        throw new OrbitError("RESOURCE_UNAVAILABLE", "The system could not start an Orbit process; release resources before retrying");
      throw error;
    }
  }
  private enqueue(session: Session, work: () => Promise<unknown>) {
    const result = session.tail.then(async () => {
      this.ensureOpen(session);
      try { return await work(); }
      catch (error) {
        this.ensureOpen(session);
        if (error instanceof Error && error.name === "TimeoutError") throw new OrbitError("DEADLINE_EXCEEDED", "Browser operation timed out");
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
    const action = session.backend.parseAction(input.action);
    const fingerprint = JSON.stringify(action);
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OrbitError("REQUEST_CONFLICT", "Request ID already used with different arguments");
      return existing.result;
    }
    if (session.state !== "running") throw new OrbitError("PAUSED", "Session is paused or pausing");
    if (session.requests.size >= 10000) throw new OrbitError("LIMIT_REACHED", "Session action limit reached");
    const result = this.enqueue(session, () => this.track(session, "agent", action.type, () => session.backend.act(action)));
    session.requests.set(requestId, { fingerprint, result });
    return result;
  }
  private async track(session: Session, actor: string, type: string, work: () => Promise<unknown>) {
    const activity = { actor, type, state: "working", sequence: (session.activity?.sequence ?? 0) + 1 };
    session.activity = activity;
    try { const result = await work(); activity.state = "done"; return result; }
    catch (error) { activity.state = "failed"; throw error; }
  }
  async stop(session: Session) {
    if (session.closing) return session.closing;
    if (session.state === "closed") { await session.releasing; return this.info(session); }
    session.state = "closing";
    session.closing = (async () => {
      await session.backend.close();
      await session.tail;
      await session.releasing;
      session.state = "closed";
      return this.info(session);
    })();
    return session.closing;
  }
  async dispatch(value: unknown): Promise<unknown> {
    const request = record(value);
    const params = request.params === undefined ? {} : record(request.params);
    if (request.method === "doctor") return { platform: process.platform, backend: "browser", backends: ["browser", "fedora"], capabilities, sessions: this.sessions.size, resources: await resourceStatus() };
    if (request.method === "session.create") return this.create(params);
    if (request.method === "session.list") return [...this.sessions.values()].map(s => this.info(s));
    if (request.method === "session.act") return this.act(params);
    if (!["session.pause", "session.resume", "session.stop", "session.observe", "session.control", "session.account.save"].includes(String(request.method))) throw new OrbitError("UNSUPPORTED", "Unknown method");
    const session = this.get(params.sessionId);
    if (request.method === "session.stop") return this.stop(session);
    this.ensureOpen(session);
    if (request.method === "session.account.save") {
      if (session.state !== "paused") throw new OrbitError("NOT_PAUSED", "Pause before saving account state");
      const { backend, account } = session;
      if (!(backend instanceof BrowserBackend) || !account) throw new OrbitError("UNSUPPORTED", "Create a browser session with accountName first");
      return this.enqueue(session, async () => {
        await account.save(await backend.context.storageState({ indexedDB: true }));
        return { saved: true, accountName: account.name };
      });
    }
    if (request.method === "session.control") {
      if (session.state !== "paused") throw new OrbitError("NOT_PAUSED", "Pause and wait for acknowledgement before manual input");
      return this.enqueue(session, () => this.track(session, "human", String(record(params.input).type), () => session.backend.control(params.input)));
    }
    if (request.method === "session.pause") {
      if (!session.paused) {
        session.state = "pausing";
        session.paused = session.tail.then(() => {
          this.ensureOpen(session); session.state = "paused"; return this.info(session);
        });
      }
      return session.paused;
    }
    if (request.method === "session.resume") {
      if (session.state === "pausing") throw new OrbitError("PAUSED", "Wait for pause acknowledgement before resuming");
      session.state = "running"; session.paused = undefined;
      return this.info(session);
    }
    // Capture is read-only and must not wait behind a locator action.
    session.observing ??= session.backend.observe().catch(error => {
      this.ensureOpen(session);
      throw error;
    }).finally(() => { session.observing = undefined; });
    return session.observing;
  }
  async close() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.creating]);
    await Promise.all([...this.sessions.values()].map(session => this.stop(session)));
  }
}
