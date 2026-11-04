/** Internal owner-enrolled read authority. No production enrollment or native fallback.
 * The broker must resolve recipient objects from a protected owner-approved channel mapping,
 * not Caller.id, environment labels or request roles. Backend functions are trusted runtime
 * dependencies, never request fields. Their lifecycle closures require proof of ALL charged
 * work stopped, including external providers; root exit/EOF alone cannot settle credit.
 * A lease is for the trusted delivery serializer. Release only after its last reference is
 * gone. Already delivered bytes cannot be retracted. No content cache or hidden data copy.
 */
import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { ReadBudgetError, ReadResourceBudget, type OwnedReadLifecycle,
  type ReadBudgetReservation, type ReadBudgetView, type ReadReservationCost } from "./multi-view-read-budget";

export type ReadViewFormat = "text" | "image";
export interface ReadRecipient {
  owner: object; connector: object; instance: object; conversation: object; channel: object;
  pid: number; birth: string;
}
export interface ReadCaptureContext {
  readonly lifecycle: Readonly<OwnedReadLifecycle>;
  readonly isCurrent: () => boolean;
}
export interface ReadViewBackend {
  /** All native, allocation, admission and provider-drain prerequisites must be qualified. */
  admissionReady(): boolean;
  /** Includes live process birth, channel, conversation usage, consent and session epochs. */
  recipientCurrent(recipient: Readonly<ReadRecipient>, consentEpoch: number): boolean;
  bindingCurrent(binding: object, bindingEpoch: number): boolean;
  /** No work or allocation before capture. Cost covers all overlapping representations. */
  prepare(binding: object, format: ReadViewFormat): {
    cost: ReadReservationCost;
    /** Transfer an exclusive, full, unshared Uint8Array. No mutable aliases survive. */
    capture(context: ReadCaptureContext): Promise<Uint8Array>;
  };
}
export interface ReadViewEnrollment {
  recipient: ReadRecipient; consentEpoch: number; expiresAt: number;
  views: readonly { binding: object; bindingEpoch: number; formats: readonly ReadViewFormat[] }[];
}
export interface ReadDeliveryLoan {
  /** Release only after the trusted sink has dropped every reference to this copy. */
  release(): boolean;
}
export interface ReadObservationLease {
  readonly bytes: Uint8Array;
  /** Reserve bounded scratch before allocating a delivery copy. Internal trusted serializer only. */
  reserveDelivery(bytes: number): ReadDeliveryLoan;
  /** Trusted serializer only. Idempotent, not authority or proof of reader stop. */
  release(): void;
}
export type ReadViewErrorCode = "INVALID" | "DENIED" | "OFF" | "LIMIT" | "BUSY" | "UNCONFIRMED" | "BACKEND";
export class ReadViewError extends Error {
  constructor(readonly code: ReadViewErrorCode) { super("Read view request refused"); this.name = "ReadViewError"; }
}
function fail(code: ReadViewErrorCode): never { throw new ReadViewError(code); }
function object(value: unknown): value is object { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
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
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key))) fail("INVALID");
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID");
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch { fail("INVALID"); }
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const recipientKeys = ["owner", "connector", "instance", "conversation", "channel", "pid", "birth"] as const;
function recipientSnapshot(value: unknown): Readonly<ReadRecipient> {
  const item = fields(value, recipientKeys);
  if (![item.owner, item.connector, item.instance, item.conversation, item.channel].every(object)
      || !integer(item.pid) || item.pid < 2 || typeof item.birth !== "string" || !/^\d{1,20}$/.test(item.birth)) fail("INVALID");
  return item as unknown as Readonly<ReadRecipient>;
}
interface View {
  id: string; binding: object; epoch: number; formats: readonly ReadViewFormat[];
  budgetView: ReadBudgetView; entries: Set<ReadBudgetReservation>; disposed: boolean;
}
interface Enrollment {
  token: string; recipient: ReadRecipient; snapshot: Readonly<ReadRecipient>;
  consentEpoch: number; expiresAt: number; views: View[]; revoked: boolean;
}

