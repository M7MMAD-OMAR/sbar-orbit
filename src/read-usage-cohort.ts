import type { Socket } from "node:net";
import { types } from "node:util";
import { ReadUsageCoordinator, ReadUsageError, type ReadUsageStore, type ReadUsageRecord } from "./read-usage-coordinator";
import { createReadUsageStoreTransport, type ReadUsageTransport } from "./read-usage-store-transport";
import { createReadUsageUnixChannel } from "./read-usage-unix-channel";

/** Internal composition over an ALREADY owner-adopted, exclusive socket.
 * No connect, fd adoption, worker startup, peer authentication, durable-root
 * qualification or production wiring. Failed/partial socket setup remains the
 * owner's unknown resource: this factory never closes or releases that socket.
 * Revocation callbacks are trusted synchronous functions returning undefined.
 * Ordinary returned Promises are observed best effort, not hostile-species proof.
 * A coordinator-local deadline is not automatically shared-channel failure.
 */
export interface ReadUsageCohortOptions {
  ownerAuthority: object;
  socket: Socket;
  mappings: readonly { conversation: object; slot: number }[];
  onRevoke(conversation: object): void;
  deadlineMs?: number;
}
export interface ReadUsageCohort {
  on(authority: object, conversation: object): Promise<void>;
  off(authority: object, conversation: object): Promise<void>;
  fail(authority: object): void;
  /** Trusted broker/Sessions callbacks, not request-controlled labels. */
  usageCurrent(conversation: object, epoch: number): boolean;
  usageVersion(conversation: object): Promise<Readonly<{ conversation: object; epoch: number; enabled: boolean }>>;
}
function refused(code: "INVALID" | "DENIED" | "UNCONFIRMED"): never { throw new ReadUsageError(code); }
const opaque = (value: unknown): value is object => value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value);
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!opaque(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refused("INVALID");
  const keys = Reflect.ownKeys(value), result: Record<string, unknown> = Object.create(null);
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) refused("INVALID");
  for (const key of required) if (!Object.hasOwn(value, key)) refused("INVALID");
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) refused("INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function mappings(value: unknown): Readonly<{ conversation: object; slot: number }>[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) refused("INVALID");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 4 || Reflect.ownKeys(value).length !== length + 1) refused("INVALID");
  const conversations = new Set<object>(), slots = new Set<number>(), result: { conversation: object; slot: number }[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) refused("INVALID");
    const entry = fields(descriptor.value, ["conversation", "slot"]);
    if (!opaque(entry.conversation) || typeof entry.slot !== "number" || !Number.isInteger(entry.slot)
        || entry.slot < 0 || entry.slot >= length || conversations.has(entry.conversation) || slots.has(entry.slot)) refused("INVALID");
    conversations.add(entry.conversation); slots.add(entry.slot);
    result.push(Object.freeze({ conversation: entry.conversation, slot: entry.slot }));
  }
  return result;
}
function rejected(): Promise<void> {
  const result = Promise.reject<void>(new ReadUsageError("UNCONFIRMED"));
  void result.catch(() => {}); return result;
}
function observe(value: unknown): void {
  if (types.isPromise(value)) { try { void Promise.prototype.then.call(value, undefined, () => {}); } catch { /* Trusted ordinary promises only. */ } }
}

export function createReadUsageCohort(input: ReadUsageCohortOptions): Readonly<ReadUsageCohort> {
  // Complete the immutable mapping snapshot before touching any socket member.
  const options = fields(input, ["ownerAuthority", "socket", "mappings", "onRevoke"], ["deadlineMs"]);
  const snapshot = Object.freeze(mappings(options.mappings));
  if (!opaque(options.ownerAuthority) || typeof options.onRevoke !== "function" || types.isProxy(options.onRevoke)
      || options.deadlineMs !== undefined && (typeof options.deadlineMs !== "number" || !Number.isSafeInteger(options.deadlineMs)
        || options.deadlineMs < 1 || options.deadlineMs > 3000)) refused("INVALID");
  const authority = options.ownerAuthority, callback = options.onRevoke as (conversation: object) => unknown;
  const deadlineMs = options.deadlineMs as number | undefined;
  let coordinator: ReadUsageCoordinator | undefined, transport: Readonly<ReadUsageTransport> | undefined;
  let failed = false, ready = false;
  const onPoisonFenced = (): void => {
    failed = true; ready = false; // Coordinator has already fenced ALL entries.
    // Gate ACK/pump before any user revocation callback can synchronously emit.
    // During subscribe failure this is unassigned, but that transport is already
    // latched failed internally. No socket/alias disposal is implied here.
    transport?.fail(authority);
  };
  const poison = (): void => {
    if (failed) return;
    if (coordinator) coordinator.poisonAll(authority);
    else { failed = true; ready = false; } // No coordinator escaped construction.
  };
  const notify = (conversation: object): void => {
    let result: unknown;
    try { result = callback(conversation); }
    catch { poison(); refused("UNCONFIRMED"); }
    if (result !== undefined) {
      poison(); observe(result); refused("UNCONFIRMED");
    }
  };
  const deferred: ReadUsageStore = Object.freeze({ commit(conversation: object, record: ReadUsageRecord) {
    if (!ready || failed || !transport) return rejected();
    return transport.store.commit(conversation, record);
  } });
  try {
    coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, store: deferred, onRevoke: notify, onPoisonFenced,
      ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    for (const entry of snapshot) coordinator.register(authority, entry.conversation);
    if (failed) { coordinator.poisonAll(authority); refused("UNCONFIRMED"); }
    const channel = createReadUsageUnixChannel(options.socket as Socket);
    transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: snapshot, channel, onFailure: poison,
      ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    // subscribe may fail synchronously WITHOUT throwing. Nothing may be published
    // until its failure latch is checked against the already bound coordinator.
    if (failed || transport.status(authority).failed) { poison(); refused("UNCONFIRMED"); }
    ready = true;
  } catch {
    poison(); refused("UNCONFIRMED");
  }
  const bound = coordinator!;
  const owner = (claim: object): void => { if (claim !== authority) refused("DENIED"); };
  return Object.freeze({
    on(claim: object, conversation: object) { owner(claim); const result = bound.on(authority, conversation); observe(result); return result; },
    off(claim: object, conversation: object) { owner(claim); const result = bound.off(authority, conversation); observe(result); return result; },
    fail(claim: object) { owner(claim); poison(); },
    usageCurrent: bound.usageCurrent,
    usageVersion: bound.usageVersion,
  });
}
