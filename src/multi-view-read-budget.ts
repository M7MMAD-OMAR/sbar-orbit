/** Dormant internal reservation accounting, not desktop authority or an OS drain verifier.
 * No production instance, timers, helpers, queues or observers are created here.
 * A trusted reader adapter must enforce the declared allocation bounds and call
 * confirmStopped only after proving its owned work quiescent. Never mint that
 * proof from a client timeout, raw worker reply, JSON field or parent PID alone. */
export interface ReadBudgetLimits {
  deviceBytes: number; viewBytes: number; maxViews: number; maxConversations: number;
  maxViewsPerConversation: number; maxEntriesPerView: number; maxReferences: number;
}
export const READ_BUDGET_LIMITS: Readonly<ReadBudgetLimits> = Object.freeze({
  deviceBytes: 32 * 1024 * 1024, viewBytes: 16 * 1024 * 1024, maxViews: 8,
  maxConversations: 4, maxViewsPerConversation: 2, maxEntriesPerView: 2, maxReferences: 32,
});
export type ReadBudgetCode = "INVALID" | "LIMIT" | "BUSY" | "HANDLE" | "STATE" | "REVOKED";
export class ReadBudgetError extends Error {
  constructor(readonly code: ReadBudgetCode, message: string) { super(message); this.name = "ReadBudgetError"; }
}
function fail(code: ReadBudgetCode, message: string): never { throw new ReadBudgetError(code, message); }
/** Snapshot data properties before touching accounting. Never execute request getters. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID", "Expected plain read budget data");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !allowed.includes(key))) fail("INVALID", "Unknown read budget field");
    const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID", "Read budget accessors are not accepted");
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch { fail("INVALID", "Invalid read budget data"); }
}
function natural(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
declare const viewBrand: unique symbol;
declare const reservationBrand: unique symbol;
declare const deliveryBrand: unique symbol;
export type ReadBudgetView = Readonly<{ readonly [viewBrand]: true }>;
export type ReadBudgetReservation = Readonly<{ readonly [reservationBrand]: true }>;
export type ReadDeliveryReservation = Readonly<{ readonly [deliveryBrand]: true }>;
export const READ_DELIVERY_SCRATCH_LIMIT = 65536;
export interface ReadReservationCost { scratchBytes: number; retainedBytes: number }
export interface OwnedReadLifecycle {
  /** Trusted adapter callback only. true retains one result reference, never a grant. */
  confirmStopped(retainResult?: boolean): boolean;
  /** Helper stop is unknown: keep capture and byte credit occupied until reconciled. */
  unknownDrain(): boolean;
}
type Phase = "reserved" | "running" | "cancel_pending" | "quarantined" | "retained";
interface ViewState { conversation: object; bytes: number; entries: number; revoked: boolean }
interface Entry {
  view: ViewState; cost: Readonly<ReadReservationCost>; phase: Phase;
  bytes: number; references: number; invalidated: boolean;
  delivery?: ReadDeliveryReservation;
}