export class ReadViewRegistry {
  #authority: object;
  #budget: ReadResourceBudget;
  #backend: ReadViewBackend;
  #now: () => number;
  #enabled = false;
  #enrolling = false;
  #timing = false;
  #clockFault = false;
  #lastTime = -Infinity;
  #generation = 0;
  #advance(): void {
    if (this.#generation >= Number.MAX_SAFE_INTEGER) { this.#enabled = false; return; }
    this.#generation++;
  }
  #grants = new Map<string, Enrollment>();
  // Bounded by budget views, including revoked-but-unreconciled work. No tombstone history.
  #records = new Set<Enrollment>();
  constructor(options: { ownerAuthority: object; budget: ReadResourceBudget; backend: ReadViewBackend; now?: () => number }) {
    if (!object(options.ownerAuthority) || !(options.budget instanceof ReadResourceBudget)
        || !options.backend || ![options.backend.admissionReady, options.backend.recipientCurrent,
          options.backend.bindingCurrent, options.backend.prepare].every(fn => typeof fn === "function")
        || options.now !== undefined && typeof options.now !== "function") fail("INVALID");
    this.#authority = options.ownerAuthority; this.#budget = options.budget; this.#backend = options.backend;
    this.#now = options.now ?? (() => performance.now());
  }
  #owner(authority: object): void { if (authority !== this.#authority) fail("DENIED"); }
  #time(): number {
    if (this.#clockFault) fail("DENIED");
    if (this.#timing) { this.#failClock(); fail("DENIED"); }
    this.#timing = true;
    try {
      const now = this.#now();
      if (this.#clockFault || typeof now !== "number" || !Number.isFinite(now) || now < this.#lastTime) fail("DENIED");
      this.#lastTime = now; return now;
    } catch { this.#failClock(); fail("DENIED"); }
    finally { this.#timing = false; }
  }
  #failClock(): void {
    if (this.#clockFault) return;
    this.#clockFault = true; this.#enabled = false; this.#advance();
    for (const entry of [...this.#records]) this.#revoke(entry);
  }
  #ready(): boolean { try { return this.#backend.admissionReady() === true; } catch { return false; } }
  setEnabled(authority: object, enabled: boolean): void {
    this.#owner(authority);
    if (typeof enabled !== "boolean") fail("INVALID");
    if (enabled && this.#clockFault) fail("DENIED");
    this.#advance(); this.#enabled = enabled;
    if (!enabled) for (const entry of [...this.#records]) this.#revoke(entry);
  }
  enroll(authority: object, input: ReadViewEnrollment) {
    this.#owner(authority);
    // Qualification, clocks and budget calls can synchronously reenter trusted code.
    // Do not expose a partially checked binding or charge any nested enrollment.
    if (this.#enrolling || this.#timing) fail("BUSY");
    this.#enrolling = true;
    try { return this.#enroll(input); }
    finally { this.#enrolling = false; }
  }
  #enroll(input: ReadViewEnrollment) {
    if (!this.#enabled) fail("OFF");
    const generation = this.#generation;
    this.#sweep();
    const data = fields(input, ["recipient", "consentEpoch", "expiresAt", "views"]);
    const snapshot = recipientSnapshot(data.recipient), now = this.#time();
    if (!integer(data.consentEpoch) || typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt)
        || data.expiresAt <= now || data.expiresAt - now > 600000) fail("INVALID");
    const requested = dense(data.views, 2).map((raw: unknown) => {
      const view = fields(raw, ["binding", "bindingEpoch", "formats"]);
      const formats = dense(view.formats, 2);
      if (!object(view.binding) || !integer(view.bindingEpoch)
          || formats.some(format => format !== "text" && format !== "image")
          || new Set(formats).size !== formats.length) fail("INVALID");
      return { binding: view.binding, epoch: view.bindingEpoch, formats: formats as readonly ReadViewFormat[] };
    });
    if (new Set(requested.map(view => view.binding)).size !== requested.length) fail("INVALID");
    // A selected client binding cannot acquire a second feature lease in another enrollment.
    for (const entry of this.#records) for (const view of entry.views)
      if (!view.disposed && requested.some(item => item.binding === view.binding)) fail("LIMIT");
    if (!this.#ready()) fail("DENIED");
    try {
      if (this.#backend.recipientCurrent(snapshot, data.consentEpoch) !== true
          || requested.some(view => this.#backend.bindingCurrent(view.binding, view.epoch) !== true)) fail("DENIED");
    } catch { fail("DENIED"); }
    // Recheck after trusted callbacks, which may synchronously disable the registry.
    const checkedAt = this.#time();
    const after = recipientSnapshot(data.recipient);
    // No callbacks after this fence may publish stale consent or a replaced principal.
    if (data.expiresAt <= checkedAt || !recipientKeys.every(key => after[key] === snapshot[key])
        || !this.#enabled || generation !== this.#generation) fail("DENIED");
    const token = randomBytes(32).toString("hex");
    const ids = requested.map(() => randomBytes(12).toString("hex"));
    if ([...this.#records].some(entry => entry.token === token)
        || new Set(ids).size !== ids.length || [...this.#records].some(entry => entry.views.some(view => ids.includes(view.id)))) fail("LIMIT");
    if (!this.#enabled || generation !== this.#generation) fail("DENIED");
    const views: View[] = [];
    try {
      for (const [index, view] of requested.entries()) views.push({ ...view, id: ids[index]!,
        budgetView: this.#budget.bindView(snapshot.conversation), entries: new Set(), disposed: false });
      if (!this.#enabled || generation !== this.#generation) fail("DENIED");
    } catch (error) {
      for (const view of views) { this.#budget.revokeView(view.budgetView); this.#budget.disposeView(view.budgetView); }
      this.#translate(error);
    }
    const entry: Enrollment = { token, recipient: data.recipient as ReadRecipient,
      snapshot, consentEpoch: data.consentEpoch, expiresAt: data.expiresAt, views, revoked: false };
    this.#grants.set(entry.token, entry); this.#records.add(entry);
    return Object.freeze({ grant: entry.token, views: Object.freeze(views.map(view => Object.freeze({ id: view.id, formats: view.formats }))) });
  }
  #translate(error: unknown): never {
    if (error instanceof ReadBudgetError) fail(error.code === "LIMIT" ? "LIMIT" : error.code === "BUSY" ? "BUSY" : "DENIED");
    fail("BACKEND");
  }
  #sweep(): void {
    if (this.#clockFault) return;
    const now = this.#time();
    for (const entry of [...this.#records]) if (!entry.revoked && now >= entry.expiresAt) this.#revoke(entry);
  }
  #collect(entry: Enrollment): void {
    if (!entry.revoked) return;
    for (const view of entry.views) if (!view.disposed && view.entries.size === 0) {
      try { this.#budget.disposeView(view.budgetView); view.disposed = true; }
      catch { /* Never infer stop or discard unresolved metadata from a stale callback. */ }
    }
    if (entry.views.every(view => view.disposed)) this.#records.delete(entry);
  }
  #revoke(entry: Enrollment): void {
    if (entry.revoked) return;
    entry.revoked = true; this.#grants.delete(entry.token);
    for (const view of entry.views) {
      try { this.#budget.revokeView(view.budgetView); } catch { /* Keep unresolved entry fail closed. */ }
    }
    this.#collect(entry);
  }
  #current(entry: Enrollment, view: View): boolean {
    let current = false;
    const generation = this.#generation;
    try {
      const snapshot = recipientSnapshot(entry.recipient);
      current = this.#enabled && !entry.revoked && this.#time() < entry.expiresAt
        && recipientKeys.every(key => snapshot[key] === entry.snapshot[key]) && this.#ready()
        && this.#backend.recipientCurrent(entry.snapshot, entry.consentEpoch) === true
        && this.#backend.bindingCurrent(view.binding, view.epoch) === true;
      // Finish all reentrant clock/snapshot callbacks before checking raw state.
      const checkedAt = this.#time();
      const after = recipientSnapshot(entry.recipient);
      current = current && checkedAt < entry.expiresAt && recipientKeys.every(key => after[key] === entry.snapshot[key])
        && generation === this.#generation && this.#enabled && !entry.revoked
        && this.#grants.get(entry.token) === entry && this.#records.has(entry);
    } catch { current = false; }
    if (!current) this.#revoke(entry);
    return current;
  }
  revoke(authority: object, grant: string): boolean {
    this.#owner(authority); this.#advance(); const entry = this.#grants.get(grant);
    if (!entry) return false; this.#revoke(entry); return true;
  }
  detach(authority: object, recipient: ReadRecipient): void {
    this.#owner(authority); this.#advance();
    for (const entry of [...this.#records]) if (entry.recipient === recipient) this.#revoke(entry);
  }
  revokeConversation(authority: object, conversation: object): void {
    this.#owner(authority); this.#advance();
    for (const entry of [...this.#records]) if (entry.snapshot.conversation === conversation) this.#revoke(entry);
  }
  invalidateBinding(authority: object, binding: object): void {
    this.#owner(authority); this.#advance();
    for (const entry of [...this.#records]) if (entry.views.some(view => view.binding === binding)) this.#revoke(entry);
  }
  status(recipient: ReadRecipient) {
    this.#sweep();
    const groups: { entry: Enrollment; views: { readonly id: string; readonly formats: readonly ReadViewFormat[] }[] }[] = [];
    if (this.#enabled) for (const entry of [...this.#records]) if (entry.recipient === recipient && !entry.revoked) {
      const views: { readonly id: string; readonly formats: readonly ReadViewFormat[] }[] = [];
      for (const view of entry.views) {
        if (!this.#current(entry, view)) break;
        views.push(Object.freeze({ id: view.id, formats: view.formats }));
      }
      // A later view can invalidate the entire enrollment, including earlier descriptors.
      if (!entry.revoked && views.length === entry.views.length) groups.push({ entry, views });
    }
    this.#sweep();
    // Later enrollment callbacks may also revoke an earlier enrollment or disable usage.
    const views = this.#enabled ? groups.filter(group => !group.entry.revoked).flatMap(group => group.views) : [];
    return Object.freeze({ enabled: this.#enabled, views: Object.freeze(views) });
  }
  async read(recipient: ReadRecipient, grant: string, viewId: string, format: ReadViewFormat): Promise<ReadObservationLease> {
    if (!this.#enabled) fail("OFF");
    if (typeof grant !== "string" || !/^[a-f0-9]{64}$/.test(grant) || typeof viewId !== "string"
        || !/^[a-f0-9]{24}$/.test(viewId) || format !== "text" && format !== "image") fail("DENIED");
    this.#sweep();
    const entry = this.#grants.get(grant), view = entry?.views.find(item => item.id === viewId);
    if (!entry || !view || entry.recipient !== recipient || !view.formats.includes(format)) fail("DENIED");
    if (!this.#current(entry, view)) fail("DENIED");
    let prepared: ReturnType<ReadViewBackend["prepare"]>;
    let cost: ReadReservationCost;
    try {
      const data = fields(this.#backend.prepare(view.binding, format), ["cost", "capture"]);
      const bound = fields(data.cost, ["scratchBytes", "retainedBytes"]);
      if (typeof data.capture !== "function" || !integer(bound.retainedBytes) || bound.retainedBytes > 1048576
          || typeof bound.scratchBytes !== "number" || !Number.isSafeInteger(bound.scratchBytes) || bound.scratchBytes < 0) fail("DENIED");
      cost = { scratchBytes: bound.scratchBytes, retainedBytes: bound.retainedBytes };
      prepared = { cost, capture: data.capture as typeof prepared.capture };
    } catch { fail("BACKEND"); }
    if (!this.#current(entry, view)) fail("DENIED");
    let reservation: ReadBudgetReservation;
    try { reservation = this.#budget.reserve(view.budgetView, cost); } catch (error) { this.#translate(error); }
    view.entries.add(reservation);
    const lifecycle = this.#budget.start(reservation);
    const collect = () => {
      try { this.#budget.inspect(reservation); } catch { view.entries.delete(reservation); }
      this.#collect(entry);
    };
    const callbacks = Object.freeze({
      confirmStopped: (retainResult = false) => { const result = lifecycle.confirmStopped(retainResult); collect(); return result; },
      unknownDrain: () => { const result = lifecycle.unknownDrain(); collect(); return result; },
    });
    let payload: Uint8Array | undefined;
    try {
      // No backend promise outcome itself settles lifecycle credit.
      const candidate = await prepared.capture(Object.freeze({ lifecycle: callbacks, isCurrent: () => this.#current(entry, view) }));
      if (!this.#current(entry, view)) fail("DENIED");
      if (!this.#budget.isDeliverable(reservation)) fail("UNCONFIRMED");
      if (!ArrayBuffer.isView(candidate) || Object.getPrototypeOf(candidate) !== Uint8Array.prototype) fail("BACKEND");
      const buffer = typedBuffer.call(candidate) as ArrayBuffer;
      const length = typedLength.call(candidate) as number;
      if (!(buffer instanceof ArrayBuffer) || typedOffset.call(candidate) !== 0
          || length !== arrayBufferLength.call(buffer) || length === 0 || length > cost.retainedBytes) fail("BACKEND");
      // Transfer, not copy: all backend aliases are detached before trusted delivery.
      // The recipient serializer must not leak mutable aliases beyond this single lease.
      payload = structuredClone(candidate, { transfer: [buffer] });
    } catch (error) {
      // Drop only the registry's result reference. Unknown work remains quarantined.
      try {
        const state = this.#budget.inspect(reservation);
        if (state.phase === "retained") this.#budget.release(reservation);
        else { this.#budget.cancel(reservation); callbacks.unknownDrain(); }
      } catch { /* An adapter may already have confirmed stopped without a result. */ }
      collect();
      if (error instanceof ReadViewError) throw error;
      fail("BACKEND");
    }
    const registry = this;
    let released = false;
    return Object.freeze({
      get bytes(): Uint8Array {
        if (released || !registry.#current(entry, view) || released || !registry.#budget.isDeliverable(reservation) || !payload) fail("DENIED");
        return payload;
      },
      reserveDelivery(bytes: number): ReadDeliveryLoan {
        if (released || !registry.#current(entry, view) || released || !registry.#budget.isDeliverable(reservation)) fail("DENIED");
        let handle: ReturnType<ReadResourceBudget["reserveDelivery"]>;
        try { handle = registry.#budget.reserveDelivery(reservation, bytes); } catch (error) { registry.#translate(error); }
        let returned = false;
        return Object.freeze({ release(): boolean {
          if (returned) return false;
          const result = registry.#budget.releaseDelivery(handle);
          returned = true; collect(); return result;
        } });
      },
      release(): void {
        if (released) return;
        released = true; payload = undefined;
        registry.#budget.release(reservation); collect();
      },
    });
  }
}
