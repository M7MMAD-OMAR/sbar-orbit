import { randomBytes } from "node:crypto";
import { types as nodeTypes } from "node:util";

/** Broker-owned read usage fencing. This is not a CLI/MCP switch or an authority source.
 * The injected store must durably commit the exact protected conversation record before
 * returning its acknowledgement. A store rejection or uncertain acknowledgement poisons
 * that conversation for this coordinator's lifetime. Nothing here qualifies a store,
 * excludes legacy writers, proves reader drain, or provides a transport delivery fence. */
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
 * ownerAuthority, conversations and store are trusted broker objects, not request data. */
export class ReadUsageCoordinator {
  readonly #authority: object;
  readonly #store: ReadUsageStore;
  readonly #revoke: (conversation: object) => void;
  readonly #deadlineMs: number;
  readonly #instance = randomBytes(32).toString("hex");
  readonly #entries = new Map<object, Entry>();
  #counter = 0;
  #exhausted = false;

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
  #next(): number {
    if (this.#exhausted || this.#counter >= Number.MAX_SAFE_INTEGER) {
      this.#exhausted = true;
      for (const entry of this.#entries.values()) { entry.enabled = false; entry.uncertain = true; }
      fail("LIMIT");
    }
    return ++this.#counter;
  }
  /** Explicit protected registration only. It does not change or read legacy usage. */
  register(authority: object, conversation: object): void {
    this.#owner(authority);
    if (!validObject(conversation)) fail("INVALID");
    if (this.#entries.has(conversation)) fail("INVALID");
    if (this.#entries.size >= 4) fail("LIMIT");
    this.#entries.set(conversation, { conversation, epoch: this.#next(), enabled: false, uncertain: false, pending: 0, tail: Promise.resolve() });
  }
  /** Exact synchronous fence for Sessions usageCurrent. Unknown and old epochs deny. */
  usageCurrent = (conversation: object, epoch: number): boolean => {
    const entry = this.#entries.get(conversation);
    return !!entry && !this.#exhausted && !entry.uncertain && entry.enabled && entry.epoch === epoch;
  };
  /** Sessions usageVersion shape. This does not read or authenticate any label. */
  usageVersion = async (conversation: object): Promise<{ conversation: object; epoch: number; enabled: boolean }> => {
    const entry = this.#entry(conversation);
    return Object.freeze({ conversation: entry.conversation, epoch: entry.epoch,
      enabled: entry.enabled && !entry.uncertain && !this.#exhausted });
  };
  /** Every accepted off fences immediately, including while a previous commit is pending.
   * Queue exhaustion and notification failure also leave the conversation disabled. */
  off(authority: object, conversation: object): Promise<void> {
    this.#owner(authority);
    const entry = this.#entry(conversation);
    const epoch = this.#next();
    entry.epoch = epoch;
    entry.enabled = false;
    const result = this.#enqueue(entry, epoch, false);
    try {
      const acknowledgement: unknown = this.#revoke(conversation);
      if (acknowledgement !== undefined) {
        // A notification is a synchronous fence, never an unobserved async operation.
        if (nodeTypes.isPromise(acknowledgement)) void Promise.prototype.then.call(acknowledgement, undefined, () => {});
        entry.uncertain = true;
      }
    } catch { entry.uncertain = true; }
    if (entry.uncertain) return result.then(() => fail("UNCONFIRMED"), () => fail("UNCONFIRMED"));
    return result;
  }
  /** Only the protected owner may request on. No old grant is restored. */
  on(authority: object, conversation: object): Promise<void> {
    this.#owner(authority);
    const entry = this.#entry(conversation);
    if (entry.uncertain) return Promise.reject(new ReadUsageError("UNCONFIRMED"));
    if (entry.pending >= 8) return Promise.reject(new ReadUsageError("BUSY"));
    const epoch = this.#next();
    entry.epoch = epoch;
    entry.enabled = false;
    const result = this.#enqueue(entry, epoch, true);
    try {
      const acknowledgement: unknown = this.#revoke(conversation);
      if (acknowledgement !== undefined) {
        // A notification is a synchronous fence, never an unobserved async operation.
        if (nodeTypes.isPromise(acknowledgement)) void Promise.prototype.then.call(acknowledgement, undefined, () => {});
        entry.uncertain = true;
      }
    } catch { entry.uncertain = true; }
    if (entry.uncertain) return result.then(() => fail("UNCONFIRMED"), () => fail("UNCONFIRMED"));
    return result;
  }
  #enqueue(entry: Entry, epoch: number, enabled: boolean): Promise<void> {
    if (entry.pending >= 8) {
      // The synchronous fence happened, but no durable off was acknowledged.
      entry.uncertain = true;
      return Promise.reject(new ReadUsageError("UNCONFIRMED"));
    }
    entry.pending++;
    const startedAt = performance.now();
    const expiresAt = startedAt + this.#deadlineMs;
    const expired = () => {
      const now = performance.now();
      return !Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt || now >= expiresAt;
    };
    const record = Object.freeze({ instance: this.#instance, epoch, enabled });
    const run = entry.tail.then(async () => {
      if (expired()) { entry.enabled = false; entry.uncertain = true; }
      if (entry.uncertain) fail("UNCONFIRMED");
      try {
        const pending = this.#store.commit(entry.conversation, record);
        if (!nodeTypes.isPromise(pending)) fail("UNCONFIRMED");
        await pending;
      } catch { entry.enabled = false; entry.uncertain = true; fail("UNCONFIRMED"); }
      // A delayed event loop cannot turn an already expired commit into an acknowledgement.
      if (expired()) { entry.enabled = false; entry.uncertain = true; }
      // Queue overflow or a callback failure can occur while a commit is in flight.
      if (entry.uncertain || this.#exhausted) fail("UNCONFIRMED");
      // A newer off/on can arrive while the store was awaited. Never publish stale on.
      if (enabled) {
        if (entry.epoch !== epoch) fail("STALE");
        entry.enabled = true;
      }
    });
    // Swallow only on the private ordering tail, never on the caller's acknowledgement.
    entry.tail = run.then(() => {}, () => {});
    // The timer limits caller waiting, not the store. Keep the unresolved run as the
    // ordering tail and charged pending work. Late settlement cannot clear uncertainty.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        entry.enabled = false;
        entry.uncertain = true;
        reject(new ReadUsageError("UNCONFIRMED"));
      }, this.#deadlineMs);
    });
    const charged = run.finally(() => { entry.pending--; });
    return Promise.race([charged, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }
}
