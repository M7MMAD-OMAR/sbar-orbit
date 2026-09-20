import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { AccountLease } from "./profiles";
import { join } from "node:path";
import { BrowserBackend } from "./browser";
import { FedoraBackend } from "./fedora";
import { OrbitError, record, text } from "./errors";
import { resourceStatus } from "./resource-budget";
import { describeMachine, detectPlatform, type PlatformCapabilities } from "./platform";
import { openEgressLease, type EgressLease } from "./egress";
import { defaultChromeExecutable } from "./chrome";
import { cloneProfile } from "./clone";
import { decide, freshProfilePolicy, journalEntry, narrow, parseActionClasses, parseOrigins, parsePolicy, type JournalEntry, type SessionPolicy } from "./policy";
import { consultAdvisor } from "./advisor";
import { canRestoreTo, clearRestorePoints, createSubvolume, removeRestorePoint, restoreProfile, takeRestorePoint, type RestorePoint } from "./restore";
import { defaultViewport, parseViewport } from "./viewport";
import { Diagnostics } from "./diagnostics";

/**
 * The installed units against the ones this version writes, for `doctor`.
 *
 * Wrapped here rather than called directly so the unit directory is resolved the same way
 * `src/install.ts` resolves it, `ORBIT_UNIT_DIR` included, and so a machine with no unit directory
 * at all reports nothing rather than failing the whole doctor call: a broker started with
 * `ORBIT_SOCKET` and no install is a supported way to run, and it has no units by design.
 */
async function installedUnitDrift() {
  try {
    const { serviceUnitDrift } = await import("./service");
    const directory = process.env.ORBIT_UNIT_DIR ?? join(homedir(), ".config/systemd/user");
    const drift = await serviceUnitDrift(directory);
    // Every unit absent means this is not a managed install, which is not drift and not worth a
    // remedy line telling a person to reinstall something they never installed.
    return drift.missing.length === 4 && !drift.drifted.length ? { managed: false } : { managed: true, ...drift };
  } catch { return undefined; }
}

type State = "running" | "pausing" | "paused" | "closing" | "closed";
interface Session {
  agentName: string; taskName: string; conversationName?: string; projectName?: string; activity?: { type: string; actor: string; state: string; sequence: number };
  /**
   * When the session opened and when something last happened in it, as epoch milliseconds. The
   * viewer sorts and dates its cards from these: without them a person running several agents reads
   * a list in creation order with nothing saying which one moved a minute ago and which one has been
   * finished since the morning.
   */
  createdAt: number; lastActivityAt: number;
  id: string; state: State; backend: BrowserBackend | FedoraBackend; kind: string; lease: string; profile: string;
  tail: Promise<unknown>; paused?: Promise<unknown>; closing?: Promise<unknown>;
  observing?: Promise<unknown>; account?: AccountLease; releasing?: Promise<void>;
  requests: Map<string, { fingerprint: string; result: Promise<unknown> }>;
  /** Fixed when the session is created. Never widened, so a page cannot enlarge it. */
  policy: SessionPolicy;
  journal: JournalEntry[];
  /** Releases anything the clone needed, such as its filtered secret bus. */
  releaseClone?: () => Promise<void>;
  /**
   * Which layer held this session's origin lease, and the lease itself where it is held below the
   * browser. A reader of the journal must be able to tell the two apart: one holds a page that
   * misbehaves, the other holds a browser that does.
   */
  egress: EgressLease;
  /** Off-lease requests the page itself made, which no agent action would show. */
  blockedOrigins: string[];
  /**
   * Where the durable copy of the journal is appended. The in-memory list answers the API, and this
   * is what is left afterwards: an autonomous run is reviewed after it finishes, and a record that
   * dies with the broker cannot be reviewed at all. It lives outside the session profile, which is
   * deleted when the session stops.
   */
  journalPath: string;
  /** Where this session's restore points live. Cleared when it ends: each one is a copy of live cookies. */
  restoreStore: string;
  restorePoints: RestorePoint[];
  /**
   * Set the first time an observation returns page content, and never cleared.
   *
   * Before it, the session has only seen what the person asked for. After it, everything the agent
   * decides has been influenced by something a page said, so a widening request from that point on
   * is a request the page may have written. There is no widening path to guard, by design, and this
   * is what makes that a property rather than an accident: it is recorded, so the journal shows
   * which side of the line every decision fell on.
   */
  tainted: boolean;
  /**
   * Start another browser on the same profile, for a restore. The policy and the surface are read at
   * call time rather than captured here: a restored session that came back with the boundary it was
   * created with, rather than the one it currently holds, would undo a narrowing silently.
   */
  relaunch?: () => Promise<BrowserBackend>;
  /** Registered on every backend a session owns, including one started by a restore. */
  reap?: () => void;
  /**
   * Set while a restore is deliberately closing the browser, so the close is not mistaken for the end
   * of the session and does not take the profile with it. Cleared whether the relaunch worked or not.
   */
  restoring?: boolean;
}
// Reported by doctor before any session exists. A live session reports its own backend's list.
const capabilities = ["navigate", "fill", "click", "scroll", "read", "open-tab", "select-tab", "close-tab", "resize", "observe", "pause", "resume", "stop"];
/**
 * The HTTP method a browser action implies, for rules that name one.
 *
 * A navigation is a GET and a form submission is a POST. Neither action carries the method in its
 * payload, so without this a rule spelled `{ verb: "navigate", method: "GET" }` is accepted, held,
 * and matches nothing: it fails open while reading as enforced.
 *
 * Only the verbs whose method is unambiguous are listed. A click can trigger anything or nothing, so
 * it is left undefined rather than guessed: claiming a method for it would make rules fire on
 * actions they do not describe, which is the opposite defect and the more dangerous one.
 */
