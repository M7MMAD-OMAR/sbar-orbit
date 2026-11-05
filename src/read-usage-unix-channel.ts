import { Socket } from "node:net";
import { types as nodeTypes } from "node:util";
import type { ReadUsageByteChannel } from "./read-usage-store-transport";

/** Owner-supplied ALREADY adopted, exclusive, established Unix Socket only.
 * This module never connects a path, adopts an fd, starts a process or verifies peer/root ownership.
 * In particular Bun 1.3.14 Socket({fd}) constructor validation alone is not adoption.
 * The owner must qualify the socket and retain its lifetime/root quarantine externally.
 * JS copies are bounded here; native socket buffers/all-alias drain are NOT qualified.
 * Write completion means local callback plus backpressure drain, not durable store ACK or writer stop.
 */
export class ReadUsageUnixChannelError extends Error {
  constructor(readonly code: "INVALID" | "UNCONFIRMED") { super("Owned usage socket refused"); this.name = "ReadUsageUnixChannelError"; }
}
const MAX_FRAME = 1028;
type Events = Parameters<ReadUsageByteChannel["subscribe"]>[0];
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
function reject(): Promise<void> {
  const promise = Promise.reject<void>(new ReadUsageUnixChannelError("UNCONFIRMED"));
  void promise.catch(() => {}); return promise;
}
function observe(value: unknown): void {
  // Trusted callbacks return undefined. Ordinary Promise observation is best effort only.
  if (nodeTypes.isPromise(value)) { try { void Promise.prototype.then.call(value, undefined, () => {}); } catch { /* Custom species is outside the owner contract. */ } }
}
function copy(bytes: unknown): Uint8Array {
  if (nodeTypes.isProxy(bytes) || !ArrayBuffer.isView(bytes) || !(bytes instanceof Uint8Array)) throw new ReadUsageUnixChannelError("INVALID");
  const length = Reflect.apply(lengthOf, bytes, []) as number;
  const buffer = Reflect.apply(bufferOf, bytes, []) as ArrayBuffer;
  const offset = Reflect.apply(offsetOf, bytes, []) as number;
  if (!(buffer instanceof ArrayBuffer) || !Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME) throw new ReadUsageUnixChannelError("INVALID");
  const result = new Uint8Array(length); result.set(new Uint8Array(buffer, offset, length)); return result;
}
interface Writing {
  frame: Uint8Array; returned: boolean; callback: boolean; pressure: boolean; drain: number;
  resolve(): void; reject(error: ReadUsageUnixChannelError): void;
}
export function createReadUsageUnixChannel(socket: Socket): Readonly<ReadUsageByteChannel> {
  if (nodeTypes.isProxy(socket) || !(socket instanceof Socket) || Object.getPrototypeOf(socket) !== Socket.prototype
      || socket.readableEncoding !== null || socket.readableFlowing === true
      || socket.listenerCount("data") !== 0 || socket.listenerCount("readable") !== 0)
    throw new ReadUsageUnixChannelError("INVALID");
  let failed: "eof" | "error" | undefined, subscriber: Events | undefined, notified = false;
  let subscribed = false, drain = 0, active: Writing | undefined;
  function notify(): void {
    if (!failed || !subscriber || notified) return;
    notified = true;
    try { observe(failed === "eof" ? subscriber.eof() : subscriber.error()); } catch { /* Owner callback must synchronously poison its cohort. */ }
  }
  function failure(kind: "eof" | "error"): void {
    if (failed) return;
    failed = kind;
    notify(); // FIRST external callback, before pending write rejection or read pause.
    if (active) active.reject(new ReadUsageUnixChannelError("UNCONFIRMED"));
    try { socket.pause(); } catch { /* No close, disposal or writer-stop receipt. */ }
    // Keep active/frame if uncertain; neither close nor a late write callback settles ownership.
  }
  function healthy(): boolean {
    return !socket.destroyed && !socket.connecting && socket.readable && socket.writable && !socket.readableEnded && !socket.writableEnded;
  }
  function finish(entry: Writing): void {
    if (failed || active !== entry || !entry.returned || !entry.callback || entry.pressure && drain <= entry.drain) return;
    if (!healthy()) { failure("error"); return; }
    active = undefined; entry.resolve();
  }
  function data(bytes: Buffer): void {
    if (failed) return;
    if (!subscriber) { failure("error"); return; }
    try {
      const result: unknown = subscriber.data(copy(bytes));
      if (result !== undefined) { observe(result); failure("error"); }
    } catch { failure("error"); }
  }
  // Error observation must exist before any setup action can throw or emit. If
  // installation itself fails, no channel is transferred; the owner retains the socket.
  try { socket.prependListener("error", () => failure("error")); }
  catch { throw new ReadUsageUnixChannelError("INVALID"); }
  // Remaining partial setup failures retain that listener and latch failure.
  try {
    socket.pause();
    socket.prependListener("end", () => failure("eof"));
    socket.prependListener("close", () => failure("error"));
    socket.on("drain", () => {
      if (failed) return;
      if (drain >= Number.MAX_SAFE_INTEGER) { failure("error"); return; }
      drain++; if (active) finish(active);
    });
    socket.on("data", data);
    if (!healthy()) failure("error");
  } catch { failure("error"); }
  return Object.freeze({
    subscribe(events: Events): void {
      const invalid = (): never => { failure("error"); throw new ReadUsageUnixChannelError("INVALID"); };
      if (subscribed) invalid();
      if (nodeTypes.isProxy(events) || !events || typeof events !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(events))) invalid();
      const keys = Reflect.ownKeys(events);
      if (keys.length !== 3 || keys.some(key => key !== "data" && key !== "eof" && key !== "error")) invalid();
      const callbacks: Record<string, (...args: never[]) => unknown> = {};
      for (const key of ["data", "eof", "error"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(events, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value)) return invalid();
        callbacks[key] = descriptor.value;
      }
      subscriber = Object.freeze(callbacks) as unknown as Events; subscribed = true;
      if (failed) { notify(); return; }
      try { if (!healthy()) failure("error"); else socket.resume(); } catch { failure("error"); }
    },
    write(bytes: Uint8Array): Promise<void> {
      if (failed || !subscribed) return reject();
      if (active) { failure("error"); return reject(); }
      let frame: Uint8Array;
      try {
        frame = copy(bytes);
        if (frame.byteLength < 5 || new DataView(frame.buffer).getUint32(0) !== frame.byteLength - 4) throw new Error();
      } catch { failure("error"); return reject(); }
      let resolve!: () => void, rejectWrite!: (error: ReadUsageUnixChannelError) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; rejectWrite = no; });
      void promise.catch(() => {});
      const entry: Writing = { frame, returned: false, callback: false, pressure: false, drain, resolve, reject: rejectWrite };
      active = entry;
      try {
        if (!healthy()) { failure("error"); return promise; }
        const accepted = socket.write(frame, error => {
          if (failed) return;
          if (active !== entry || entry.callback || error !== undefined && error !== null) { failure("error"); return; }
          entry.callback = true; finish(entry);
        });
        if (accepted !== true && accepted !== false) { failure("error"); return promise; }
        entry.pressure = !accepted; entry.returned = true; finish(entry);
      } catch { failure("error"); }
      return promise;
    },
  });
}
