/** Accounted COPY delivery, for trusted in-process sinks only. No production IPC.
 * Each sink loan has its own <=64KiB backing buffer, reserved before allocation.
 * The original lease remains held through every outstanding loan/stop operation.
 * Terminal receipts prove ALL sink aliases, queued uses and asynchronous stop-owned
 * references are irreversibly gone. Promise success, timeout and abort do not prove it.
 * The combined canDispatch boundary is trusted synchronous non-reentrant runtime code:
 * it checks monotonic deadline, authoritative permission and native abort atomically.
 * It must not run arbitrary callbacks after its final state check. Nothing callback-
 * controlled runs between its return and the captured sink.write invocation.
 * The owner must transfer this lease exclusively and retain NO raw bytes aliases.
 * Previously obtained aliases cannot be retracted or detected by this controller.
 * A future public transport must hide/move raw lease access, not rely on this contract.
 * This is cooperative accounting, not protection against a malicious same-UID sink.
 */
import { types as utilTypes } from "node:util";
import type { ReadObservationLease } from "./multi-view-views";

export interface DeliveryCredit { release(): boolean }
export interface AccountedReadObservationLease extends ReadObservationLease { reserveDelivery(bytes: number): Readonly<DeliveryCredit> }
export interface DeliveryWriteReceipt {
  /** Exact accepted byte count and terminal proof that ALL references to this copy are gone. */
  complete(acceptedBytes: number): boolean;
  unknown(): boolean;
}
export interface DeliveryStopReceipt {
  /** No future writes, callbacks using bytes, queued uses or stop-owned aliases remain. */
  stopped(): boolean;
  unknown(): boolean;
}
export interface ReadDeliverySink {
  write(copy: Uint8Array, receipt: Readonly<DeliveryWriteReceipt>): void;
  stop(receipt: Readonly<DeliveryStopReceipt>): void;
}
export type DeliveryCode = "DELIVERED" | "CANCELLED" | "DENIED" | "DEADLINE" | "INVALID" | "SINK" | "UNCONFIRMED" | "CLEANUP";
export interface DeliveryStatus {
  readonly phase: "idle" | "running" | "released" | "quarantined";
  readonly code: DeliveryCode | null; readonly acceptedBytes: number; readonly scratchHeld: boolean;
}
export interface ReadViewDelivery {
  /** Frozen settlement snapshot; status() reports any later trusted cleanup settlement. */
  run(): Promise<Readonly<DeliveryStatus>>;
  close(): Promise<Readonly<DeliveryStatus>>;
  status(): Readonly<DeliveryStatus>;
}
export interface ReadDeliveryOptions {
  lease: AccountedReadObservationLease;
  canDispatch(deadline: number, signal: AbortSignal): boolean;
  deadline: number; signal: AbortSignal; sink: ReadDeliverySink;
  /** Trusted scheduling only. now/arm must run and arm must fire for liveness.
   * No hard 3-second preemption: a stalled scheduler/sink can retain debt indefinitely.
   * Authorization/time at dispatch belong to canDispatch, not this callback. */
  now?: () => number;
  arm?: (milliseconds: number, expire: () => void) => () => void;
}
export class ReadDeliveryError extends Error {
  constructor() { super("Invalid accounted read delivery"); this.name = "ReadDeliveryError"; }
}
const claimed = new WeakSet<object>();
function plain(value: unknown): value is object {
  return value !== null && typeof value === "object" && !utilTypes.isProxy(value)
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function callable(value: unknown): value is (...args: never[]) => unknown { return typeof value === "function" && !utilTypes.isProxy(value); }
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plain(value)) throw new ReadDeliveryError();
  const keys = Reflect.ownKeys(value), result = Object.create(null) as Record<string, unknown>;
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) throw new ReadDeliveryError();
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ReadDeliveryError();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new ReadDeliveryError();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
const ByteArray = Uint8Array;
const copyBytes = Uint8Array.prototype.set;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const nativeAbort = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const defaultArm = (milliseconds: number, expire: () => void) => { const timer = setTimeout(expire, milliseconds); return () => clearTimeout(timer); };
interface Loan {
  expected: number; sent: boolean; done: boolean; unknown: boolean; accepted: number;
  copy?: Uint8Array; releaseCredit?: () => unknown; creditUnknown: boolean;
  releaseAttempted: boolean; wake(): void; wait: Promise<void>;
}