function impliedMethod(actionType: string): string | undefined {
  if (actionType === "navigate") return "GET";
  if (actionType === "submit") return "POST";
  return undefined;
}

export class Sessions {
  private updateLease?: { token: string; expires: number };
  private sessions = new Map<string, Session>();
  private leases = new Set<string>();
  private creating = new Set<Promise<unknown>>();
  // Backends start one at a time. Several agents creating sessions in the same second is common,
  // and several Chromes or compositors booting together on one core made each other time out
  // where one after another all start; the queue costs the later ones only the earlier ones' start.
  private creationTail: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  /**
   * Probed once. The probe starts a sandbox to find out whether it can, and a session creation is not
   * the place to pay for that repeatedly; nothing it reports changes while the broker runs.
   */
  private probed?: Promise<PlatformCapabilities>;
  constructor(private root: string, private accountRoot = process.env.ORBIT_ACCOUNT_DIR ?? join(homedir(), ".local/state/sbar-orbit/accounts"), readonly diagnostics = new Diagnostics(join(root, "diagnostics"))) {}
  private capabilities() { return this.probed ??= detectPlatform(); }
  /** Where a session's route out lives. Short, because what goes in it are unix sockets. */
  private get egressRoot() { return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "sbar-orbit", "egress"); }
  private get(id: unknown): Session {
    const session = this.sessions.get(text(id, "sessionId"));
    if (!session) throw new OrbitError("SESSION_NOT_FOUND", "Unknown session");
    return session;
  }
  private ensureOpen(session: Session) {
    if (["closing", "closed"].includes(session.state)) throw new OrbitError("SESSION_CLOSED", "Session is closed");
  }
  private info(session: Session) { return { sessionId: session.id, state: session.state, backend: session.kind, agentName: session.agentName, taskName: session.taskName, conversationName: session.conversationName, projectName: session.projectName, activity: session.activity, createdAt: session.createdAt, lastActivityAt: session.lastActivityAt, accountName: session.account?.name, capabilities: session.backend.capabilities, surface: session.backend.surface, policy: session.policy, egressTier: session.egress.tier, ...("renderer" in session.backend ? { renderer: session.backend.renderer, compositorPid: session.backend.compositorPid } : {}) }; }
  create(input: Record<string, unknown>): Promise<unknown> {
    if (this.updateLease && this.updateLease.expires > Date.now())
      return Promise.reject(new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly"));
    if (this.shuttingDown) return Promise.reject(new OrbitError("SESSION_CLOSED", "Broker is stopping"));
    const operation = this.createOwned(input);
    this.creating.add(operation);
    operation.then(() => this.creating.delete(operation), () => this.creating.delete(operation));
    return operation;
  }
  private async createOwned(input: Record<string, unknown>) {
    // `system` is accepted for the private display, because a caller should not have to name a
    // distribution to ask for one. It is an alias and nothing more: the backend still needs the
    // wlroots runtime this project builds, and everything reported back says `fedora`, so status,
    // observation and the journal keep one name for one thing.
    const requested = String(input.backend) === "system" ? "fedora" : String(input.backend);
    if (!["browser", "fedora"].includes(requested)) throw new OrbitError("UNSUPPORTED", "Unknown backend");
    input = { ...input, backend: requested };
    if (this.sessions.size + this.creating.size >= 32) throw new OrbitError("LIMIT_REACHED", "Restart the broker after 32 sessions");
    const label = (value: unknown, fallback: string) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
        throw new OrbitError("INVALID_REQUEST", "Session labels require 1 to 80 printable characters");
      return value.trim();
    };
    const agentName = label(input.agentName, "SbarOrbit"), taskName = label(input.taskName, "Agent workspace");
    const conversationName = input.conversationName === undefined ? undefined : label(input.conversationName, "");
    const projectName = input.projectName === undefined ? undefined : label(input.projectName, "");
    // Parsed before anything is started, so an unusable policy fails the request rather than a later action.
    const policy = input.policy === undefined ? freshProfilePolicy : parsePolicy(input.policy);
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
      // A plain directory cannot be snapshotted, so the profile is made a subvolume where the
      // filesystem allows it. Where it does not, restore points are simply absent rather than
      // promised and missing.
      const snapshotCapable = await createSubvolume(profile);
      const surface = input.viewport === undefined ? defaultViewport : parseViewport(input.viewport);
      // A session may start from the person's own browser profile instead of an empty one. The policy
      // is checked before anything is copied, because an unbounded session holding real logins is the
      // case the policy exists to prevent.
      if (input.cloneOf !== undefined && input.backend !== "browser") throw new OrbitError("UNSUPPORTED", "Cloning a profile requires the browser backend");
      if (input.cloneOf !== undefined && account) throw new OrbitError("INVALID_REQUEST", "A session takes either a saved account or a cloned profile, not both");
      const clone = input.cloneOf === undefined ? undefined : await cloneProfile(text(input.cloneOf, "cloneOf"), profile, policy);
      // The person's extensions travel with the clone by default. `cloneExtensions: false` leaves them
      // dormant, for a caller that wants the logins and not the add-ons: measured 14 September 2026, a
      // proxy extension in the person's profile set its own proxy inside the confined clone, where the
      // only route out is the lease's proxy, and every origin then failed as disconnected. Failing closed
      // is the lease working; a session that wanted the account still needs a way past the add-on.
      if (clone && input.cloneExtensions === false) clone.launch.extensions = false;
      // Requests the PAGE made and the lease refused. The agent never asked for these, so they are
      // recorded separately from its own denied actions.
      const blockedOrigins: string[] = [];
      // The lease below the browser, opened before the browser so the browser has somewhere to go.
      //
      // Only for a session whose origins are bounded: with "any" there is nothing to enforce, and a
      // namespace whose proxy forwards everything would add a hop and no boundary. That is also what
      // keeps every existing session on the path it was measured on, since a fresh profile is "any".
      //
      // The origin set is read on every request rather than copied here, so `session.narrow` and an
      // immune deny tighten this layer too. A live session's policy is the one that decides.
      let live: Session | undefined;
      // Named after the session's own id, which Orbit generated. The profile key is a label a caller
      // chose, and a directory path built from one is a path a caller chose.
      const id = crypto.randomUUID();
      const egress = input.backend !== "browser" || policy.origins === "any" ? undefined : await openEgressLease({
        // Not under the workspace root: these are sockets, a unix socket path is capped at 108 bytes,
        // and a workspace path plus a session id already spends most of that. The runtime directory is
        // short, private to this user, and cleared when the session ends.
        directory: join(this.egressRoot, id.slice(0, 8)),
        executable: clone?.launch.executable ?? defaultChromeExecutable() ?? "",
        profile,
        confinable: (await this.capabilities()).confinedEgress,
        origins: () => {
          const current = live?.policy.origins ?? policy.origins;
          return current === "any" ? [] : current;
        },
      });
      const queued = Date.now();
      const start = this.creationTail.then(async (): Promise<BrowserBackend | FedoraBackend> => {
        // A caller's request has a deadline of its own; do not start a backend nobody is waiting for.
        if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
        if (Date.now() - queued > 30000) throw new OrbitError("DEADLINE_EXCEEDED", "Other sessions were still starting; retry");
        return requested === "fedora" ? await FedoraBackend.create(surface)
          : await BrowserBackend.create(profile, surface, clone?.launch, policy.origins, origin => blockedOrigins.push(origin), egress);
      });
      this.creationTail = start.catch(() => {});
      let backend: BrowserBackend | FedoraBackend;
      try { backend = await start; }
      catch (error) { await egress?.close(); await clone?.close(); await rm(profile, { recursive: true, force: true }).catch(() => {}); throw error; }
      if (account && backend instanceof BrowserBackend) {
        try { if (restoredState) await backend.context.setStorageState(restoredState); }
        catch (error) { await backend.close(); await egress?.close(); await rm(profile, { recursive: true, force: true }).catch(() => {}); throw error; }
      }
      const journals = join(this.root, "journals");
      await mkdir(journals, { recursive: true, mode: 0o700 });
      const journalPath = join(journals, `${id}.jsonl`);
      const session: Session = { id, agentName, taskName, conversationName, projectName, state: "running", backend, account, kind: String(input.backend), lease, profile, tail: Promise.resolve(), requests: new Map(), policy, journal: [], releaseClone: clone?.close, blockedOrigins, journalPath,
        createdAt: Date.now(), lastActivityAt: Date.now(),
        egress: egress ?? { tier: "in-browser", launch: { executable: "", args: [] }, endpointPort: 0, refused: () => [], close: async () => {} },
        restoreStore: snapshotCapable ? join(this.root, `restore-${id}`) : "", restorePoints: [], tainted: false };
      // The first line says what was agreed to, so a reader knows what the rest of the file was
      // judged against without having to ask the broker that is no longer running.
      void this.record(session, { at: new Date().toISOString(), sequence: 0, sessionId: id, actor: "person",
        actionType: "session.create", actionClass: "read", outcome: "allow",
        reason: `${String(input.backend)} session, ${policy.mode}, origins ${policy.origins === "any" ? "any" : policy.origins.join(" ") || "none"}, allow ${policy.allow.join(" ")}, deny ${policy.deny.join(" ") || "none"}${input.cloneOf === undefined ? "" : ", from a cloned profile"}${egress === undefined ? "" : `, egress held ${egress.tier === "namespace" ? "below the browser in a network namespace of its own" : "inside the browser only, because this host cannot confine one"}`}` });
      session.relaunch = () => BrowserBackend.create(session.profile, session.backend.surface, clone?.launch,
        session.policy.origins, origin => blockedOrigins.push(origin),
        // The same lease, not a new one. Its proxy and relay are the broker's and outlive any one
        // browser, the wrapper is still on disk, and the relay's port is in the journal already.
        egress);
      live = session;
      this.sessions.set(id, session);
      // Whichever way the session ends, its profile goes with it: account state was copied out
      // while it ran, so nothing in it outlives the session, and a retained one is disk that
      // nothing reclaims. The backend's own exit is one of those ways, so the removal hangs off
      // the release that every ending awaits.
      const reap = () => {
        // A restore closes the browser on purpose and starts another on the same profile, so that close
        // is not the end of the session and must not take the profile with it.
        if (session.restoring) return;
        if (session.state !== "closing" && session.state !== "closed") {
          void this.diagnostics.run({ method: "backend.exit", params: { sessionId: id, backend: session.kind } }, async () => {
            throw new OrbitError("BACKEND_ERROR", "Backend exited outside a stop request");
          }).catch(() => {});
        }
        // Stamped here as well as in `stop`, because this is the other way a session ends: a backend
        // that exited on its own would otherwise be dated to its last action rather than to its end.
        session.state = "closed"; session.lastActivityAt = Date.now(); this.leases.delete(lease);
        // Restore points go before the profile does. Each is a copy of the person's live cookies, and
        // a read only snapshot inside the profile would stop the profile itself being removed.
        session.releasing ??= session.tail.then(() => account?.release()).then(() => session.releaseClone?.()).then(() => session.egress.close())
          .then(async () => { if (session.restoreStore) await clearRestorePoints(session.restoreStore); })
          .finally(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
      };
      session.reap = reap;
      backend.onClose(reap);
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
  /**
   * Remember one decision and append it to the durable copy. The append is not awaited by the caller:
   * a slow disk must not delay a decision that has already been made, and a lost line is a lost line
   * rather than a stalled session. Failures are swallowed for the same reason.
   */
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
    // The policy is evaluated here, on the action the broker resolved, not on the action the agent
    // described. Those are the same thing only when nothing has tried to make them differ.
    const destination = "url" in action ? (action as { url?: string }).url : undefined;
    // The method is read the same way the url is, and for the same reason. `Rule.method` exists,
    // `parsePolicy` accepts it, and `ruleMatches` requires the method to match, but this call site
    // passed only three arguments, so `decide` received `method === undefined` and every rule
    // carrying a method failed to match. A rule that fails to match is a rule that fails OPEN: the
    // caller wrote a narrowing rule, the broker accepted it and reported it as held, and it stopped
    // nothing. `tests/policy.test.ts` calls `decide` directly with a method, so both sides were
    // green about a field that did not work in the product, which is exactly the kind of gap a unit
    // test on either side of a seam cannot see.
    //
    // Reading the field alone is not enough, and that is the second half of the same defect. No
    // browser action carries a `method`, so a rule written as `{ verb: "navigate", method: "GET" }`
    // would still match nothing. A navigation IS a GET, and a person writing that rule means the
    // navigation. The implied method is supplied per verb, so the rule denies what it says it
    // denies; an explicit method on the action still wins where one exists.
    const stated = "method" in action ? (action as { method?: unknown }).method : undefined;
    const method = typeof stated === "string" ? stated : impliedMethod(action.type);
    const methodIsImplied = typeof stated !== "string" && method !== undefined;
    const inputLength = "text" in action ? String((action as { text?: string }).text ?? "").length : undefined;
    const result = this.decided(session, action, destination, method, methodIsImplied, inputLength, requestId);
    session.requests.set(requestId, { fingerprint, result });
    return result;
  }
  /**
   * Decide one action, then run it if it survives. A consult is resolved by the advisor rather than
   * by a person, because an autonomous session has nobody to wait for.
   */
  private decided(session: Session, action: { type: string }, destination: string | undefined, method: string | undefined, methodIsImplied: boolean, inputLength: number | undefined, requestId: string): Promise<unknown> {
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
      return this.enqueue(session, () => this.track(session, "agent", action.type, () => this.guarded(session, action)));
    }
    // Consulting takes as long as the advisor takes, so it happens before the action is queued and
    // the session's own ordering is untouched by it.
    return (async () => {
      const pending = journalEntry({
        sequence: session.journal.length + 1, sessionId: session.id, actor: "agent",
        actionType: action.type, decision, url: destination,
        ...(inputLength === undefined ? {} : { inputLength }),
      });
      const answer = await consultAdvisor(session.policy.advisor!, {
        pending, tail: session.journal.slice(-20), reason: decision.reason, ruleId: decision.ruleId,
      });
      if (answer.decision.outcome === "deny") return refuse(answer.decision, answer.decidedBy);
      record(answer.decision, answer.decidedBy);
      return this.enqueue(session, () => this.track(session, "agent", action.type, () => this.guarded(session, action)));
    })();
  }
  /**
   * Take a restore point before the action, where one would mean anything. Nothing is taken before a
   * click or a navigation: a snapshot cannot unsend a message, and recording one there would be a
   * promise the filesystem cannot keep.
   */
  /** Page content entering the session is what taints it, whichever action carried it in. */
  private taintedBy(session: Session, actionType: string) {
    if (!session.tainted && ["read", "observe"].includes(actionType)) session.tainted = true;
  }
  private async guarded(session: Session, action: { type: string }) {
    if (session.restoreStore) {
      const point = await takeRestorePoint(session.profile, session.restoreStore, session.journal.length, action.type)
        .catch(() => null);
      if (point) session.restorePoints.push(point);
    }
    const result = await session.backend.act(action as Parameters<typeof session.backend.act>[0]);
    this.taintedBy(session, action.type);
    return result;
  }
  /**
   * Put a session back to one of its restore points.
   *
   * The refusals are most of what this does, and that is not an accident of the implementation. A point
   * is only taken before an action a snapshot could undo, and `canRestoreTo` then refuses if anything
   * since has left the machine. On a browser session that means a restore is permitted only for a
   * session that has not browsed: the interesting undos are exactly the ones refused, because restoring
   * a profile after a message was sent would put the browser back, leave the message sent, and report
   * success. Nothing here widens that.
   */
  private async restore(session: Session, sequence: number | undefined): Promise<unknown> {
    if (!(session.backend instanceof BrowserBackend) || !session.relaunch)
      throw new OrbitError("UNSUPPORTED", "Restore points are taken for browser sessions; a private display is reaped whole instead");
    if (!session.restoreStore) throw new OrbitError("UNSUPPORTED", "This filesystem cannot snapshot a profile, so this session has no restore points");
    // Paused, because a restore replaces the profile under the session and a queued action would run
    // against a browser that is no longer the one it was queued for.
    if (session.state !== "paused") throw new OrbitError("NOT_PAUSED", "Pause and wait for acknowledgement before restoring");
    // A pause acknowledges only after accepted actions have drained, so this is normally settled already.
    // It is awaited anyway: a caller racing a resume against a restore would otherwise have the backend
    // replaced under a session that believes it is running.
    await session.tail.catch(() => {});
    const point = sequence === undefined ? session.restorePoints.at(-1) : session.restorePoints.find(held => held.sequence === sequence);
    const since = session.journal.filter(entry => entry.actor === "agent" && entry.outcome === "allow" && entry.sequence > (point?.sequence ?? 0));
    const verdict = canRestoreTo(point, since);
    if (!verdict.allowed) throw new OrbitError("RESTORE_REFUSED", verdict.reason);
    session.restoring = true;
    try {
      // The browser holds the profile open, so it goes first. A swap under a live browser puts the files
      // back and lets the browser write its own copy out again at exit.
      await session.backend.close();
      if (!await restoreProfile(session.profile, verdict.point))
        throw new OrbitError("BACKEND_FAILED", "The profile could not be swapped for its restore point; nothing was changed");
      session.backend = await session.relaunch();
      session.backend.onClose(session.reap ?? (() => {}));
    } catch (error) {
      // A session whose browser is gone and cannot be replaced is over. Reaping is what the guard above
      // suppressed, so it is done here rather than left to a close that will not come again.
      session.restoring = false;
      session.reap?.();
      throw error;
    } finally { session.restoring = false; }
    // Points at or after the one used are gone: the session's history past this line did not happen.
    for (const held of session.restorePoints.filter(entry => entry.sequence >= verdict.point.sequence))
      await removeRestorePoint(held.path).catch(() => {});
    session.restorePoints = session.restorePoints.filter(entry => entry.sequence < verdict.point.sequence);
    void this.record(session, journalEntry({
      at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
      actor: "person", actionType: "session.restore", decision: { outcome: "allow" }, after: session.policy,
    }));
    return { sessionId: session.id, restoredTo: verdict.point.sequence, consistent: verdict.point.consistent,
      state: session.state, restorePoints: session.restorePoints };
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
    if (session.state === "closed") { await session.releasing; return this.info(session); }
    session.state = "closing";
    session.closing = (async () => {
      await session.backend.close();
      await session.tail;
      await session.releasing;
      // Belt and braces for a backend whose close never reported itself.
      await rm(session.profile, { recursive: true, force: true }).catch(() => {});
      session.state = "closed";
      session.lastActivityAt = Date.now();
      return this.info(session);
    })();
    return session.closing;
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
    if (request.method === "update.begin") {
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
    if (request.method === "doctor") return { version: (await import("../package.json")).version, platform: process.platform, backend: "browser", backends: ["browser", "fedora"], backendAliases: { system: "fedora" },
      capabilities, sessions: this.sessions.size, resources: await resourceStatus(), machine: await describeMachine(),
      // Whether the units on disk are the ones this version writes. A managed broker that was
      // installed before a directive existed does not carry it, and nothing else on the machine
      // says so: the development host was running a unit with no EnvironmentFile, so every
      // documented operator switch was reaching a fresh install and silently not that one. Linux
      // only, since it is systemd units that drift this way.
      units: process.platform === "linux" ? await installedUnitDrift() : undefined };
    if (request.method === "session.create") return this.create(params);
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
      if (known) this.sessions.delete(id);
      return { sessionId: id, forgotten: known !== undefined };
    }
    if (!["session.pause", "session.resume", "session.stop", "session.observe", "session.presence", "session.control", "session.account.save", "session.journal", "session.narrow", "session.restore"].includes(String(request.method))) throw new OrbitError("UNSUPPORTED", "Unknown method");
    const session = this.get(params.sessionId);
    // What the session did, for a person reading afterwards rather than approving in advance.
    if (request.method === "session.journal") return { sessionId: session.id, policy: session.policy, entries: session.journal, blockedOrigins: [...new Set(session.blockedOrigins)], path: session.journalPath, tainted: session.tainted, restorePoints: session.restorePoints,
      egressTier: session.egress.tier, refusedAuthorities: session.egress.refused() };
    // Narrowing only. There is deliberately no method that widens a running session, because the
    // value of the allowlist is that a page the agent reads cannot cause it to grow.
    if (request.method === "session.narrow") {
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
    if (request.method === "session.restore") {
      if (params.sequence !== undefined && (!Number.isInteger(params.sequence) || Number(params.sequence) < 0))
        throw new OrbitError("INVALID_REQUEST", "A restore point is named by the sequence reported in the journal");
      this.ensureOpen(session);
      return this.restore(session, params.sequence === undefined ? undefined : Number(params.sequence));
    }
    this.ensureOpen(session);
    // Presence is what a desktop indicator polls, so it must not cost a frame or wait behind an action.
    if (request.method === "session.presence") return session.backend.presence().catch(error => { this.ensureOpen(session); throw error; });
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
    // Capture is read-only and must not wait behind a locator action. It is still page content
    // arriving in the session, so it taints on its own path as a read does on the action path.
    //
    // And it is policed. `classify("observe")` has always answered `read`, and `decide` was reached
    // only from `act()`, so a session created with `allow: []`, or narrowed to nothing after an
    // immune action fired, still answered `session.observe` with a full frame of the page. For a
    // session started from a clone of the person's own profile that frame is the contents of their
    // logged-in accounts, returned to an agent whose policy said it could do nothing. Reading is
    // not free just because it changes nothing: it is the half of the boundary that protects the
    // person rather than the machine. The refusal is journalled the way a denied action is, so a
    // reader sees the attempt rather than a gap.
    const decision = decide(session.policy, "observe");
    if (decision.outcome === "deny") {
      void this.record(session, journalEntry({
        at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
        actor: "agent", actionType: "observe", decision, after: session.policy,
      }));
      throw new OrbitError("POLICY_DENIED", decision.reason);
    }
    session.observing ??= session.backend.observe().then(frame => {
      this.taintedBy(session, "observe");
      return frame;
    }).catch(error => {
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