export class ReadResourceBudget {
  #limits: Readonly<ReadBudgetLimits>;
  get limits(): Readonly<ReadBudgetLimits> { return this.#limits; }
  #views = new Map<ReadBudgetView, ViewState>();
  #conversations = new Map<object, number>();
  #entries = new Map<ReadBudgetReservation, Entry>();
  #capture: ReadBudgetReservation | undefined;
  #deliveries = new Map<ReadDeliveryReservation, { reservation: ReadBudgetReservation; entry: Entry; bytes: number }>();
  #releasedDeliveries = new WeakSet<ReadDeliveryReservation>();
  #bytes = 0;

  constructor(options: Partial<ReadBudgetLimits> = {}) {
    const snapshot = fields(options, Object.keys(READ_BUDGET_LIMITS));
    const limits = { ...READ_BUDGET_LIMITS, ...snapshot } as ReadBudgetLimits;
    for (const key of Object.keys(READ_BUDGET_LIMITS) as (keyof ReadBudgetLimits)[]) {
      const value = limits[key];
      if (!natural(value) || value === 0 || value > READ_BUDGET_LIMITS[key]) fail("INVALID", "Read budget limits may only be narrowed");
    }
    if (limits.viewBytes > limits.deviceBytes) fail("INVALID", "View byte limit exceeds device byte limit");
    this.#limits = Object.freeze(limits);
  }

  /** Internal enrollment key identity only. This method does not authenticate or authorize a conversation. */
  bindView(conversation: object): ReadBudgetView {
    try {
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) fail("INVALID", "Expected an internal conversation key");
    } catch { fail("INVALID", "Invalid internal conversation key"); }
    const count = this.#conversations.get(conversation) ?? 0;
    if (this.#views.size >= this.#limits.maxViews || count >= this.#limits.maxViewsPerConversation
        || (count === 0 && this.#conversations.size >= this.#limits.maxConversations)) fail("LIMIT", "Read view enrollment capacity reached");
    const handle = Object.freeze(Object.create(null)) as ReadBudgetView;
    this.#views.set(handle, { conversation, bytes: 0, entries: 0, revoked: false });
    this.#conversations.set(conversation, count + 1);
    return handle;
  }

  #view(handle: ReadBudgetView): ViewState {
    const state = this.#views.get(handle);
    if (!state) fail("HANDLE", "Unknown read view handle");
    return state;
  }
  #entry(handle: ReadBudgetReservation): Entry {
    const entry = this.#entries.get(handle);
    if (!entry) fail("HANDLE", "Unknown read reservation handle");
    return entry;
  }
  #subtract(entry: Entry, bytes: number) {
    entry.bytes -= bytes; entry.view.bytes -= bytes; this.#bytes -= bytes;
  }
  #remove(handle: ReadBudgetReservation, entry: Entry) {
    if (entry.delivery !== undefined) fail("STATE", "Outstanding delivery storage cannot be released");
    this.#subtract(entry, entry.bytes);
    entry.view.entries--;
    this.#entries.delete(handle);
    if (this.#capture === handle) this.#capture = undefined;
  }

  /** Reserve the peak overlap before starting any owned work. No automatic queue or eviction. */
  reserve(view: ReadBudgetView, cost: ReadReservationCost): ReadBudgetReservation {
    const snapshot = fields(cost, ["scratchBytes", "retainedBytes"]);
    if (!natural(snapshot.scratchBytes) || !natural(snapshot.retainedBytes)) fail("INVALID", "Invalid read allocation bounds");
    const scratchBytes = snapshot.scratchBytes, retainedBytes = snapshot.retainedBytes;
    const state = this.#view(view); // Recheck after any caller-owned proxy inspection.
    if (state.revoked) fail("REVOKED", "Read view is revoked");
    const bytes = scratchBytes + retainedBytes;
    if (!Number.isSafeInteger(bytes) || bytes === 0) fail("INVALID", "Read reservation must have a finite positive peak");
    if (this.#capture !== undefined) fail("BUSY", "Read capture capacity remains occupied");
    if (state.entries >= this.#limits.maxEntriesPerView || state.bytes + bytes > this.#limits.viewBytes
        || this.#bytes + bytes > this.#limits.deviceBytes) fail("LIMIT", "Read allocation capacity reached");
    const handle = Object.freeze(Object.create(null)) as ReadBudgetReservation;
    this.#entries.set(handle, { view: state, cost: Object.freeze({ scratchBytes, retainedBytes }),
      phase: "reserved", bytes, references: 0, invalidated: false });
    state.bytes += bytes; state.entries++; this.#bytes += bytes; this.#capture = handle;
    return handle;
  }

  /** Call before spawning. The lifecycle closure belongs to the trusted adapter, not a request/model. */
  start(handle: ReadBudgetReservation): Readonly<OwnedReadLifecycle> {
    const entry = this.#entry(handle);
    if (entry.phase !== "reserved" || this.#capture !== handle) fail("STATE", "Read reservation is not startable");
    entry.phase = "running";
    return Object.freeze({
      confirmStopped: (retainResult = false) => {
        if (this.#entries.get(handle) !== entry || entry.phase === "retained") return false;
        if (typeof retainResult !== "boolean") fail("INVALID", "Expected an explicit result-retention decision");
        const publish = retainResult && entry.phase === "running" && !entry.invalidated && !entry.view.revoked;
        if (publish && entry.cost.retainedBytes === 0) {
          entry.phase = "quarantined"; entry.invalidated = true;
          fail("STATE", "Result storage was not reserved; discard and confirm owned work stopped");
        }
        if (publish) {
          this.#subtract(entry, entry.cost.scratchBytes);
          entry.phase = "retained"; entry.references = 1;
          this.#capture = undefined;
        } else this.#remove(handle, entry);
        return true;
      },
      unknownDrain: () => {
        if (this.#entries.get(handle) !== entry || entry.phase === "retained" || entry.phase === "quarantined") return false;
        entry.phase = "quarantined"; entry.invalidated = true;
        return true;
      },
    });
  }

  /** Cancellation invalidates delivery, but does not claim that any owned OS work has stopped. */
  cancel(handle: ReadBudgetReservation): boolean {
    const entry = this.#entry(handle), changed = !entry.invalidated;
    entry.invalidated = true;
    if (entry.phase === "reserved") this.#remove(handle, entry); // Known no-start boundary.
    else if (entry.phase === "running") entry.phase = "cancel_pending";
    return changed;
  }
  revokeView(view: ReadBudgetView): void {
    const state = this.#view(view); state.revoked = true;
    for (const [handle, entry] of this.#entries) if (entry.view === state) this.cancel(handle);
  }
  disposeView(view: ReadBudgetView): void {
    const state = this.#view(view);
    if (!state.revoked || state.entries !== 0) fail("STATE", "Revoke and drain the read view before disposing it");
    this.#views.delete(view);
    const count = this.#conversations.get(state.conversation)! - 1;
    if (count === 0) this.#conversations.delete(state.conversation);
    else this.#conversations.set(state.conversation, count);
  }

  isDeliverable(handle: unknown): boolean {
    const entry = this.#entries.get(handle as ReadBudgetReservation);
    return entry !== undefined && entry.phase === "retained" && entry.references > 0
      && !entry.invalidated && !entry.view.revoked;
  }
  retain(handle: ReadBudgetReservation): void {
    const entry = this.#entry(handle);
    if (!this.isDeliverable(handle)) fail("STATE", "Read result cannot acquire another reference");
    if (entry.references >= this.#limits.maxReferences) fail("LIMIT", "Read reference capacity reached");
    entry.references++;
  }
  release(handle: ReadBudgetReservation): void {
    const entry = this.#entry(handle);
    if (entry.phase !== "retained" || entry.references < 1) fail("STATE", "Only a retained read reference can be released");
    // Pending delivery conservatively holds the original result and its copy credit.
    // Keep a retained entry with zero references, not deliverable or disposable.
    if (--entry.references === 0 && entry.delivery === undefined) this.#remove(handle, entry);
  }
  /** Charge copy storage BEFORE allocating it. This is not a capture or a new entry. */
  reserveDelivery(reservation: ReadBudgetReservation, bytes: number): ReadDeliveryReservation {
    if (!natural(bytes) || bytes === 0) fail("INVALID", "Delivery storage must have a positive safe byte count");
    if (bytes > READ_DELIVERY_SCRATCH_LIMIT) fail("LIMIT", "Delivery storage exceeds its chunk bound");
    const entry = this.#entry(reservation);
    if (!this.isDeliverable(reservation)) fail("STATE", "Read result cannot reserve delivery storage");
    if (entry.delivery !== undefined) fail("LIMIT", "Read result already has outstanding delivery storage");
    if (entry.view.bytes + bytes > this.#limits.viewBytes || this.#bytes + bytes > this.#limits.deviceBytes)
      fail("LIMIT", "Delivery storage exceeds read allocation capacity");
    const handle = Object.freeze(Object.create(null)) as ReadDeliveryReservation;
    this.#deliveries.set(handle, { reservation, entry, bytes });
    entry.delivery = handle;
    entry.bytes += bytes; entry.view.bytes += bytes; this.#bytes += bytes;
    return handle;
  }

  /** Trusted sink-drain owner only. Timeout/revocation does not establish drain. */
  releaseDelivery(handle: ReadDeliveryReservation): boolean {
    const delivery = this.#deliveries.get(handle);
    if (!delivery) {
      if (this.#releasedDeliveries.has(handle)) return false;
      fail("HANDLE", "Unknown read delivery reservation handle");
    }
    const { reservation, entry, bytes } = delivery;
    if (this.#entries.get(reservation) !== entry || entry.phase !== "retained" || entry.delivery !== handle)
      fail("STATE", "Read delivery storage ownership is inconsistent");
    this.#deliveries.delete(handle);
    this.#releasedDeliveries.add(handle); // Weak identity tombstone, not an unbounded retained map.
    delete entry.delivery;
    this.#subtract(entry, bytes);
    if (entry.references === 0) this.#remove(reservation, entry);
    return true;
  }

  inspect(handle: ReadBudgetReservation) {
    const entry = this.#entry(handle);
    return Object.freeze({ phase: entry.phase, references: entry.references, bytes: entry.bytes, deliverable: this.isDeliverable(handle) });
  }
  status() {
    let quarantined = 0, retainedReferences = 0;
    for (const entry of this.#entries.values()) {
      if (entry.phase === "quarantined") quarantined++;
      retainedReferences += entry.references;
    }
    return Object.freeze({ views: this.#views.size, conversations: this.#conversations.size, entries: this.#entries.size,
      captureOccupied: this.#capture !== undefined, bytes: this.#bytes, quarantined, retainedReferences });
  }
}
