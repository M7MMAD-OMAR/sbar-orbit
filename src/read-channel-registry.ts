/** Protected connector enrollment and transport attribution, not a desktop grant.
 * Owner methods accept a private broker capability after owner credential verification.
 * Both secret types travel ONLY over the protected host/connector channel, never model
 * tool arguments, stdout, logs or status. Existing IPC has no kernel peer credentials:
 * a secret plus verified PID/birth is cooperative same-UID attribution, not a sandbox.
 * No reader credit is released here. onRevoke must invalidate downstream grants; charged
 * reader work and retained data remain owned by their separate budget/drain lifecycle.
 * Active downstream integration requires synchronous onRevoke invalidation AND an
 * isCurrent(channel) final-delivery fence; omitting either is an unqualified bridge.
 */
import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { Caller } from "./caller";
import type { ReadRecipient, ReadViewFormat } from "./multi-view-views";

export interface ReadConnectorIdentity {
  readonly callerId: string; readonly pid: number; readonly birth: string;
  readonly installation: object; readonly instance: object; readonly conversation: object;
}
export interface ReadChannelView {
  readonly binding: object; readonly bindingEpoch: number; readonly formats: readonly ReadViewFormat[];
}
export interface ReadChannelEnrollment extends ReadConnectorIdentity {
  /** Owner request identity only, never a JSON request id or model-selected binding. */
  readonly key: object; readonly expiresAt: number; readonly views: readonly ReadChannelView[];
}
export interface ResolvedReadChannel {
  readonly channel: object; readonly recipient: Readonly<ReadRecipient>; readonly callerId: string;
  readonly views: readonly ReadChannelView[]; readonly expiresAt: number;
}
export type ReadChannelCode = "INVALID" | "DENIED" | "BUSY" | "LIMIT" | "CONFLICT";
export class ReadChannelError extends Error {
  constructor(readonly code: ReadChannelCode) { super("Connector channel request refused"); this.name = "ReadChannelError"; }
}
function fail(code: ReadChannelCode): never { throw new ReadChannelError(code); }
function opaque(value: unknown): value is object { return value !== null && typeof value === "object" && !Array.isArray(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** Snapshot bounded arrays without invoking caller methods, iterators or indexed getters. */
function dense(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("INVALID");
    const size = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = size && Object.hasOwn(size, "value") ? size.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > maximum
        || Reflect.ownKeys(value).length !== length + 1) fail("INVALID");
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID");
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch { fail("INVALID"); }
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (!opaque(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID");
    const keys = Reflect.ownKeys(value), result = Object.create(null) as Record<string, unknown>;
    if (keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) fail("INVALID");
    for (const key of required) if (!Object.hasOwn(value, key)) fail("INVALID");
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID");
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch { fail("INVALID"); }
}
function token(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function snapshot(input: ReadChannelEnrollment): Readonly<ReadChannelEnrollment> {
  const item = fields(input, ["key", "callerId", "pid", "birth", "installation", "instance", "conversation", "expiresAt", "views"]);
  if (![item.key, item.installation, item.instance, item.conversation].every(opaque)
      || typeof item.callerId !== "string" || !/^conv:[^\x00-\x1f\x7f]{1,256}$/.test(item.callerId)
      || !positive(item.pid) || item.pid < 2 || typeof item.birth !== "string" || !/^\d{1,20}$/.test(item.birth)
      || typeof item.expiresAt !== "number" || !Number.isFinite(item.expiresAt)) fail("INVALID");
  const views: ReadChannelView[] = dense(item.views, 2).map((raw: unknown) => {
    const view = fields(raw, ["binding", "bindingEpoch", "formats"]);
    const formats = dense(view.formats, 2);
    if (!opaque(view.binding) || !positive(view.bindingEpoch)
        || formats.some(value => value !== "text" && value !== "image")
        || new Set(formats).size !== formats.length) fail("INVALID");
    return Object.freeze({ binding: view.binding, bindingEpoch: view.bindingEpoch,
      formats: formats as readonly ReadViewFormat[] });
  });
  if (new Set(views.map(view => view.binding)).size !== views.length) fail("INVALID");
  return Object.freeze({ ...item, views: Object.freeze(views) }) as unknown as Readonly<ReadChannelEnrollment>;
}
function same(a: Readonly<ReadChannelEnrollment>, b: Readonly<ReadChannelEnrollment>): boolean {
  return a.key === b.key && a.callerId === b.callerId && a.pid === b.pid && a.birth === b.birth
    && a.installation === b.installation && a.instance === b.instance && a.conversation === b.conversation
    && a.expiresAt === b.expiresAt && a.views.length === b.views.length
    && a.views.every((view, index) => { const other = b.views[index]; return other !== undefined
      && view.binding === other.binding && view.bindingEpoch === other.bindingEpoch
      && view.formats.length === other.formats.length && view.formats.every((format, i) => format === other.formats[i]); });
}
interface Entry {
  readonly input: Readonly<ReadChannelEnrollment>; readonly enrollment: string;
  readonly resolved: ResolvedReadChannel; transport?: string; revoked: boolean;
}
export class ReadChannelRegistry {
  #authority: object; #ownerIdentity: object;
  #verify: (identity: ReadConnectorIdentity) => boolean;
  #onRevoke?: (channel: ResolvedReadChannel) => void;
  #clock: () => number;
  #maxChannels: number; #maxIssues: number; #issues = 0;
  #records = new Map<object, Entry>();
  // Lifetime-bounded replay tombstones: <=1024 owner requests and <=2048 secrets.
  #retiredKeys = new Set<object>();
  #usedSecrets = new Set<string>();
  #closed = false; #mutating = false; #checking = false; #timing = false; #attributing = false;
  #clockFault = false; #generation = 0; #lastTime = -Infinity;
  constructor(options: { ownerAuthority: object; ownerIdentity: object;
    processCurrent(identity: ReadConnectorIdentity): boolean;
    onRevoke?: (channel: ResolvedReadChannel) => void; now?: () => number;
    maxChannels?: number; maxIssues?: number }) {
    const value = fields(options, ["ownerAuthority", "ownerIdentity", "processCurrent"], ["onRevoke", "now", "maxChannels", "maxIssues"]);
    const capacity = value.maxChannels === undefined ? 8 : value.maxChannels;
    const issues = value.maxIssues === undefined ? 1024 : value.maxIssues;
    if (!opaque(value.ownerAuthority) || !opaque(value.ownerIdentity) || typeof value.processCurrent !== "function"
        || value.onRevoke !== undefined && typeof value.onRevoke !== "function"
        || value.now !== undefined && typeof value.now !== "function"
        || !positive(capacity) || capacity > 8 || !positive(issues) || issues > 1024) fail("INVALID");
    this.#authority = value.ownerAuthority; this.#ownerIdentity = value.ownerIdentity;
    this.#verify = value.processCurrent as (identity: ReadConnectorIdentity) => boolean;
    this.#onRevoke = value.onRevoke as ((channel: ResolvedReadChannel) => void) | undefined;
    this.#clock = value.now as (() => number) | undefined ?? (() => performance.now());
    this.#maxChannels = capacity; this.#maxIssues = issues;
  }
  #owner(authority: object): void { if (authority !== this.#authority) fail("DENIED"); }
  #time(): number {
    if (this.#clockFault) fail("DENIED");
    if (this.#timing) { this.#failClock(); fail("DENIED"); }
    this.#timing = true;
    try {
      const now = this.#clock();
      if (this.#clockFault || typeof now !== "number" || !Number.isFinite(now) || now < this.#lastTime) fail("DENIED");
      this.#lastTime = now; return now;
    } catch { this.#failClock(); fail("DENIED"); }
    finally { this.#timing = false; }
  }
  #failClock(): void {
    if (this.#clockFault) return;
    this.#clockFault = true; this.#closed = true; this.#advance();
    for (const entry of [...this.#records.values()]) this.#invalidate(entry);
  }
  #advance(): void {
    // Saturation must close admission without interrupting invalidation of other records.
    if (this.#generation >= Number.MAX_SAFE_INTEGER) { this.#closed = true; return; }
    this.#generation++;
  }
  #exclusive<T>(operation: () => T): T {
    if (this.#mutating || this.#checking || this.#timing || this.#attributing) fail("BUSY");
    this.#mutating = true;
    try { return operation(); } finally { this.#mutating = false; }
  }
  #invalidate(entry: Entry): void {
    if (entry.revoked) return;
    entry.revoked = true; this.#retiredKeys.add(entry.input.key); this.#advance();
    // Invalidate before notification. Failure retains this bounded slot in quarantine.
    // Notification never constitutes a stop receipt or releases downstream reader credit.
    try { this.#onRevoke?.(entry.resolved); }
    catch { return; }
    this.#records.delete(entry.input.key);
  }
  #sweep(): void {
    if (this.#clockFault) return;
    const now = this.#time();
    for (const entry of [...this.#records.values()]) if (now >= entry.input.expiresAt) this.#invalidate(entry);
  }
  #proof(input: ReadConnectorIdentity): boolean {
    if (this.#checking) return false;
    this.#checking = true;
    const identity: ReadConnectorIdentity = Object.freeze({ callerId: input.callerId, pid: input.pid,
      birth: input.birth, installation: input.installation, instance: input.instance, conversation: input.conversation });
    try { return this.#verify(identity) === true; } catch { return false; }
    finally { this.#checking = false; }
  }
  #caller(entry: Entry, caller: Caller): boolean {
    if (this.#attributing) return false;
    this.#attributing = true;
    try {
      const value = fields(caller, ["id", "role", "kind", "verified", "pid", "start"], ["label"]);
      return value.verified === true && value.kind === "adapter" && value.role === "agent"
        && value.id === entry.input.callerId && value.pid === entry.input.pid && value.start === entry.input.birth;
    } catch { return false; }
    finally { this.#attributing = false; }
  }
  #live(entry: Entry): boolean {
    const generation = this.#generation;
    let okay = false;
    try {
      const before = this.#time();
      if (before < entry.input.expiresAt && generation === this.#generation && !this.#closed
          && !entry.revoked && this.#records.get(entry.input.key) === entry && this.#proof(entry.input)) {
        const after = this.#time();
        // The last clock callback can itself revoke/close. Fence AFTER it returns.
        okay = after < entry.input.expiresAt && generation === this.#generation && !this.#closed
          && !entry.revoked && this.#records.get(entry.input.key) === entry;
      }
    }
    catch { okay = false; }
    if (!okay) this.#invalidate(entry);
    return okay;
  }
  #fence(entry: Entry, generation: number): boolean {
    try {
      const now = this.#time();
      return now < entry.input.expiresAt && generation === this.#generation && !this.#closed
        && !entry.revoked && this.#records.get(entry.input.key) === entry;
    } catch { return false; }
  }
  #secret(): string {
    if (this.#usedSecrets.size >= 2 * this.#maxIssues) fail("LIMIT");
    let value: string;
    try { value = randomBytes(32).toString("hex"); } catch { fail("DENIED"); }
    if (!token(value) || this.#usedSecrets.has(value)) fail("LIMIT");
    this.#usedSecrets.add(value); return value;
  }
  /** Owner output: convey only through the protected connector installation channel.
   * An idempotent issue after activation returns its SPENT ticket, not a reusable exchange. */
  issue(authority: object, input: ReadChannelEnrollment): Readonly<{ enrollment: string; expiresAt: number }> {
    this.#owner(authority);
    return this.#exclusive(() => {
      if (this.#closed) fail("DENIED");
      this.#sweep();
      const generation = this.#generation, data = snapshot(input), now = this.#time();
      if (data.expiresAt <= now || data.expiresAt - now > 600000) fail("INVALID");
      if (this.#retiredKeys.has(data.key)) fail("CONFLICT");
      const previous = this.#records.get(data.key);
      if (previous) {
        if (!same(previous.input, data)) fail("CONFLICT");
        if (!this.#live(previous)) fail("DENIED");
        return Object.freeze({ enrollment: previous.enrollment, expiresAt: data.expiresAt });
      }
      if (this.#records.size >= this.#maxChannels || this.#issues >= this.#maxIssues) fail("LIMIT");
      // Owner enrollment is an exact selected set, not an implicit duplicate lease.
      for (const entry of this.#records.values()) if (entry.input.instance === data.instance
          || entry.input.views.some(view => data.views.some(other => other.binding === view.binding))) fail("CONFLICT");
      if (!this.#proof(data)) fail("DENIED");
      const checkedAt = this.#time();
      if (checkedAt >= data.expiresAt || generation !== this.#generation || this.#closed) fail("DENIED");
      const enrollment = this.#secret();
      if (generation !== this.#generation || this.#closed || this.#retiredKeys.has(data.key)) fail("DENIED");
      const channel = Object.freeze(Object.create(null)) as object;
      const recipient: Readonly<ReadRecipient> = Object.freeze({ owner: this.#ownerIdentity,
        connector: data.installation, instance: data.instance, conversation: data.conversation,
        channel, pid: data.pid, birth: data.birth });
      const resolved: ResolvedReadChannel = Object.freeze({ channel, recipient, callerId: data.callerId,
        views: data.views, expiresAt: data.expiresAt });
      this.#records.set(data.key, { input: data, enrollment, resolved, revoked: false }); this.#issues++;
      return Object.freeze({ enrollment, expiresAt: data.expiresAt });
    });
  }
  /** One-use exchange. Caller attribution is broker-resolved, not parsed from the body. */
  activate(enrollment: string, caller: Caller): Readonly<{ transport: string; expiresAt: number }> {
    return this.#exclusive(() => {
      if (!token(enrollment) || this.#closed) fail("DENIED");
      this.#sweep();
      const entry = [...this.#records.values()].find(item => item.enrollment === enrollment && item.transport === undefined);
      const generation = this.#generation;
      if (!entry || !this.#caller(entry, caller) || !this.#live(entry) || !this.#caller(entry, caller)
          || !this.#fence(entry, generation)) fail("DENIED");
      const transport = this.#secret();
      if (generation !== this.#generation || this.#closed || entry.revoked || this.#records.get(entry.input.key) !== entry) fail("DENIED");
      entry.transport = transport;
      return Object.freeze({ transport, expiresAt: entry.input.expiresAt });
    });
  }
  /** Header-only transport lookup. Invalid claims never select/revoke another caller. */
  resolve(transport: string | null | undefined, caller: Caller): ResolvedReadChannel | undefined {
    if (this.#checking || this.#mutating || this.#timing || this.#attributing || !token(transport) || this.#closed) return undefined;
    try {
      this.#sweep();
      const entry = [...this.#records.values()].find(item => item.transport === transport);
      const generation = this.#generation;
      if (!entry || !this.#caller(entry, caller) || !this.#live(entry) || !this.#caller(entry, caller)
          || !this.#fence(entry, generation)) return undefined;
      return entry.resolved;
    } catch { return undefined; }
  }
  /** Trusted final-delivery fence. No caller/body can mint an equivalent channel object. */
  isCurrent(channel: object): boolean {
    if (this.#checking || this.#mutating || this.#timing || this.#attributing || this.#closed) return false;
    const entry = [...this.#records.values()].find(item => item.resolved.channel === channel && item.transport !== undefined);
    return entry !== undefined && this.#live(entry);
  }
  revoke(authority: object, key: object): boolean {
    this.#owner(authority); this.#advance();
    const entry = this.#records.get(key); if (!entry || entry.revoked) return false;
    this.#invalidate(entry); return true;
  }
  detach(authority: object, instance: object): void {
    this.#owner(authority); this.#advance();
    for (const entry of [...this.#records.values()]) if (entry.input.instance === instance) this.#invalidate(entry);
  }
  close(authority: object): void {
    this.#owner(authority); this.#closed = true; this.#advance();
    for (const entry of [...this.#records.values()]) this.#invalidate(entry);
  }
  /** Owner-only bounded metadata. No secrets, process ids, labels or selected-view data. */
  status(authority: object) {
    this.#owner(authority);
    try { this.#sweep(); } catch (error) { if (!this.#clockFault) throw error; }
    const entries = [...this.#records.values()];
    const active = entries.filter(entry => !entry.revoked && entry.transport !== undefined).length;
    const pending = entries.filter(entry => !entry.revoked && entry.transport === undefined).length;
    return Object.freeze({ closed: this.#closed, pending, active, quarantined: entries.filter(entry => entry.revoked).length,
      capacity: this.#maxChannels, issuesRemaining: this.#maxIssues - this.#issues });
  }
}
