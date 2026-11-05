import { randomBytes } from "node:crypto";
import { types as nodeTypes } from "node:util";

/** Broker-owned read usage fencing. This is not a CLI/MCP switch or an authority source.
 * The injected store must durably commit the exact protected conversation record before
 * returning its acknowledgement. A store rejection or uncertain acknowledgement poisons
 * that conversation for this coordinator's lifetime. Shared-channel failure additionally
 * requires the owner to call poisonAll before processing any further acknowledgement. Nothing here qualifies a store,
 * excludes legacy writers, proves reader drain, or provides a transport delivery fence.
 * onRevoke is a trusted synchronous callback and MUST return undefined. The defensive
 * observer for accidentally returned ordinary promises is best effort, not a universal
 * hostile-Promise guarantee: custom constructor/@@species hooks are out of contract
 * and can prevent standard JavaScript from installing a rejection observer. */
export interface ReadUsageRecord {
  readonly instance: string;
  readonly epoch: number;
  readonly enabled: boolean;
}
export interface ReadUsageStore {
  commit(conversation: object, record: ReadUsageRecord): Promise<void>;
}
export type ReadUsageCode = "INVALID" | "DENIED" | "LIMIT" | "BUSY" | "UNCONFIRMED" | "STALE";
export class ReadUsageError extends Error {
  constructor(readonly code: ReadUsageCode) { super("Read usage operation refused"); this.name = "ReadUsageError"; }
}
function fail(code: ReadUsageCode): never { throw new ReadUsageError(code); }
function validObject(value: unknown): value is object { return value !== null && typeof value === "object" && !Array.isArray(value); }

interface Entry {
  readonly conversation: object;
  epoch: number;
  enabled: boolean;
  uncertain: boolean;
  pending: number;
  tail: Promise<void>;
}

/** Each instance starts disabled. Store records are never read as implicit enablement.
 * An on commit can precede a later queued off when a crash occurs. Restart must discard
 * old Sessions and grants and never infer enabled state from that record. Numeric epochs
 * are instance-local and may repeat; bind a fresh Sessions and registry to each coordinator.
 * The trusted store must enforce an exclusive single writer, including across restarts, and
 * reconcile any unresolved old write before replacement. Timeouts do not stop store work.
 * ownerAuthority, conversations and store are trusted broker objects, not request data.
 * Clock samples and timer primitives are trusted nonblocking runtime seams. Deadline
 * checks constrain observed samples/ACK boundaries, not hard real-time scheduling or cancellation. */
export class ReadUsageCoordinator {
  readonly #authority: object;
  readonly #store: ReadUsageStore;
  readonly #revoke: (conversation: object) => void;
  readonly #deadlineMs: number;
  readonly #instance = randomBytes(32).toString("hex");
  readonly #entries = new Map<object, Entry>();
  #counter = 0;
  #exhausted = false;
  #poisoned = false;
  #settingUp = false;