export function createReadViewDelivery(input: ReadDeliveryOptions): Readonly<ReadViewDelivery> {
  // These descriptor snapshots execute no getters or Proxy traps. Claim BEFORE any callback.
  const options = data(input, ["lease", "canDispatch", "deadline", "signal", "sink"], ["now", "arm"]);
  const lease = options.lease;
  if (!plain(lease) || claimed.has(lease)) throw new ReadDeliveryError();
  const keys = Reflect.ownKeys(lease);
  if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["bytes", "release", "reserveDelivery"].includes(key))) throw new ReadDeliveryError();
  const bytesDescriptor = Object.getOwnPropertyDescriptor(lease, "bytes");
  const releaseDescriptor = Object.getOwnPropertyDescriptor(lease, "release");
  const reserveDescriptor = Object.getOwnPropertyDescriptor(lease, "reserveDelivery");
  if (!bytesDescriptor || !Object.hasOwn(bytesDescriptor, "get") || !callable(bytesDescriptor.get)
      || !Object.hasOwn(bytesDescriptor, "set") || bytesDescriptor.set !== undefined
      || !releaseDescriptor || !Object.hasOwn(releaseDescriptor, "value") || !callable(releaseDescriptor.value)
      || !reserveDescriptor || !Object.hasOwn(reserveDescriptor, "value") || !callable(reserveDescriptor.value)) throw new ReadDeliveryError();
  const sink = data(options.sink, ["write", "stop"]);
  if (!callable(sink.write) || !callable(sink.stop) || !callable(options.canDispatch)
      || utilTypes.isProxy(options.signal) || !(options.signal instanceof AbortSignal)
      || typeof options.deadline !== "number" || !Number.isFinite(options.deadline)
      || options.now !== undefined && !callable(options.now) || options.arm !== undefined && !callable(options.arm)) throw new ReadDeliveryError();
  // instanceof admits forged prototype-only objects. Validate the captured native
  // internal-slot getter before claiming the lease or invoking any owner callback.
  try { if (typeof nativeAbort.call(options.signal) !== "boolean") throw new ReadDeliveryError(); }
  catch { throw new ReadDeliveryError(); }
  const now = (options.now ?? (() => performance.now())) as () => number;
  const arm = (options.arm ?? defaultArm) as (ms: number, expire: () => void) => () => void;
  const canDispatch = options.canDispatch as ReadDeliveryOptions["canDispatch"];
  const signal = options.signal, deadline = options.deadline;
  const getBytes = bytesDescriptor.get!, releaseLease = releaseDescriptor.value as () => void;
  const reserve = reserveDescriptor.value as (bytes: number) => Readonly<DeliveryCredit>;
  const write = sink.write as ReadDeliverySink["write"], stop = sink.stop as ReadDeliverySink["stop"];
  claimed.add(lease);
  let initial: number;
  try {
    initial = now();
    if (typeof initial !== "number" || !Number.isFinite(initial) || deadline - initial > 3000) throw new ReadDeliveryError();
  } catch { claimed.delete(lease); throw new ReadDeliveryError(); }
  let phase: DeliveryStatus["phase"] = "idle", code: DeliveryCode | null = null, acceptedBytes = 0;
  let payload: Uint8Array | undefined, loan: Loan | undefined, promise: Promise<Readonly<DeliveryStatus>> | undefined;
  let busy = false, sinkBusy = false, stopped = false, stopAsked = false, releaseTried = false;
  let lastTime = initial, disarm: (() => void) | undefined, listening = false, finishing = false;
  let interrupt!: () => void;
  const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
  const status = (): Readonly<DeliveryStatus> => Object.freeze({ phase, code, acceptedBytes,
    scratchHeld: loan !== undefined && (loan.creditUnknown || !loan.releaseAttempted) });
  function cancel(reason: DeliveryCode): void { if (!code) code = reason; interrupt(); }
  function boundary(): void {
    // No caller-controlled callback follows this combined authorization boundary before write.
    if (code || nativeAbort.call(signal)) { cancel("CANCELLED"); throw new Error(); }
    const sampled = now();
    if (typeof sampled !== "number" || !Number.isFinite(sampled) || sampled < lastTime || sampled >= deadline) {
      cancel("DEADLINE"); throw new Error();
    }
    lastTime = sampled;
    if (code) throw new Error();
    let current = false;
    try { current = canDispatch(deadline, signal) === true; } catch { current = false; }
    if (!current) cancel("DENIED");
    if (nativeAbort.call(signal)) cancel("CANCELLED");
    if (code) throw new Error();
  }
  function clearCredit(): void {
    if (!loan || loan.releaseAttempted || loan.creditUnknown || stopAsked && !stopped
        || loan.sent && !loan.done && !stopped) return;
    loan.copy = undefined;
    loan.releaseAttempted = true;
    try {
      if (!loan.releaseCredit || loan.releaseCredit() !== true) { loan.creditUnknown = true; code = "CLEANUP"; interrupt(); }
    } catch { loan.creditUnknown = true; code = "CLEANUP"; interrupt(); }
    if (!loan.creditUnknown) loan = undefined;
  }
  function finalize(): void {
    if (busy || sinkBusy) return;
    clearCredit();
    if (loan) { phase = "quarantined"; return; }
    if (releaseTried) return;
    payload = undefined; releaseTried = true;
    try { Reflect.apply(releaseLease, lease, []); phase = "released"; }
    catch { code = "CLEANUP"; phase = "quarantined"; }
    if (nativeAbort.call(signal) && !code) code = "CANCELLED";
    if (!code) code = "DELIVERED";
  }
  function laterFinalize(): void {
    if (finishing || busy || sinkBusy) return;
    finishing = true;
    queueMicrotask(() => { finishing = false; finalize(); });
  }
  function requestStop(): void {
    if (stopAsked || !loan || !loan.sent || loan.done || stopped) return;
    stopAsked = true;
    const receipt = Object.freeze({
      stopped: () => {
        if (stopped || phase === "released") return false;
        stopped = true; if (loan) { loan.done = true; loan.wake(); }
        laterFinalize(); return true;
      },
      unknown: () => { if (stopped || phase === "released") return false; cancel("UNCONFIRMED"); return true; },
    });
    sinkBusy = true;
    try { const returned: unknown = Reflect.apply(stop, options.sink, [receipt]); if (returned instanceof Promise) void returned.catch(() => {}); }
    catch { /* Not a receipt. Keep both original and copy credit occupied. */ }
    finally { sinkBusy = false; }
  }
  const onAbort = () => cancel("CANCELLED");
  async function execute(): Promise<void> {
    busy = true; phase = "running";
    try {
      boundary();
      payload = Reflect.apply(getBytes, lease, []);
      if (!ArrayBuffer.isView(payload) || Object.getPrototypeOf(payload) !== Uint8Array.prototype) { cancel("INVALID"); throw new Error(); }
      const buffer = getBuffer.call(payload) as ArrayBuffer, length = getLength.call(payload) as number;
      if (!(buffer instanceof ArrayBuffer) || getOffset.call(payload) !== 0 || getBufferLength.call(buffer) !== length
          || getResizable?.call(buffer) === true || length < 1 || length > 1048576) { cancel("INVALID"); throw new Error(); }
      addEvent.call(signal, "abort", onAbort, { once: true }); listening = true;
      const sampled = now();
      if (typeof sampled !== "number" || !Number.isFinite(sampled) || sampled < lastTime || sampled >= deadline) { cancel("DEADLINE"); throw new Error(); }
      lastTime = sampled;
      disarm = arm(deadline - sampled, () => cancel("DEADLINE"));
      if (!callable(disarm)) { cancel("INVALID"); throw new Error(); }
      let offset = 0;
      while (offset < length) {
        boundary();
        if (Reflect.apply(getBytes, lease, []) !== payload || getLength.call(payload) !== length) { cancel("INVALID"); throw new Error(); }
        const expected = Math.min(65536, length - offset);
        let wake!: () => void;
        const wait = new Promise<void>(resolve => { wake = resolve; });
        const current: Loan = { expected, sent: false, done: false, unknown: false, accepted: 0,
          creditUnknown: false, releaseAttempted: false, wake, wait };
        // Atomic trusted reservation: throws without charging, or returns one charged ticket.
        const ticket: unknown = Reflect.apply(reserve, lease, [expected]);
        loan = current;
        try {
          const credit = data(ticket, ["release"]);
          if (!callable(credit.release)) throw new ReadDeliveryError();
          current.releaseCredit = () => Reflect.apply(credit.release as () => boolean, ticket, []);
        } catch { current.creditUnknown = true; cancel("CLEANUP"); throw new Error(); }
        // Only this separate backing store reaches the sink. Credit already covers it.
        current.copy = new ByteArray(expected);
        copyBytes.call(current.copy, new ByteArray(buffer, offset, expected));
        const receipt: Readonly<DeliveryWriteReceipt> = Object.freeze({
          complete: (count: number) => {
            if (current.done || stopped || phase === "released") return false;
            if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > expected) {
              cancel("SINK"); current.wake(); return false;
            }
            current.accepted = count; current.done = true; acceptedBytes += count; current.wake(); laterFinalize(); return true;
          },
          unknown: () => { if (current.done || current.unknown || stopped || phase === "released") return false;
            current.unknown = true; cancel("UNCONFIRMED"); current.wake(); return true; },
        });
        boundary();
        current.sent = true; sinkBusy = true;
        try {
          const returned: unknown = Reflect.apply(write, options.sink, [current.copy, receipt]);
          if (returned !== undefined) { if (returned instanceof Promise) void returned.catch(() => {}); cancel("SINK"); throw new Error(); }
        } finally { sinkBusy = false; }
        await Promise.race([wait, interrupted]);
        boundary();
        if (!current.done || current.unknown) { cancel("UNCONFIRMED"); throw new Error(); }
        if (current.accepted !== expected) { cancel("SINK"); throw new Error(); }
        clearCredit(); if (loan) throw new Error();
        offset += expected;
      }
      boundary();
    } catch { if (!code) cancel("SINK"); }
    finally {
      payload = undefined;
      if (code) requestStop();
      if (listening) { try { removeEvent.call(signal, "abort", onAbort); } catch { cancel("CLEANUP"); } listening = false; }
      if (disarm) { try { disarm(); } catch { cancel("CLEANUP"); } disarm = undefined; }
      if (nativeAbort.call(signal) && !code) cancel("CANCELLED");
      phase = "quarantined";
    }
  }
  function run(): Promise<Readonly<DeliveryStatus>> {
    if (!promise) {
      let settle!: (value: Readonly<DeliveryStatus>) => void;
      promise = new Promise(resolve => { settle = resolve; });
      void execute().then(() => { busy = false; finalize(); settle(status()); }, () => { busy = false; cancel("CLEANUP"); phase = "quarantined"; settle(status()); });
    }
    return promise;
  }
  return Object.freeze({ run, close: () => { if (phase !== "released") cancel("CANCELLED"); return run(); }, status });
}
