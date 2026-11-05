import { types as nodeTypes } from "node:util";
import type { ReadUsageRecord, ReadUsageStore } from "./read-usage-coordinator";

/** Already-established, owner-held byte channel only. No connect, spawn, close or writer-stop proof.
 * subscribe and failure notification are trusted synchronous callbacks returning undefined.
 * write must faithfully send the immutable-by-contract frame and return an ordinary Promise.
 * Promise completion is local send completion, not writer/alias drain. Failed in-flight frames
 * and their ordering identity stay retained. Custom Promise constructor/species is out of contract.
 * No production route, helper provenance, peer authentication or cross-language qualification here. */
export interface ReadUsageByteChannel {
  subscribe(events: Readonly<{ data(bytes: Uint8Array): void; eof(): void; error(): void }>): void;
  write(frame: Uint8Array): Promise<void>;
}
export type ReadUsageTransportCode = "INVALID" | "DENIED" | "BUSY" | "UNCONFIRMED";
export class ReadUsageTransportError extends Error {
  constructor(readonly code: ReadUsageTransportCode) { super("Private usage channel refused"); this.name = "ReadUsageTransportError"; }
}
export interface ReadUsageTransport {
  readonly store: ReadUsageStore;
  fail(authority: object): void;
  status(authority: object): Readonly<{ failed: boolean; queued: number; inFlight: boolean; uncertain: boolean }>;
}
export interface ReadUsageTransportOptions {
  ownerAuthority: object;
  mappings: readonly { conversation: object; slot: number }[];
  channel: ReadUsageByteChannel;
  /** Must synchronously call the bound coordinator.poisonAll(ownerAuthority). No async ACK. */
  onFailure(): void;
  deadlineMs?: number;
  /** Trusted fixture seams only, never request data. */
  now?: () => number;
  arm?: (milliseconds: number, expire: () => void) => () => void;
}
const MAX = 1024, CAPACITY = 4;
function fail(code: ReadUsageTransportCode): never { throw new ReadUsageTransportError(code); }
function callable(value: unknown): value is (...args: never[]) => unknown { return typeof value === "function" && !nodeTypes.isProxy(value); }
function opaque(value: unknown): value is object { return value !== null && typeof value === "object" && !nodeTypes.isProxy(value) && !Array.isArray(value); }
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!opaque(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID");
  const keys = Reflect.ownKeys(value), result = Object.create(null) as Record<string, unknown>;
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) fail("INVALID");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("INVALID");
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function array(value: unknown): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("INVALID");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > CAPACITY || Reflect.ownKeys(value).length !== length + 1) fail("INVALID");
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID");
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}
function rejected(code: ReadUsageTransportCode): Promise<void> {
  const promise = Promise.reject<void>(new ReadUsageTransportError(code));
  void promise.catch(() => {});
  return promise;
}
function observe(value: unknown): void {
  // Best effort for ordinary promises only; trusted callbacks must return undefined.
  if (nodeTypes.isPromise(value)) { try { void Promise.prototype.then.call(value, undefined, () => {}); } catch { /* Out-of-contract species. */ } }
}
interface Pending {
  id: number; frame: Uint8Array; expires: number; ready: boolean; sent: boolean; writing: boolean; written: boolean; acked: boolean;
  resolve(): void; reject(error: ReadUsageTransportError): void; disarm?: () => void;
}

