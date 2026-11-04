import { brokerIdentity } from "./managed-identity";
import { discoverApplications } from "./application-discovery";
import { managedUpdateRoot, requireUpdateAdmission } from "./update-admission";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";
import { NativeBackend, parseHandoff, parseNativeOpen, parseNativePresentation } from "./hyprland";
import { nativeOptionsFromEnv } from "./native-worker";
import { OrbitError, record, text } from "./errors";
import { errorPayload, preflightDisposition, refusedDisposition } from "./error-disposition";
import { resourceStatus } from "./resource-budget";
import { describeDesktopMachine } from "./desktop-machine";
import { decide, nativeApplicationPolicy, journalEntry, narrow, parseActionClasses, parseOrigins, parsePolicy, type JournalEntry, type SessionPolicy } from "./policy";
import { consultAdvisor } from "./advisor";
import { Diagnostics } from "./diagnostics";
import { autostartPaths } from "./autostart";
import { internalCaller, type Caller } from "./caller";
import { ReadResourceBudget } from "./multi-view-read-budget";
import { ReadViewRegistry, ReadViewError, type ReadRecipient, type ReadViewBackend, type ReadViewFormat, type ReadObservationLease } from "./multi-view-views";
import { CallerRegistry } from "./caller-registry";
import { ReadChannelRegistry, ReadChannelError, type ReadConnectorIdentity, type ResolvedReadChannel, type ReadChannelEnrollment } from "./read-channel-registry";
import { WaitQueue, allocateWorkspace, busyMessage, duration, graceSeconds, parseWait, workspacePool, type Holder } from "./arbitration";
import { hostAdapterReport } from "./host-registration";

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
type BatchCapture = { format?: "text" | "both"; timeoutMs: number; quietMs?: number };
interface Session {
  agentName: string; taskName: string; conversationName?: string; projectName?: string;
  activity?: { type: string; actor: string; state: string; sequence: number };
  createdAt: number; lastActivityAt: number;
  id: string; state: State; backend: NativeBackend; kind: "native"; lease: string;
  ownerId: string; ownerLabel: string; ownerRole: Caller["role"];
  /** Set while the owning adapter is gone: when it went, and the timer that will stop the session. */
  orphan?: { at: number; timer?: ReturnType<typeof setTimeout> };
  forcedClosed?: boolean;
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
  const { image: _image, tree: _tree, ...frame } = record(body.capture);
  return { ...body, capture: { ...frame, expired: true } };
}

/** Fixture-only protected transport seam. No production caller supplies this channel.
 * Usage versions are authoritative injected snapshots, not environment labels or CLI off.
 * The retained lease needs a future qualified delivery serializer; it is NOT JSON RPC.
 */
export interface SessionReadViewsOptions {
  ownerIdentity: object;
  ownerChannel: object;
  channels: readonly { key: string; channel: object; recipient: ReadRecipient; callerId: string }[];
  /** Optional fixture-only owner-approved one-use connector transport. Never an IPC flag. */
  dynamicChannels?: { connectorChannel: object; processCurrent(identity: ReadConnectorIdentity): boolean };
  backend: ReadViewBackend;
  liveProcess(pid: number, birth: string): boolean;
  usageVersion(conversation: object): Promise<{ conversation: object; epoch: number; enabled: boolean }>;
  /** Synchronous owner-managed revocation fence, checked at every final byte access. */
  usageCurrent(conversation: object, epoch: number): boolean;
  now?: () => number;
}
interface BrokerReadChannel {
  key: string; channel: object; recipient: ReadRecipient; callerId: string; approved?: ResolvedReadChannel;
  fence: number; blockedEpoch: number; epoch: number; enabled: boolean; grant?: string; expiresAt?: number; enrolling?: object;
}
interface BrokerReadBinding {
  session: Session; backend: NativeBackend;
  handoff: NonNullable<NativeBackend["handoff"]>;
  window: NonNullable<NativeBackend["handoff"]>["windows"][number];
  appId: string; windowId: string; width: number; height: number; ownerId: string;
}
function readFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key)))
    throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
    result[key] = descriptor.value;
  }
  return result;
}

/** Snapshot small authority lists without executing caller array methods or accessors. */
function readList(value: unknown): readonly unknown[] {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > 2) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.some(key => key !== "length" && key !== "0" && !(length.value === 2 && key === "1"))) throw new Error();
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch { throw new OrbitError("READ_VIEW_INVALID", "Read view request refused"); }
}
function readFormats(value: unknown): readonly ReadViewFormat[] {
  const values = readList(value);
  if (values.some(format => format !== "image" && format !== "text") || new Set(values).size !== values.length)
    throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
  return values as readonly ReadViewFormat[];
}

/** Seams for the lifecycle and arbitration timing; production uses the defaults. */
export interface SessionOptions {
  /** Seconds before a disconnected adapter's sessions are stopped. Default: the setting, then 60. */
  graceSeconds?: () => number;
  /** How long a session may sit in closing before the broker forces it closed. */
  closeDeadlineMs?: number;
  pollMs?: number;
  alive?: (pid: number, start?: string) => boolean;
  /** Hands a plugin lease back after a forced close. Default: the owner repair path `native-leases release`. */
  releaseLease?: (leaseId: string, live: string[]) => Promise<unknown>;
  workspacePool?: [number, number];
  /** Absent in production. No environment/body opt-in or native capture fallback. */
  readViews?: SessionReadViewsOptions;
}