  constructor(options: { ownerAuthority: object; store: ReadUsageStore; onRevoke: (conversation: object) => void; deadlineMs?: number }) {
    if (!validObject(options.ownerAuthority) || !options.store || typeof options.store.commit !== "function"
        || typeof options.onRevoke !== "function" || options.deadlineMs !== undefined
        && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 3000)) fail("INVALID");
    this.#authority = options.ownerAuthority;
    this.#store = options.store;
    this.#revoke = options.onRevoke;
    this.#deadlineMs = options.deadlineMs ?? 3000;
  }
  #owner(authority: object): void { if (authority !== this.#authority) fail("DENIED"); }
  #entry(conversation: object): Entry {
    const entry = this.#entries.get(conversation);
    if (!entry) fail("DENIED");
    return entry;
  }
  #notify(conversation: object): boolean {
    try {
      const acknowledgement: unknown = this.#revoke(conversation);
      if (acknowledgement === undefined) return true;
      // Trusted callbacks must return undefined. Best-effort observation handles
      // ordinary native/cross-realm promises, never arbitrary thenables. Custom
      // constructor/@@species hooks are out of contract and may defeat observation.
      if (nodeTypes.isPromise(acknowledgement)) void Promise.prototype.then.call(acknowledgement, undefined, () => {});
    } catch { /* Raw callback details never escape this authority boundary. */ }
    return false;
  }
  #refused(): Promise<void> {
    const result = Promise.reject<void>(new ReadUsageError("UNCONFIRMED"));
    // Retain rejection for the caller while making callback reentry safe to ignore.
    void result.catch(() => {});
    return result;
  }
  #poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    const entries = [...this.#entries.values()];
    // Phase one has NO external callbacks. Every conversation is fenced before
    // any observer can reenter, including when epoch space is already exhausted.
    if (this.#counter < Number.MAX_SAFE_INTEGER) this.#counter++;
    for (const entry of entries) {
      entry.enabled = false; entry.uncertain = true;
      entry.epoch = this.#counter;
    }
    // Phase two notifies each registered conversation exactly once for this
    // cohort poison, even if another callback throws, returns a promise or reenters.
    for (const entry of entries) this.#notify(entry.conversation);
  }
  /** Owner-only shared store/cohort failure latch. No stop, cleanup or reconnect receipt. */
  poisonAll(authority: object): void {
    this.#owner(authority);
    this.#poison();
  }
  #next(): number {
    if (this.#poisoned) fail("UNCONFIRMED");
    if (this.#exhausted || this.#counter >= Number.MAX_SAFE_INTEGER) {
      this.#exhausted = true;
      this.#poison();
      fail("LIMIT");
    }
    return ++this.#counter;
  }
  /** Explicit protected registration only. It does not change or read legacy usage. */
  register(authority: object, conversation: object): void {
    this.#owner(authority);
    if (this.#settingUp) { this.#poison(); fail("UNCONFIRMED"); }
    if (this.#poisoned) fail("UNCONFIRMED");
    if (!validObject(conversation)) fail("INVALID");
    if (this.#entries.has(conversation)) fail("INVALID");
    if (this.#entries.size >= 4) fail("LIMIT");
    this.#entries.set(conversation, { conversation, epoch: this.#next(), enabled: false, uncertain: false, pending: 0, tail: Promise.resolve() });
  }
  /** Exact synchronous fence for Sessions usageCurrent. Unknown and old epochs deny. */
  usageCurrent = (conversation: object, epoch: number): boolean => {
    const entry = this.#entries.get(conversation);
    return !!entry && !this.#poisoned && !this.#exhausted && !entry.uncertain && entry.enabled && entry.epoch === epoch;
  };
  /** Sessions usageVersion shape. This does not read or authenticate any label. */
  usageVersion = async (conversation: object): Promise<{ conversation: object; epoch: number; enabled: boolean }> => {
    const entry = this.#entry(conversation);
    return Object.freeze({ conversation: entry.conversation, epoch: entry.epoch,
      enabled: entry.enabled && !entry.uncertain && !this.#exhausted && !this.#poisoned });
  };
  /** Every accepted off fences immediately, including while a previous commit is pending.
   * Queue exhaustion and notification failure also leave the conversation disabled. */
  off(authority: object, conversation: object): Promise<void> {
    this.#owner(authority);
    if (this.#settingUp) { this.#poison(); return this.#refused(); }
    if (this.#poisoned) return this.#refused();
    const entry = this.#entry(conversation);
    const epoch = this.#next();
    entry.epoch = epoch;
    entry.enabled = false;
    const result = this.#enqueue(entry, epoch, false);
    if (!this.#notify(conversation)) entry.uncertain = true;
    if (entry.uncertain) return result.then(() => fail("UNCONFIRMED"), () => fail("UNCONFIRMED"));
    return result;
  }
  /** Only the protected owner may request on. No old grant is restored. */
  on(authority: object, conversation: object): Promise<void> {
    this.#owner(authority);
    if (this.#settingUp) { this.#poison(); return this.#refused(); }
    if (this.#poisoned) return this.#refused();
    const entry = this.#entry(conversation);
    if (entry.uncertain) return Promise.reject(new ReadUsageError("UNCONFIRMED"));
    if (entry.pending >= 8) return Promise.reject(new ReadUsageError("BUSY"));
    const epoch = this.#next();
    entry.epoch = epoch;
    entry.enabled = false;
    const result = this.#enqueue(entry, epoch, true);
    if (!this.#notify(conversation)) entry.uncertain = true;
    if (entry.uncertain) return result.then(() => fail("UNCONFIRMED"), () => fail("UNCONFIRMED"));
    return result;
  }
  #enqueue(entry: Entry, epoch: number, enabled: boolean): Promise<void> {
    if (this.#poisoned) return this.#refused();
    if (entry.pending >= 8) {
      // The synchronous fence happened, but no durable off was acknowledged.
      entry.uncertain = true;
      return Promise.reject(new ReadUsageError("UNCONFIRMED"));
    }
    entry.pending++;
    let startedAt: number;
    this.#settingUp = true;
    try { startedAt = performance.now(); } catch {
      entry.enabled = false; entry.uncertain = true; entry.pending--; return this.#refused();
    } finally { this.#settingUp = false; }
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || this.#poisoned || this.#exhausted || entry.uncertain) {
      entry.enabled = false; entry.uncertain = true; entry.pending--; return this.#refused();
    }
    const expiresAt = startedAt + this.#deadlineMs;
    if (!Number.isFinite(expiresAt) || expiresAt <= startedAt) {
      entry.enabled = false; entry.uncertain = true; entry.pending--; return this.#refused();
    }
    let lastSample = startedAt;
    const expired = () => {
      let now: number;
      try { now = performance.now(); } catch { return true; }
      if (typeof now !== "number" || !Number.isFinite(now) || now < lastSample || now >= expiresAt) return true;
      lastSample = now; return false;
    };
    const record = Object.freeze({ instance: this.#instance, epoch, enabled });
    const run = entry.tail.then(async () => {
      if (expired()) { entry.enabled = false; entry.uncertain = true; }
      if (entry.uncertain || this.#poisoned) fail("UNCONFIRMED");
      try {
        const pending = this.#store.commit(entry.conversation, record);
        if (!nodeTypes.isPromise(pending)) fail("UNCONFIRMED");
        await pending;
      } catch { entry.enabled = false; entry.uncertain = true; fail("UNCONFIRMED"); }
      // A delayed event loop cannot turn an already expired commit into an acknowledgement.
      if (expired()) { entry.enabled = false; entry.uncertain = true; }
      // Queue overflow or a callback failure can occur while a commit is in flight.
      if (entry.uncertain || this.#exhausted || this.#poisoned) fail("UNCONFIRMED");
      // A newer off/on can arrive while the store was awaited. Never publish stale on.
      if (enabled && entry.epoch !== epoch) fail("STALE");
    });
    // The timer limits caller waiting, not the store. Keep the unresolved run as the
    // ordering tail and charged pending work. Late settlement cannot clear uncertainty.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerActive = true;
    const deadline = new Promise<never>((_resolve, reject) => {
      // Ordering is not reserved until the final ACK promise exists. Refuse any
      // mutation reentered through synchronous timer setup just like initial clock setup.
      this.#settingUp = true;
      try {
        timer = setTimeout(() => {
          if (!timerActive) return;
          timerActive = false;
          entry.enabled = false; entry.uncertain = true;
          reject(new ReadUsageError("UNCONFIRMED"));
        }, this.#deadlineMs);
      } catch {
        timerActive = false;
        entry.enabled = false; entry.uncertain = true;
        reject(new ReadUsageError("UNCONFIRMED"));
      } finally { this.#settingUp = false; }
    });
    const acknowledgement = Promise.race([run, deadline]).finally(() => {
      // Authority expires before timer cleanup. A failed clear may leave a runtime
      // timer alive until expiry, but its stale callback can no longer mutate state.
      timerActive = false;
      try { if (timer !== undefined) clearTimeout(timer); }
      catch { entry.enabled = false; entry.uncertain = true; fail("UNCONFIRMED"); }
    }).then(() => {
      // The caller acknowledgement has its own final fence, including an off whose
      // store already settled while ordering/deadline cleanup was still pending.
      if (expired()) { entry.enabled = false; entry.uncertain = true; }
      // Clock sampling is a trusted callback seam; recheck reentrant poison/off after it.
      if (this.#poisoned || this.#exhausted || entry.uncertain) fail("UNCONFIRMED");
      // An enabled ACK must still describe this exact on at the final boundary.
      // Off only acknowledges its durable write, even if a later on was requested.
      if (enabled) {
        if (entry.epoch !== epoch) fail("STALE");
        entry.enabled = true; // Sole publication point. No callbacks or await follow.
      }
    });
    // Both settlements are required. A timeout may settle the public ACK while
    // the real store is still live; a completed store may precede a failed final
    // ACK fence. Neither case permits queued dispatch or releases pending charge.
    const storeStopped = run.then(() => {}, () => {});
    const ackSettled = acknowledgement.then(() => {}, () => {});
    entry.tail = Promise.all([storeStopped, ackSettled]).then(() => { entry.pending--; });
    return acknowledgement;
  }
}