export function createReadUsageStoreTransport(input: ReadUsageTransportOptions): Readonly<ReadUsageTransport> {
  const options = fields(input, ["ownerAuthority", "mappings", "channel", "onFailure"], ["deadlineMs", "now", "arm"]);
  const channel = fields(options.channel, ["subscribe", "write"]);
  const milliseconds = options.deadlineMs ?? 3000;
  if (!opaque(options.ownerAuthority) || !callable(options.onFailure) || !callable(channel.subscribe) || !callable(channel.write)
      || typeof milliseconds !== "number" || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3000
      || options.now !== undefined && !callable(options.now) || options.arm !== undefined && !callable(options.arm)) fail("INVALID");
  const slots = new Map<object, number>(), seen = new Set<number>();
  for (const raw of array(options.mappings)) {
    const mapping = fields(raw, ["conversation", "slot"]);
    if (!opaque(mapping.conversation) || typeof mapping.slot !== "number" || !Number.isInteger(mapping.slot) || mapping.slot < 0
        || mapping.slot >= CAPACITY || slots.has(mapping.conversation) || seen.has(mapping.slot)) fail("INVALID");
    slots.set(mapping.conversation, mapping.slot); seen.add(mapping.slot);
  }
  // The service receives the same trusted dense table: every index 0..N-1 exists.
  for (let slot = 0; slot < slots.size; slot++) if (!seen.has(slot)) fail("INVALID");
  const authority = options.ownerAuthority;
  const onFailure = options.onFailure as () => void, subscribe = channel.subscribe as ReadUsageByteChannel["subscribe"], write = channel.write as ReadUsageByteChannel["write"];
  const now = options.now as (() => number) | undefined ?? (() => performance.now());
  const arm: NonNullable<ReadUsageTransportOptions["arm"]> = (options.arm as ReadUsageTransportOptions["arm"])
    ?? ((ms, expire) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); });
  let failed = false, counter = 0, lastTime = -Infinity, pumping = false, receiving = false, finishing = false;
  let current: Pending | undefined;
  const queue: Pending[] = [], incoming = new Uint8Array(MAX + 4);
  let buffered = 0, length: number | undefined;
  function failure(): void {
    if (failed) return;
    failed = true; // Sticky BEFORE cleanup callbacks, revocation callbacks or rejection.
    const pending = current ? [current, ...queue] : [...queue];
    queue.length = 0;
    // Cohort revocation is the FIRST external callback, before timer cleanup can reenter.
    try { observe(onFailure()); } catch { /* The trusted owner must already have fenced its cohort. */ }
    for (const entry of pending) {
      const disarm = entry.disarm; entry.disarm = undefined;
      if (disarm) { try { observe(disarm()); } catch { /* No cleanup or writer-stop claim. */ } }
    }
    for (const entry of pending) entry.reject(new ReadUsageTransportError("UNCONFIRMED"));
    // Do not clear current, frame or writer identity. Late ACK/write settlement cannot release it.
  }
  function time(entry?: Pending): boolean {
    if (failed) return false;
    try {
      const sampled = now();
      if (typeof sampled !== "number" || !Number.isFinite(sampled) || sampled < lastTime) { failure(); return false; }
      lastTime = sampled;
      if (failed || entry && sampled >= entry.expires) { failure(); return false; }
      return true;
    } catch { failure(); return false; }
  }
  function finish(): void {
    if (failed || receiving || pumping || finishing || !current || !current.acked || !current.written || current.writing) return;
    finishing = true;
    const entry = current;
    try {
      if (!time(entry)) return;
      const disarm = entry.disarm; entry.disarm = undefined;
      if (disarm) {
        const result: unknown = disarm();
        if (result !== undefined) { observe(result); failure(); return; }
      }
      if (!time(entry) || failed || current !== entry) return;
      current = undefined;
      entry.resolve();
    } catch { failure(); }
    finally { finishing = false; }
    pump();
  }
  function pump(): void {
    if (failed || pumping || receiving || finishing || current || !queue[0]?.ready) return;
    pumping = true;
    const entry = queue.shift()!; current = entry;
    try {
      if (!time(entry)) return;
      entry.sent = true; entry.writing = true;
      const result = Reflect.apply(write, options.channel, [entry.frame]);
      entry.writing = false;
      if (failed) { observe(result); return; }
      if (!nodeTypes.isPromise(result)) { failure(); return; }
      // A synchronous data callback may already have staged an ACK. Never settle it
      // until this write returned successfully and its ordinary Promise completed.
      try {
        void Promise.prototype.then.call(result, () => {
          if (failed) return;
          entry.written = true; finish();
        }, () => failure());
      } catch { failure(); }
    } catch { entry.writing = false; failure(); }
    finally { pumping = false; }
    finish();
  }
  function data(chunk: Uint8Array): void {
    if (failed) return;
    if (receiving || !current || !current.sent || current.acked) { failure(); return; }
    receiving = true;
    try {
      if (nodeTypes.isProxy(chunk) || Object.getPrototypeOf(chunk) !== Uint8Array.prototype
          || Object.hasOwn(chunk, "byteLength") || Object.hasOwn(chunk, "buffer") || Object.hasOwn(chunk, "byteOffset")
          || !(chunk.buffer instanceof ArrayBuffer) || chunk.byteLength < 1 || chunk.byteLength > MAX + 4
          || buffered + chunk.byteLength > incoming.byteLength) { failure(); return; }
      incoming.set(chunk, buffered); buffered += chunk.byteLength;
      if (length === undefined && buffered >= 4) {
        length = (incoming[0]! * 16777216 + incoming[1]! * 65536 + incoming[2]! * 256 + incoming[3]!);
        if (length < 1 || length > MAX) { failure(); return; }
      }
      if (length === undefined || buffered < length + 4) return;
      // Stage the WHOLE event before acknowledgement. Extra complete or partial
      // frame bytes in the same event poison before any promise can resolve.
      if (buffered !== length + 4) { failure(); return; }
      const expected = JSON.stringify({ id: current.id, ok: true });
      if (expected.length !== length) { failure(); return; }
      for (let index = 0; index < length; index++) if (incoming[index + 4] !== expected.charCodeAt(index)) { failure(); return; }
      current.acked = true; buffered = 0; length = undefined;
    } catch { failure(); }
    finally { receiving = false; }
    finish();
  }
  const store: ReadUsageStore = Object.freeze({ commit(conversation: object, raw: ReadUsageRecord): Promise<void> {
    if (failed) return rejected("UNCONFIRMED");
    const slot = slots.get(conversation);
    if (slot === undefined) return rejected("DENIED");
    let record: Readonly<ReadUsageRecord>;
    try {
      const value = fields(raw, ["instance", "epoch", "enabled"]);
      if (typeof value.instance !== "string" || !/^[a-f0-9]{64}$/.test(value.instance) || typeof value.epoch !== "number"
          || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || typeof value.enabled !== "boolean") fail("INVALID");
      record = Object.freeze({ instance: value.instance, epoch: value.epoch, enabled: value.enabled });
    } catch { return rejected("INVALID"); }
    if (queue.length + (current ? 1 : 0) >= CAPACITY) return rejected("BUSY");
    if (counter >= Number.MAX_SAFE_INTEGER) { failure(); return rejected("UNCONFIRMED"); }
    const id = ++counter, body = JSON.stringify({ id, slot, record });
    if (body.length > MAX) { failure(); return rejected("UNCONFIRMED"); }
    const frame = new Uint8Array(body.length + 4);
    new DataView(frame.buffer).setUint32(0, body.length);
    for (let index = 0; index < body.length; index++) frame[index + 4] = body.charCodeAt(index);
    let resolve!: () => void, reject!: (error: ReadUsageTransportError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const entry: Pending = { id, frame, expires: Infinity, ready: false, sent: false, writing: false, written: false, acked: false, resolve, reject };
    queue.push(entry); // Claim the bounded slot BEFORE trusted clock/timer callbacks.
    if (!time()) return promise;
    entry.expires = lastTime + (milliseconds as number);
    try {
      const disarm = arm(milliseconds as number, () => {
        if (!failed && (current === entry || queue.includes(entry))) failure();
      });
      if (!callable(disarm)) { observe(disarm); failure(); return promise; }
      if (failed) { try { observe(disarm()); } catch { /* Already uncertain. */ } return promise; }
      entry.disarm = disarm;
      if (!time(entry)) return promise;
      entry.ready = true; pump();
    } catch { failure(); }
    return promise;
  } });
  try {
    const result: unknown = Reflect.apply(subscribe, options.channel, [Object.freeze({ data, eof: failure, error: failure })]);
    if (result !== undefined) { observe(result); failure(); }
  } catch { failure(); }
  return Object.freeze({ store, fail(owner: object) { if (owner !== authority) fail("DENIED"); failure(); },
    status(owner: object) { if (owner !== authority) fail("DENIED"); return Object.freeze({ failed, queued: queue.length, inFlight: !!current, uncertain: failed }); } });
}