async function releasePluginLease(leaseId: string, live: string[]) {
  const { nativeLeases } = await import("./native-prepare");
  return nativeLeases("release", leaseId, live);
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
  readonly callers: CallerRegistry;
  private waitQueue = new WaitQueue();
  private waiters = new Set<() => void>();
  /** Workspaces agents were given or opened windows on, so another agent is not sent to the same one. */
  private opened: { callerId: string; label: string; workspace: number; at: number }[] = [];
  private allocations = new Map<string, number>();
  private readRegistry?: ReadViewRegistry;
  private readAuthority = Object.freeze({});
  private readChannels = new Map<object, BrokerReadChannel>();
  private readKeys = new Map<string, BrokerReadChannel>();
  private readBindings = new WeakMap<object, BrokerReadBinding>();
  private readConfig?: SessionReadViewsOptions;
  private readCanonical = new WeakMap<Session, WeakMap<object, object>>();
  private readTransportRegistry?: ReadChannelRegistry;
  private readConnectorChannel?: object;
  private readPendingChannels = new Map<string, { key: object; instance: object; approval: ReadChannelEnrollment }>();
  private readSpentKeys = new WeakSet<object>();
  private readControlReplies = new WeakMap<object, { current(): boolean; rollback(): void }>();
  constructor(private root: string, _accountRoot?: string, readonly diagnostics = new Diagnostics(join(root, "diagnostics")), private native = nativeOptionsFromEnv(), private updateDirectory = managedUpdateRoot(), private options: SessionOptions = {}) {
    this.callers = new CallerRegistry({ pollMs: options.pollMs, alive: options.alive,
      onGone: id => this.adapterGone(id), onBack: id => this.adapterBack(id) });
    if (options.readViews) this.initializeReadViews(options.readViews);
    this.callers.start();
  }
  private initializeReadViews(config: SessionReadViewsOptions) {
    if (!config.ownerIdentity || typeof config.ownerIdentity !== "object" || !config.ownerChannel
        || typeof config.ownerChannel !== "object" || !Array.isArray(config.channels) || config.channels.length > 8
        || typeof config.liveProcess !== "function" || typeof config.usageVersion !== "function" || typeof config.usageCurrent !== "function")
      throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
    this.readConfig = Object.freeze({ ...config });
    for (const input of config.channels) {
      if (typeof input.key !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.key)
          || !input.channel || typeof input.channel !== "object" || input.channel === config.ownerChannel
          || input.recipient.channel !== input.channel || input.recipient.owner !== config.ownerIdentity
          || typeof input.callerId !== "string" || !input.callerId || this.readKeys.has(input.key)
          || this.readChannels.has(input.channel)) throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
      const recipient = Object.freeze({ ...readFields(input.recipient, ["owner", "connector", "instance", "conversation", "channel", "pid", "birth"]) }) as unknown as ReadRecipient;
      const entry: BrokerReadChannel = { ...input, recipient, fence: 0, blockedEpoch: 0, epoch: 0, enabled: false };
      this.readChannels.set(input.channel, entry); this.readKeys.set(input.key, entry);
    }
    const backend = Object.freeze({ admissionReady: config.backend.admissionReady.bind(config.backend),
      recipientCurrent: config.backend.recipientCurrent.bind(config.backend), bindingCurrent: config.backend.bindingCurrent.bind(config.backend),
      prepare: config.backend.prepare.bind(config.backend) });
    const liveProcess = config.liveProcess, usageCurrent = config.usageCurrent;
    this.readRegistry = new ReadViewRegistry({ ownerAuthority: this.readAuthority, budget: new ReadResourceBudget(), now: config.now,
      backend: {
        admissionReady: () => !this.shuttingDown && backend.admissionReady() === true,
        recipientCurrent: (recipient, epoch) => {
          const entry = this.readChannels.get(recipient.channel);
          return !!entry && entry.recipient.owner === recipient.owner && entry.recipient.connector === recipient.connector
            && entry.recipient.instance === recipient.instance && entry.recipient.conversation === recipient.conversation
            && this.readChannelCurrent(entry) && entry.enabled && entry.epoch === epoch && epoch > entry.blockedEpoch
            && liveProcess(recipient.pid, recipient.birth) === true
            && usageCurrent(recipient.conversation, epoch) === true && backend.recipientCurrent(recipient, epoch) === true;
        },
        bindingCurrent: (binding, epoch) => this.readBindingCurrent(binding) && epoch === 1 && backend.bindingCurrent(binding, epoch) === true,
        prepare: (binding, format) => backend.prepare(binding, format),
      } });
    if (config.dynamicChannels) {
      const dynamic = config.dynamicChannels;
      if (!dynamic.connectorChannel || typeof dynamic.connectorChannel !== "object" || dynamic.connectorChannel === config.ownerChannel
          || typeof dynamic.processCurrent !== "function") throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
      this.readConnectorChannel = dynamic.connectorChannel;
      this.readTransportRegistry = new ReadChannelRegistry({ ownerAuthority: this.readAuthority, ownerIdentity: config.ownerIdentity,
        processCurrent: dynamic.processCurrent, now: config.now, onRevoke: resolved => this.dropReadChannel(resolved) });
    }
  }
  private readChannelCurrent(entry: BrokerReadChannel): boolean {
    return !entry.approved || this.readTransportRegistry?.isCurrent(entry.channel) === true;
  }
  private dropReadChannel(resolved: ResolvedReadChannel) {
    for (const [secret, pending] of this.readPendingChannels) if (pending.instance === resolved.recipient.instance) this.readPendingChannels.delete(secret);
    const channel = resolved.channel;
    const entry = this.readChannels.get(channel);
    if (!entry?.approved) return;
    // Fence and remove authority before notification can throw. This does NOT settle work.
    entry.fence++; entry.enabled = false; entry.grant = undefined;
    this.readChannels.delete(channel); this.readKeys.delete(entry.key);
    this.readRegistry!.detach(this.readAuthority, entry.recipient);
  }
  private approvedReadBinding(callerId: string, raw: unknown) {
    const view = readFields(raw, ["sessionId", "appId", "windowId", "formats"]);
    const formats = readFormats(view.formats);
    const session = this.get(view.sessionId), backend = session.backend, handoff = backend.handoff;
    const window = handoff?.windows.find(item => item.appId === view.appId && item.windowId === view.windowId);
    if (session.ownerId !== callerId || session.state !== "running" || session.orphan || !handoff || !window
        || handoff.appId !== view.appId || decide(session.policy, "observe").outcome !== "allow")
      throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    let windows = this.readCanonical.get(session);
    if (!windows) { windows = new WeakMap(); this.readCanonical.set(session, windows); }
    let binding = windows.get(window);
    if (!binding) {
      binding = Object.freeze({ sessionId: session.id, appId: window.appId, windowId: window.windowId });
      windows.set(window, binding);
      this.readBindings.set(binding, { session, backend, handoff, window, appId: window.appId, windowId: window.windowId,
        width: window.width, height: window.height, ownerId: callerId });
    }
    if (!this.readBindingCurrent(binding)) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    return { binding, bindingEpoch: 1, formats };
  }
  private readBindingCurrent(binding: object): boolean {
    const value = this.readBindings.get(binding);
    if (!value) return false;
    const { session, backend, handoff, window } = value;
    return this.sessions.get(session.id) === session && session.ownerId === value.ownerId && session.state === "running" && !session.orphan
      && session.backend === backend && backend.handoff === handoff && handoff.windows.includes(window)
      && handoff.appId === value.appId && window.appId === value.appId && window.windowId === value.windowId
      && window.width === value.width && window.height === value.height && decide(session.policy, "observe").outcome === "allow";
  }
  private readOwner(caller: Caller, channel: object | undefined) {
    if (!this.readRegistry || !this.readConfig || channel === undefined)
      throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
    if (!caller.verified || caller.role !== "owner" || channel !== this.readConfig.ownerChannel)
      throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
  }
  private readRecipient(caller: Caller, channel: object | undefined): BrokerReadChannel {
    if (!this.readRegistry || !this.readConfig || channel === undefined)
      throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
    const entry = this.readChannels.get(channel);
    if (!entry || !caller.verified || caller.kind === "unidentified" || caller.id !== entry.callerId
        || caller.pid !== entry.recipient.pid || caller.start !== entry.recipient.birth
        || this.readConfig.liveProcess(entry.recipient.pid, entry.recipient.birth) !== true || !this.readChannelCurrent(entry))
      throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    return entry;
  }
  private revokeReadConversation(conversation: object) {
    for (const entry of this.readChannels.values()) if (entry.recipient.conversation === conversation) {
      entry.fence++; entry.blockedEpoch = Math.max(entry.blockedEpoch, entry.epoch);
      entry.enabled = false; entry.grant = undefined;
    }
    this.readRegistry!.revokeConversation(this.readAuthority, conversation);
  }
  private revokeSessionReadViews(session: Session) {
    if (!this.readRegistry) return;
    const conversations = new Set<object>();
    for (const entry of this.readChannels.values()) if (entry.callerId === session.ownerId) conversations.add(entry.recipient.conversation);
    for (const conversation of conversations) this.revokeReadConversation(conversation);
  }
  private async refreshReadUsage(entry: BrokerReadChannel, expected?: number): Promise<number> {
    const fence = entry.fence;
    let version: Record<string, unknown>;
    try { version = readFields(await this.readConfig!.usageVersion(entry.recipient.conversation), ["conversation", "epoch", "enabled"]); }
    catch { this.revokeReadConversation(entry.recipient.conversation); throw new OrbitError("READ_VIEW_DENIED", "Read view request refused"); }
    if (entry.fence !== fence) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    if (version.conversation !== entry.recipient.conversation || typeof version.enabled !== "boolean"
        || typeof version.epoch !== "number" || !Number.isSafeInteger(version.epoch) || version.epoch < 1
        || version.epoch < entry.epoch || version.epoch <= entry.blockedEpoch) {
      this.revokeReadConversation(entry.recipient.conversation); throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    }
    if (!version.enabled) {
      entry.epoch = version.epoch; this.revokeReadConversation(entry.recipient.conversation);
      throw new OrbitError("READ_VIEW_OFF", "Read view request refused");
    }
    if (expected !== undefined && version.epoch !== expected) {
      this.revokeReadConversation(entry.recipient.conversation); throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    }
    entry.epoch = version.epoch; entry.enabled = true;
    return version.epoch;
  }
  private async dispatchReadView(method: string, params: Record<string, unknown>, caller: Caller, channel: object | undefined): Promise<unknown> {
    if (!this.readRegistry || !this.readConfig || !channel) throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
    const registry = this.readRegistry;
    try {
      if (method.startsWith("views.channel.")) {
        const transport = this.readTransportRegistry;
        if (!transport) throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
        if (method === "views.channel.activate") {
          if (channel !== this.readConnectorChannel) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          const input = readFields(params, ["enrollment"]);
          if (this.readChannels.size >= 8) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          const pending = this.readPendingChannels.get(input.enrollment as string);
          if (!pending) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          const activated = transport.activate(input.enrollment as string, caller);
          this.readSpentKeys.add(pending.key);
          try {
          const resolved = transport.resolve(activated.transport, caller);
          if (!resolved || this.readChannels.size >= 8) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          const key = crypto.randomUUID().replaceAll("-", "");
          if (this.readKeys.has(key)) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          const entry: BrokerReadChannel = { key, channel: resolved.channel, recipient: resolved.recipient, callerId: resolved.callerId,
            approved: resolved, fence: 0, blockedEpoch: 0, epoch: 0, enabled: false };
          this.readChannels.set(resolved.channel, entry); this.readKeys.set(key, entry);
          this.readPendingChannels.delete(input.enrollment as string);
          // Protected connector control reply only. Not model-visible or ordinary IPC.
          const reply = { ...activated, channelKey: key };
          this.readControlReplies.set(reply, { current: () => transport.isCurrent(resolved.channel)
            && this.readChannels.get(resolved.channel) === entry, rollback: () => { transport.revoke(this.readAuthority, pending.key); } });
          return reply;
          } catch {
            this.readPendingChannels.delete(input.enrollment as string);
            // A consumed secret whose bookkeeping failed never leaves an unreachable
            // active slot. Registry notification failure retains its own quarantine.
            try { transport.revoke(this.readAuthority, pending.key); } catch { /* Registry fails closed. */ }
            throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
          }
        }
        this.readOwner(caller, channel);
        if (method === "views.channel.issue") {
          const input = readFields(params, ["key", "identity", "expiresAt", "views"]);
          const identity = readFields(input.identity, ["callerId", "pid", "birth", "installation", "instance", "conversation"]);
          const selected = readList(input.views);
          if (typeof identity.callerId !== "string")
            throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
          if (this.readSpentKeys.has(input.key as object)) throw new ReadChannelError("CONFLICT");
          const views = selected.map(view => this.approvedReadBinding(identity.callerId as string, view));
          const approval = Object.freeze({ ...identity, key: input.key, expiresAt: input.expiresAt,
            views: Object.freeze(views.map(view => Object.freeze({ ...view, formats: Object.freeze([...view.formats]) }))) }) as unknown as ReadChannelEnrollment;
          const issued = transport.issue(this.readAuthority, approval);
          const pending = this.readPendingChannels.get(issued.enrollment)
            ?? { key: input.key as object, instance: identity.instance as object, approval };
          this.readPendingChannels.set(issued.enrollment, pending);
          this.readControlReplies.set(issued, { current: () => {
            if (this.readPendingChannels.get(issued.enrollment) !== pending || this.readSpentKeys.has(pending.key)) return false;
            const checked = transport.issue(this.readAuthority, pending.approval);
            return checked.enrollment === issued.enrollment && this.readPendingChannels.get(issued.enrollment) === pending
              && !this.readSpentKeys.has(pending.key);
          }, rollback: () => {
            // A delayed idempotent issue reply must not revoke an already activated
            // connector that legitimately consumed the first delivered ticket.
            if (this.readPendingChannels.get(issued.enrollment) === pending && !this.readSpentKeys.has(pending.key))
              transport.revoke(this.readAuthority, pending.key);
          } });
          return issued;
        }
        if (method === "views.channel.status") {
          readFields(params, []);
          return transport.status(this.readAuthority);
        }
        if (method === "views.channel.revoke") {
          const input = readFields(params, ["key"]);
          return { revoked: transport.revoke(this.readAuthority, input.key as object) };
        }
        if (method === "views.channel.detach") {
          const input = readFields(params, ["instance"]);
          transport.detach(this.readAuthority, input.instance as object);
          return { detached: true };
        }
        throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
      }
      if (method === "views.enable") {
        this.readOwner(caller, channel);
        const input = readFields(params, ["enabled"]);
        if (typeof input.enabled !== "boolean") throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
        if (!input.enabled) for (const entry of this.readChannels.values()) this.revokeReadConversation(entry.recipient.conversation);
        registry.setEnabled(this.readAuthority, input.enabled);
        return { enabled: input.enabled };
      }
      if (["views.enroll", "views.off", "views.revoke"].includes(method)) {
        this.readOwner(caller, channel);
        const input = readFields(params, method === "views.enroll" ? ["channelKey", "expiresAt", "views"] : ["channelKey"]);
        const entry = typeof input.channelKey === "string" ? this.readKeys.get(input.channelKey) : undefined;
        if (!entry) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        if (method !== "views.enroll") {
          this.revokeReadConversation(entry.recipient.conversation);
          return { revoked: true };
        }
        // Sweep expiry without forgiving unknown work or changing its charged lifecycle.
        const active = registry.status(entry.recipient);
        if (entry.grant && active.views.length === 0) entry.grant = undefined;
        const now = this.readConfig.now?.() ?? performance.now();
        if (entry.grant && entry.expiresAt !== undefined && now >= entry.expiresAt) entry.grant = undefined;
        if (entry.grant || entry.enrolling) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        const enrollment = Object.freeze({});
        entry.enrolling = enrollment;
        try {
        const fence = entry.fence;
        const epoch = await this.refreshReadUsage(entry);
        if (entry.grant || entry.enrolling !== enrollment) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        this.readOwner(caller, channel);
        if (fence !== entry.fence) throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
        const views = readList(input.views).map(raw => this.approvedReadBinding(entry.callerId, raw));
        if (entry.approved) {
          if (!this.readChannelCurrent(entry) || typeof input.expiresAt !== "number" || input.expiresAt > entry.approved.expiresAt
              || views.some(view => {
                const approved = entry.approved!.views.find(item => item.binding === view.binding && item.bindingEpoch === view.bindingEpoch);
                return !approved || !Array.isArray(view.formats) || view.formats.some(format => !approved.formats.includes(format));
              })) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        }
        if (new Set(views.map(view => JSON.stringify(view.binding))).size !== views.length)
          throw new OrbitError("READ_VIEW_INVALID", "Read view request refused");
        if (entry.grant || entry.enrolling !== enrollment || fence !== entry.fence)
          throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        const enrolled = registry.enroll(this.readAuthority, { recipient: entry.recipient, consentEpoch: epoch,
          expiresAt: input.expiresAt as number, views });
        entry.grant = enrolled.grant; entry.expiresAt = input.expiresAt as number;
        return { views: enrolled.views }; // Grant secret never leaves the broker.
        } finally { if (entry.enrolling === enrollment) entry.enrolling = undefined; }
      }
      const entry = this.readRecipient(caller, channel);
      if (method === "views.status") {
        readFields(params, []);
        await this.refreshReadUsage(entry, entry.grant ? entry.epoch : undefined);
        this.readRecipient(caller, channel);
        return registry.status(entry.recipient);
      }
      if (method !== "views.read") throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
      const input = readFields(params, ["viewId", "format"]);
      const fence = entry.fence, epoch = await this.refreshReadUsage(entry, entry.epoch);
      this.readRecipient(caller, channel);
      if (fence !== entry.fence || !entry.grant) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
      const lease = await registry.read(entry.recipient, entry.grant, input.viewId as string, input.format as ReadViewFormat);
      try {
        await this.refreshReadUsage(entry, epoch);
        this.readRecipient(caller, channel);
        if (fence !== entry.fence) throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
        // No unaccounted base64/JSON copy. Only a trusted in-process transport can
        // hold this lease. Existing IPC cannot reach it and no serializer is enabled.
        const sessions = this;
        const guarded: ReadObservationLease = Object.freeze({
          get bytes() {
            sessions.readRecipient(caller, channel);
            if (entry.fence !== fence || !entry.enabled || entry.epoch !== epoch
                || sessions.readConfig!.usageCurrent(entry.recipient.conversation, epoch) !== true)
              throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
            return lease.bytes;
          },
          release: () => lease.release(),
        });
        return guarded;
      } catch (error) { lease.release(); throw error; }
    } catch (error) {
      if (error instanceof ReadChannelError) {
        const codes: Record<ReadChannelError["code"], string> = { INVALID: "READ_CHANNEL_INVALID", DENIED: "READ_CHANNEL_DENIED",
          BUSY: "READ_CHANNEL_BUSY", LIMIT: "READ_CHANNEL_LIMIT", CONFLICT: "READ_CHANNEL_CONFLICT" };
        throw new OrbitError(codes[error.code], "Connector channel request refused");
      }
      if (error instanceof ReadViewError) {
        const codes: Record<ReadViewError["code"], string> = {
          INVALID: "READ_VIEW_INVALID", DENIED: "READ_VIEW_DENIED", OFF: "READ_VIEW_OFF",
          LIMIT: "READ_VIEW_LIMIT", BUSY: "READ_VIEW_BUSY", UNCONFIRMED: "READ_VIEW_UNCONFIRMED", BACKEND: "READ_VIEW_BACKEND",
        };
        throw new OrbitError(codes[error.code], "Read view request refused");
      }
      if (error instanceof OrbitError && ["READ_VIEW_INVALID", "READ_VIEW_DENIED", "READ_VIEW_OFF", "READ_CHANNEL_DENIED", "UNSUPPORTED"].includes(error.code)) throw error;
      throw new OrbitError("READ_VIEW_DENIED", "Read view request refused");
    }
  }
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
      surface: session.backend.surface, policy: session.policy, handoff: session.backend.handoff,
      ownerId: session.ownerId, ownerLabel: session.ownerLabel, ownerRole: session.ownerRole,
      ownerState: session.orphan ? "disconnected" : "connected",
      ...(session.orphan ? { stopsAt: session.orphan.at + this.graceMs(session) } : {}) };
  }
  private graceMs(_session: Session) { return (this.options.graceSeconds ?? (() => graceSeconds()))() * 1000; }
  private idleSeconds(session: Session) { return Math.max(0, (Date.now() - session.lastActivityAt) / 1000); }
  private application(session: Session) {
    const handoff = session.backend.handoff;
    return handoff?.windows.find(window => window.windowId === handoff.selectedWindowId)?.title ?? "application";
  }
  /** Whether the adapter that owns a session is still there: undefined when nothing watches it. */
  private ownerAlive(session: Session): boolean | undefined {
    if (session.ownerRole === "owner") return true;
    return this.callers.isAlive(session.ownerId);
  }
  private holderOf(session: Session): Holder {
    return { label: session.ownerLabel, task: session.taskName, idleSeconds: this.idleSeconds(session),
      alive: this.ownerAlive(session), state: session.state };
  }
  /** Who holds a lease an open was refused for, by the plugin's lease id when it named one. */
  private holderFor(handoff: { workspace: number }, detail?: string): Holder | undefined {
    const open = [...this.sessions.values()].filter(session => session.state !== "closed");
    const lease = detail && /lease ([0-9a-f]{32})/.exec(detail)?.[1];
    const byLease = lease ? open.find(session => session.backend.handoff?.appId === lease) : undefined;
    if (byLease) return this.holderOf(byLease);
    if (lease) return undefined;
    const onWorkspace = open.filter(session => session.backend.handoff?.workspace === handoff.workspace);
    return onWorkspace.length === 1 ? this.holderOf(onWorkspace[0]!) : undefined;
  }
  /** What another agent may know about a session: enough to explain a conflict, nothing it could act with. */
  private summary(session: Session) {
    return { redacted: true, label: session.ownerLabel, taskName: session.taskName, application: this.application(session),
      workspace: session.backend.handoff?.workspace, state: session.state, idleSeconds: Math.round(this.idleSeconds(session)),
      ownerState: session.orphan ? "disconnected" : "connected" };
  }
  /** The owner role sees everything; an agent sees its own in full and the rest as summaries. */
  private list(caller: Caller) {
    return [...this.sessions.values()].map(session =>
      caller.role === "owner" || session.ownerId === caller.id ? this.info(session) : this.summary(session));
  }
  private authorize(session: Session, caller: Caller, verb: string) {
    if (caller.role === "owner" || session.ownerId === caller.id) return;
    const where = session.orphan ? ", its adapter is gone" : this.ownerAlive(session) === false ? ", its adapter is gone" : "";
    throw new OrbitError("SESSION_NOT_OWNED",
      `This session belongs to ${session.ownerLabel} (task "${session.taskName}", ${session.state}${where}, idle ${duration(this.idleSeconds(session))}), not to you, so it cannot be ${verb} from here. ` +
      `Stop only your own sessions with orbit_stop and scope "mine"; the person can stop any session from the panel.`);
  }
  create(input: Record<string, unknown>, caller: Caller = internalCaller): Promise<unknown> {
    if (this.updateLease && this.updateLease.expires > Date.now())
      return Promise.reject(new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly"));
    if (this.shuttingDown) return Promise.reject(new OrbitError("SESSION_CLOSED", "Broker is stopping"));
    const operation = (async () => {
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
      return this.createOwned(input, caller);
    })();
    this.creating.add(operation);
    operation.then(() => this.creating.delete(operation), () => this.creating.delete(operation));
    return operation;
  }
  /** Closed sessions are history, not load: keep the newest 16 for review and drop the rest so they never fill the table. */
  private async pruneClosed() {
    const closed = [...this.sessions.values()].filter(session => session.state === "closed").sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (const session of closed.slice(0, Math.max(0, closed.length - 16))) {
      await session.releasing;
      this.sessions.delete(session.id);
    }
  }
  private async createOwned(input: Record<string, unknown>, caller: Caller) {
    if ((input.backend ?? "native") !== "native" || input.handoff === undefined)
      throw new OrbitError("UNSUPPORTED", "Private desktop sessions were removed. Use native.open for an original application or an explicit native application handoff.");
    const allowed = new Set(["backend", "agentName", "taskName", "conversationName", "projectName", "policy", "profileKey", "handoff", "wait"]);
    if (Object.keys(input).some(key => !allowed.has(key)))
      throw new OrbitError("UNSUPPORTED", "Private profiles, viewports and browser session options were removed");
    const handoff = parseHandoff(input.handoff);
    const waitSeconds = parseWait(input.wait);
    if (!this.native) throw new OrbitError("UNSUPPORTED", "The owner has not configured native application control");
    await this.pruneClosed();
    const live = [...this.sessions.values()].filter(session => session.state !== "closed").length;
    if (live + this.creating.size >= 32)
      throw new OrbitError("LIMIT_REACHED", `Native session limit reached: ${live} sessions are open. Stop the ones you opened (orbit_stop with scope "mine") before opening more`);
    const label = (value: unknown, fallback: string) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
        throw new OrbitError("INVALID_REQUEST", "Session labels require 1 to 80 printable characters");
      return value.trim();
    };
    const suppliedPolicy = input.policy === undefined ? {} : record(input.policy);
    const policy = parsePolicy({ ...nativeApplicationPolicy, ...suppliedPolicy, origins: suppliedPolicy.origins === undefined ? "any" : suppliedPolicy.origins });
    if (policy.origins !== "any") throw new OrbitError("UNSUPPORTED", "Native origin enforcement is unavailable");
    const agentName = label(input.agentName, "SbarOrbit"), taskName = label(input.taskName, "Native application");
    const conversationName = input.conversationName === undefined ? undefined : label(input.conversationName, "");
    const projectName = input.projectName === undefined ? undefined : label(input.projectName, "");
    const key = `${handoff.workspace}:${handoff.address ?? handoff.stableId ?? "*"}`;
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      // Somebody who asked first keeps their place, whether or not the application is free right now.
      const ahead = this.waitQueue.ahead(key, caller.id);
      let busy: OrbitError | undefined;
      if (ahead === 0) {
        try {
          const info = await this.claim(input, handoff, { agentName, taskName, conversationName, projectName, policy }, caller);
          this.waitQueue.leave(key, caller.id);
          return info;
        } catch (error) {
          if (!(error instanceof OrbitError && error.code === "APPLICATION_BUSY")) { this.waitQueue.leave(key, caller.id); throw error; }
          busy = error;
        }
      }
      const queue = waitSeconds ? this.waitQueue.enter(key, caller.id) : undefined;
      const waiting = queue ?? (ahead ? { position: ahead + 1, waiting: ahead + 1 } : undefined);
      const detail = /Application client is already leased by lease .*$/.exec(busy?.message ?? "")?.[0];
      if (Date.now() >= deadline) throw new OrbitError("APPLICATION_BUSY", busyMessage(this.holderFor(handoff, detail), waiting, detail));
      await this.waitForRelease(Math.min(2000, deadline - Date.now()));
    }
  }
  private async claim(input: Record<string, unknown>, handoff: ReturnType<typeof parseHandoff>,
      names: { agentName: string; taskName: string; conversationName?: string; projectName?: string; policy: SessionPolicy }, caller: Caller) {
    const lease = input.profileKey === undefined ? crypto.randomUUID() : text(input.profileKey, "profileKey");
    if (this.leases.has(lease)) throw new OrbitError("PROFILE_BUSY", "Application lease is already held");
    this.leases.add(lease);
    const options = this.native!;
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
        ...names, createdAt: now, lastActivityAt: now,
        ownerId: caller.id, ownerLabel: caller.label, ownerRole: caller.role,
        tail: Promise.resolve(), requests: new Map(), journal: [], tainted: false,
        journalPath: join(this.root, id + ".jsonl") };
      this.sessions.set(id, session);
      backend.onClose(() => { void this.stop(session).catch(() => {}); });
      void this.record(session, journalEntry({ at: new Date().toISOString(), sequence: 1, sessionId: id, actor: "agent",
        actionType: "session.create", decision: { outcome: "allow" }, decidedBy: `owner:${caller.label}` }));
      return this.info(session);
    } catch (error) {
      this.leases.delete(lease);
      if (backend) await backend.close();
      throw error;
    }
  }
  // JSON tuple encoding cannot alias caller/request pairs containing delimiters.
  // Caches belong to this broker instance, not a durable replay barrier across restarts.
  private requireStableOperationScope(caller: Caller) {
    if (caller.role !== "owner" && (!caller.verified || !caller.id.startsWith("conv:")))
      throw new OrbitError("CONVERSATION_REQUIRED", "Set ORBIT_CONVERSATION_ID to the actual host conversation before opening or presenting; retries and reconnects must keep the same caller and requestId");
  }
  private operationKey(caller: Caller, requestId: string) {
    return JSON.stringify([caller.id, requestId]);
  }
  private noteOpened(caller: Caller, workspace: number) {
    if (!this.opened.some(entry => entry.callerId === caller.id && entry.workspace === workspace))
      this.opened.push({ callerId: caller.id, label: caller.label, workspace, at: Date.now() });
  }
  /**
   * A free numbered workspace for this caller: never one another agent's session or window uses, never
   * one a monitor shows. The same request identity gets the same answer, so a retry cannot spread an
   * agent's windows over several workspaces.
   */
  private async allocateWorkspace(requestId: string, caller: Caller) {
    const key = this.operationKey(caller, requestId);
    const known = this.allocations.get(key);
    if (known !== undefined) return known;
    const monitors = record(await NativeBackend.monitors(this.native!));
    const shown = new Set<number>();
    for (const monitor of Array.isArray(monitors.monitors) ? monitors.monitors : [])
      if (typeof record(monitor).workspace === "number") shown.add(record(monitor).workspace as number);
    const used = new Set<number>(), own: number[] = [];
    const take = (ownerId: string, workspace: number | undefined) => {
      if (workspace === undefined) return;
      if (ownerId === caller.id) own.push(workspace); else used.add(workspace);
    };
    for (const session of this.sessions.values()) if (session.state !== "closed") take(session.ownerId, session.backend.handoff?.workspace);
    this.opened = this.opened.filter(entry => Date.now() - entry.at < 6 * 3600_000 && this.callers.isAlive(entry.callerId) !== false);
    for (const entry of this.opened) take(entry.callerId, entry.workspace);
    const workspace = allocateWorkspace({ pool: this.options.workspacePool ?? workspacePool(), own, used, shown });
    if (this.allocations.size >= 1024) this.allocations.delete(this.allocations.keys().next().value as string);
    this.allocations.set(key, workspace);
    this.noteOpened(caller, workspace);
    return workspace;
  }
  private waitForRelease(ms: number) {
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  private wake() { for (const done of [...this.waiters]) done(); }
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
    // Queue/drain state must not retain successful image or tree payloads while idle.
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  act(input: Record<string, unknown>): Promise<unknown> {
    const session = this.get(input.sessionId);
    this.ensureOpen(session);
    const requestId = text(input.requestId, "requestId");
    if (input.actions !== undefined || input.capture !== undefined) return this.batch(session, input, requestId);
    // This parser is pure validation. No request has been admitted or sent to the worker yet.
    let action: ReturnType<NativeBackend["parseAction"]>;
    try { action = session.backend.parseAction(input.action); }
    catch (error) {
      if (error instanceof OrbitError) throw new OrbitError(error.code, error.message, error.diagnosticId, preflightDisposition);
      throw error;
    }
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
  /** Refuse synchronously at admission, then re-decide current authority at queue dispatch. */
  private admit(session: Session, action: { type: string }, destination: string | undefined, method: string | undefined, methodIsImplied: boolean, inputLength: number | undefined, requestId: string, atDispatch = false): () => Promise<unknown> {
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
      throw new OrbitError("POLICY_DENIED", decision.reason, undefined, refusedDisposition);
    };
    const policy = session.policy;
    const decision = decide(policy, action.type, destination, method, methodIsImplied);
    const dispatch = () => this.admit(session, action, destination, method, methodIsImplied, inputLength, requestId, true)();
    if (decision.outcome !== "consult") {
      if (decision.outcome === "deny") refuse(decision);
      // Keep synchronous refusals, but journal an allow only when current authority actually dispatches it.
      if (decision.outcome === "ask") {
        record(decision);
        throw new OrbitError("POLICY_CONFIRMATION_REQUIRED", decision.reason, undefined, refusedDisposition);
      }
      if (atDispatch) record(decision);
      return atDispatch ? () => this.track(session, "agent", action.type, () => this.guarded(session, action)) : dispatch;
    }
    if (!atDispatch) return dispatch;
    // Accepted advisor work belongs to the same queue that pause drains. Otherwise a late allow
    // could apply input after pause has acknowledged that no agent work remains.
    return async () => {
      const pending = journalEntry({
        sequence: session.journal.length + 1, sessionId: session.id, actor: "agent",
        actionType: action.type, decision, url: destination,
        ...(inputLength === undefined ? {} : { inputLength }),
      });
      const answer = await consultAdvisor(policy.advisor!, {
        pending, tail: session.journal.slice(-20), reason: decision.reason, ruleId: decision.ruleId,
      });
      this.ensureOpen(session);
      // The advisor judged one exact policy. A late answer cannot restore removed authority.
      const current = decide(session.policy, action.type, destination, method, methodIsImplied);
      if (current.outcome === "deny") return refuse(current);
      if (current.outcome === "ask") {
        record(current);
        throw new OrbitError("POLICY_CONFIRMATION_REQUIRED", current.reason, undefined, refusedDisposition);
      }
      if (session.policy !== policy) return refuse({ outcome: "deny", reason: "Session policy changed while the advisor decision was pending" });
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
    let capture: BatchCapture | undefined;
    if (input.capture !== undefined) {
      const options = record(input.capture);
      if (Object.keys(options).some(key => key !== "format" && key !== "timeoutMs" && key !== "quietMs") ||
          (options.format !== undefined && options.format !== "image" && options.format !== "text" && options.format !== "both") ||
          (options.timeoutMs !== undefined && (typeof options.timeoutMs !== "number" || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 3000)) ||
          (options.quietMs !== undefined && (typeof options.quietMs !== "number" || !Number.isInteger(options.quietMs) || options.quietMs < 20 || options.quietMs > 1000)))
        throw new OrbitError("INVALID_REQUEST", "capture accepts format image, text or both; timeoutMs from 100 to 3000; and quietMs from 20 to 1000");
      if (options.format === "text" && Object.hasOwn(options, "quietMs"))
        throw new OrbitError("INVALID_REQUEST", "Text capture does not accept pixel-settle options");
      capture = { ...(options.format === "text" || options.format === "both" ? { format: options.format } : {}),
        timeoutMs: options.timeoutMs ?? 1500, ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }) };
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
  private async runBatch(session: Session, actions: { type: string; [key: string]: unknown }[], capture: BatchCapture | undefined, requestId: string) {
    const target = { appId: String(actions[0]!.appId), windowId: String(actions[0]!.windowId) };
    const observing = capture === undefined ? undefined : decide(session.policy, "observe");
    let since: string | undefined;
    if (observing?.outcome === "allow" && capture?.format !== "text") {
      // A visual baseline only: asynchronous application or owner changes may also alter the frame.
      // A difference is not causal evidence for this batch or proof of an application postcondition.
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
        this.ensureOpen(session);
        if ((session.state as State) !== "running") {
          stopped = "PAUSED"; receipts.push({ ...base, status: "not-attempted", reason: stopped }); continue;
        }
        const inputLength = "text" in action ? String(action.text ?? "").length : undefined;
        const result = await this.admit(session, action, undefined, undefined, false, inputLength, requestId, true)();
        receipts.push({ ...base, status: "ok", result });
      } catch (error) {
        this.ensureOpen(session);
        const code = error instanceof OrbitError ? error.code : error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "BACKEND_ERROR";
        const status = code.startsWith("POLICY_") ? "refused" : uncertain.includes(code) ? "uncertain" : "failed";
        receipts.push({ ...base, status, error: errorPayload(error, code, "Native action failed") });
        stopped = status === "uncertain" ? "PRIOR_UNCERTAIN" : "PRIOR_FAILED";
      }
    }
    const completed = receipts.filter(receipt => receipt.status === "ok").length;
    const result: Record<string, unknown> = { ok: completed === actions.length, completed, receipts };
    if (capture !== undefined) {
      this.ensureOpen(session);
      // Input and baseline awaits can interleave with narrowing. Never start a new read on stale authority.
      const currentObservation = decide(session.policy, "observe");
      if (currentObservation.outcome !== "allow") {
        void this.record(session, journalEntry({ at: new Date().toISOString(), requestId,
          sequence: session.journal.length + 1, sessionId: session.id, actor: "agent", actionType: "observe",
          decision: currentObservation, after: session.policy }));
        result.captureError = errorPayload(undefined, "POLICY_DENIED", "Observation is not allowed for this session");
      }
      else if (receipts.every(receipt => receipt.status === "not-attempted")) result.captureError = errorPayload(undefined, "NOT_ATTEMPTED", "No action ran, so there is nothing new to capture");
      else {
        try {
          result.capture = await session.backend.observe(target, capture.format ?? "image", { ...(since === undefined ? {} : { since }), timeoutMs: capture.timeoutMs, ...(capture.quietMs === undefined ? {} : { quietMs: capture.quietMs }) });
          this.taintedBy(session, "observe");
          void this.record(session, journalEntry({
            at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
            actor: "agent", actionType: "observe", decision: { outcome: "allow" },
          }));
        } catch (error) {
          this.ensureOpen(session);
          result.captureError = errorPayload(error, "BACKEND_ERROR", "Capture failed; observe separately");
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
    this.revokeSessionReadViews(session);
    if (session.closing) return session.closing;
    if (session.state === "closed") return this.info(session);
    if (session.orphan?.timer) clearTimeout(session.orphan.timer);
    session.state = "closing";
    const closing = (async () => {
      await session.backend.close();
      await session.tail;
      if (session.forcedClosed) return this.info(session);
      this.leases.delete(session.lease);
      session.state = "closed";
      session.lastActivityAt = Date.now();
      this.wake();
      return this.info(session);
    })();
    // A close that hangs must not hold the application, the lease and every other agent's refusal.
    // Past the deadline the broker lets go on its own and hands the plugin lease back.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forced = new Promise<unknown>(resolve => {
      timer = setTimeout(() => resolve(this.forceClose(session)), this.options.closeDeadlineMs ?? Number(process.env.ORBIT_SESSION_CLOSE_DEADLINE_MS ?? 60_000));
      timer.unref?.();
    });
    const settled = Promise.race([closing, forced]);
    void closing.then(() => clearTimeout(timer), () => clearTimeout(timer));
    session.closing = settled;
    void settled.catch(() => { if (session.closing === settled) session.closing = undefined; });
    return settled;
  }
  private async forceClose(session: Session) {
    this.revokeSessionReadViews(session);
    if (session.state === "closed") return this.info(session);
    session.forcedClosed = true;
    session.state = "closed";
    session.lastActivityAt = Date.now();
    this.leases.delete(session.lease);
    const leaseId = session.backend.handoff?.appId;
    const note = (outcome: string) => this.record(session, journalEntry({ at: new Date().toISOString(),
      sequence: session.journal.length + 1, sessionId: session.id, actor: "person", actionType: "session.forced-close",
      decision: { outcome: "allow" }, decidedBy: outcome }));
    let outcome = "no plugin lease";
    if (leaseId) {
      // Computed after this session left the open set, so the repair path never sees it as live.
      const live = [...this.sessions.values()].filter(other => other.state !== "closed").flatMap(other => other.backend.handoff?.appId ? [other.backend.handoff.appId] : []);
      try { await (this.options.releaseLease ?? releasePluginLease)(leaseId, live); outcome = "plugin lease released"; }
      catch (error) { outcome = `plugin lease release failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`; }
    }
    void note(outcome);
    this.wake();
    return this.info(session);
  }
  /** Pause, shared by the pause request and by an adapter that disappeared. */
  private pause(session: Session) {
    this.revokeSessionReadViews(session);
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
  /**
   * An adapter went away: its sessions pause at once, and stop after the grace period unless the
   * same caller returns. Applications stay open; stopping hands the lease back and closes nothing.
   */
  private adapterGone(id: string) {
    for (const session of this.sessions.values()) {
      if (session.ownerId !== id || ["closing", "closed"].includes(session.state) || session.orphan) continue;
      this.revokeSessionReadViews(session);
      session.orphan = { at: Date.now() };
      const delay = this.graceMs(session);
      session.orphan.timer = setTimeout(() => { void this.stop(session).catch(() => {}); }, delay);
      session.orphan.timer.unref?.();
      void this.record(session, journalEntry({ at: new Date().toISOString(), sequence: session.journal.length + 1, sessionId: session.id,
        actor: "person", actionType: "session.owner-gone", decision: { outcome: "allow" }, decidedBy: `${session.ownerLabel}; stops in ${Math.round(delay / 1000)} s` }));
      void this.pause(session).catch(() => {});
    }
  }
  /** The same caller came back inside the grace period: its sessions stay paused until it resumes them. */
  private adapterBack(id: string) {
    for (const session of this.sessions.values()) {
      if (session.ownerId !== id || !session.orphan) continue;
      if (session.orphan.timer) clearTimeout(session.orphan.timer);
      session.orphan = undefined;
    }
  }
  /** Fixture-only protected connector transport. Existing IPC never calls this method. */
  async dispatchReadTransport(value: unknown, caller: Caller, secret: string): Promise<unknown> {
    if (!this.readTransportRegistry) throw new OrbitError("UNSUPPORTED", "Read views are unavailable");
    let request: Record<string, unknown>, principal: Caller;
    try {
      request = readFields(value, ["method", "params"]);
      if (request.method !== "views.status" && request.method !== "views.read") throw new Error("Not read-only");
      request.params = readFields(request.params, request.method === "views.read" ? ["viewId", "format"] : []);
      principal = Object.freeze({ ...readFields(caller, ["id", "label", "role", "kind", "verified", "pid", "start"]) }) as unknown as Caller;
    } catch { throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused"); }
    const resolved = this.readTransportRegistry.resolve(secret, principal);
    if (!resolved || !this.readChannels.has(resolved.channel)) throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
    return this.dispatch(request, principal, resolved.channel);
  }
  async dispatch(value: unknown, caller: Caller = internalCaller, protectedReadChannel?: object): Promise<unknown> {
    this.callers.touch(caller);
    if (value && typeof value === "object" && "method" in value && value.method === "diagnostics.report") return this.diagnostics.report();
    if (value && typeof value === "object" && "method" in value && value.method === "diagnostics.status") return this.diagnostics.status();
    const request = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const session = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    const result = await this.diagnostics.run({ ...request, params: { ...params, backend: session?.kind ?? params.backend } }, () => this.dispatchRequest(value, caller, protectedReadChannel));
    const control = result && typeof result === "object" ? this.readControlReplies.get(result) : undefined;
    if (control) {
      this.readControlReplies.delete(result as object);
      let current = false;
      try { current = control.current(); } catch { /* Unknown control delivery refuses. */ }
      if (!current) {
        try { control.rollback(); } catch { /* Registry retains quarantine when notification fails. */ }
        throw new OrbitError("READ_CHANNEL_DENIED", "Connector channel request refused");
      }
    }
    // No await after the final protected control check. Ordinary IPC has no such replies.
    return result;
  }
  private async dispatchRequest(value: unknown, caller: Caller, protectedReadChannel?: object): Promise<unknown> {
    const request = record(value);
    const params = request.params === undefined ? {} : record(request.params);
    if (typeof request.method === "string" && request.method.startsWith("views."))
      return this.dispatchReadView(request.method, params, Object.freeze({ ...caller }), protectedReadChannel);
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
      version: (await import("../package.json")).version,
      hostAdapters: await hostAdapterReport((await import("../package.json")).version), platform: process.platform, backend: "native",
      backends: this.native ? ["native"] : [], sessionMode: "native-only", capabilities,
      sessions: this.sessions.size, resources: await resourceStatus(), machine: await describeDesktopMachine(),
      units: process.platform === "linux" ? await installedUnitDrift() : undefined };
    if (request.method === "session.create") return this.create(params, caller);
    // Goodbye from an adapter that is exiting: its sessions pause now instead of at the next poll.
    if (request.method === "caller.detach") { this.callers.detach(caller); return { detached: caller.kind === "adapter" }; }
    // Lease ids only, for the repair command that must never release a lease a session still holds.
    if (request.method === "session.live-leases")
      return { leases: [...this.sessions.values()].filter(session => session.state !== "closed").flatMap(session => session.backend.handoff?.appId ? [session.backend.handoff.appId] : []) };
    if (request.method === "native.open") {
      this.requireStableOperationScope(caller);
      await requireUpdateAdmission(this.updateDirectory);
      if (this.updateLease && this.updateLease.expires > Date.now())
        throw new OrbitError("PROFILE_BUSY", "A broker update is in progress; retry shortly");
      if (!this.native) throw new OrbitError("UNSUPPORTED", "Native opening is not configured");
      if (this.shuttingDown) throw new OrbitError("SESSION_CLOSED", "Broker is stopping");
      const requestId = text(params.requestId, "requestId");
      if (requestId.length > 128) throw new OrbitError("INVALID_REQUEST", "Opening request identity is too long");
      if (Object.keys(params).some(key => !["requestId", "workspace", "applicationId", "window"].includes(key)))
        throw new OrbitError("INVALID_REQUEST", "Unknown native opening field");
      // No workspace means the broker picks a free one for this caller, and keeps that pick for this request identity.
      const auto = params.workspace === undefined;
      const opening = parseNativeOpen({ workspace: auto ? 1 : params.workspace, applicationId: params.applicationId, ...(params.window === undefined ? {} : { window: params.window }) });
      const fingerprint = JSON.stringify(auto ? { ...opening, workspace: "auto" } : opening);
      const key = this.operationKey(caller, requestId);
      const previous = this.nativeOpens.get(key);
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
        const target = auto ? { ...opening, workspace: await this.allocateWorkspace(requestId, caller) } : opening;
        const opened = await NativeBackend.openApplication(options, target);
        this.noteOpened(caller, target.workspace);
        return auto && opened && typeof opened === "object" && !Array.isArray(opened) ? { ...opened, workspace: target.workspace, allocated: true } : opened;
      });
      this.creationTail = result.catch(() => {});
      this.nativeOpens.set(key, { fingerprint, result });
      this.creating.add(result);
      void result.then(() => this.creating.delete(result), () => this.creating.delete(result));
      void result.catch(error => {
        if (error instanceof OrbitError && error.code === "APPROVAL_REQUIRED") this.nativeOpens.delete(key);
      });
      return result;
    }
    if (request.method === "native.candidates") {
      if (!this.native) throw new OrbitError("UNSUPPORTED", "Native handoff is not configured");
      return NativeBackend.candidates(this.native, parseHandoff(params));
    }
    if (request.method === "native.monitors" || request.method === "native.present") {
      const presentation = request.method === "native.present";
      if (presentation) this.requireStableOperationScope(caller);
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
      const key = this.operationKey(caller, requestId);
      if (presentation) {
        const previous = this.nativePresentations.get(key);
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
        this.nativePresentations.set(key, { fingerprint, result });
        void result.catch(error => {
          if (this.nativePresentations.get(key)?.result !== result) return;
          if (!dispatched || (error instanceof OrbitError && error.code === "PRESENTATION_NOT_READY"))
            this.nativePresentations.set(key, { fingerprint });
          else if (error instanceof OrbitError && ["APPROVAL_REQUIRED", "NATIVE_INCOMPATIBLE"].includes(error.code))
            this.nativePresentations.delete(key);
        });
      }
      this.creating.add(result);
      void result.then(() => this.creating.delete(result), () => this.creating.delete(result));
      return result;
    }
    if (request.method === "session.list") return this.list(caller);
    if (request.method === "session.act") {
      this.authorize(this.get(params.sessionId), caller, "acted on");
      return this.act(params);
    }
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
      if (known) this.authorize(known, caller, "removed from the list");
      if (known && known.state !== "closed") throw new OrbitError("SESSION_OPEN", "End the session before removing it from the list");
      if (known) {
        this.revokeSessionReadViews(known);
        // A backend exit marks it closed before asynchronous resource release finishes.
        // Keep the entry if cleanup fails so stop and broker shutdown still report it.
        await known.releasing;
        this.sessions.delete(id);
      }
      return { sessionId: id, forgotten: known !== undefined };
    }
    if (!["session.pause", "session.resume", "session.stop", "session.observe", "session.presence", "session.control", "session.journal", "session.narrow"].includes(String(request.method))) throw new OrbitError("UNSUPPORTED", "Unknown method");
    if (request.method === "session.stop" && params.scope !== undefined) return this.stopMine(params, caller);
    const session = this.get(params.sessionId);
    this.authorize(session, caller, { "session.pause": "paused", "session.resume": "resumed", "session.stop": "stopped",
      "session.observe": "observed", "session.presence": "observed", "session.control": "controlled", "session.journal": "read",
      "session.narrow": "narrowed" }[String(request.method)] ?? "used");
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
    if (request.method === "session.pause") return this.pause(session);
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
  /** Stops exactly the caller's own sessions and lists them, so a permission check and a reader can see nothing else was touched. */
  private async stopMine(params: Record<string, unknown>, caller: Caller) {
    if (params.scope !== "mine" || params.sessionId !== undefined)
      throw new OrbitError("INVALID_REQUEST", 'orbit_stop takes either a sessionId or scope "mine"');
    const mine = [...this.sessions.values()].filter(session => session.ownerId === caller.id && session.state !== "closed");
    const results = await Promise.allSettled(mine.map(session => this.stop(session)));
    return { scope: "mine", owner: caller.label,
      stopped: mine.flatMap((session, index) => results[index]?.status === "fulfilled"
        ? [{ sessionId: session.id, taskName: session.taskName, application: this.application(session), workspace: session.backend.handoff?.workspace }] : []),
      failed: mine.flatMap((session, index) => results[index]?.status === "rejected" ? [{ sessionId: session.id, taskName: session.taskName }] : []) };
  }
  async close() {
    this.readTransportRegistry?.close(this.readAuthority);
    this.readRegistry?.setEnabled(this.readAuthority, false);
    this.callers.stop();
    for (const session of this.sessions.values()) if (session.orphan?.timer) clearTimeout(session.orphan.timer);
    this.shuttingDown = true;
    await Promise.allSettled([...this.creating]);
    const results = await Promise.allSettled([...this.sessions.values()].map(session => this.stop(session)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Native application handback remains incomplete");
  }
}
