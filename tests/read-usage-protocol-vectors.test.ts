import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { types as nodeTypes } from "node:util";
import { createReadUsageStoreTransport, type ReadUsageByteChannel } from "../src/read-usage-store-transport";
import { ReadUsageCoordinator, type ReadUsageRecord } from "../src/read-usage-coordinator";

type Valid = { name: string; id: number; slot: number; instance: string; epoch: number; enabled: boolean; payload: string; payloadHex: string; requestFrameHex: string; ack: string; ackFrameHex: string };
type Vectors = { version: number; scope: string; valid: Valid[]; invalidRequests: { name: string; payloadHex: string; expectedId: number; slots: number }[];
  invalidAcks: { name: string; frameHex: string; needsEof: boolean }[] };
const vectors = JSON.parse(readFileSync(new URL("./fixtures/read-usage-wire-vectors.json", import.meta.url), "utf8")) as Vectors;
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const result = (promise: Promise<void>) => promise.then(() => "ok", (error: unknown) =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unexpected");
const record = (item: Valid): ReadUsageRecord => ({ instance: item.instance, epoch: item.epoch, enabled: item.enabled });

// Shared literal compatibility only. No process, storage, FD or production acceptance is implied.
test("known literal byte anchors and vector cardinalities remain independently fixed", () => {
  expect(vectors.version).toBe(1); expect(vectors.valid).toHaveLength(5);
  expect(vectors.invalidRequests).toHaveLength(32); expect(vectors.invalidAcks).toHaveLength(18);
  expect(vectors.valid[0]!.requestFrameHex.slice(0, 8)).toBe("00000083");
  expect(vectors.valid[0]!.ackFrameHex).toBe("000000127b226964223a312c226f6b223a747275657d");
  for (const item of vectors.valid) {
    expect(Buffer.from(item.payload, "ascii").toString("hex")).toBe(item.payloadHex);
    const wire = bytes(item.requestFrameHex);
    expect(new DataView(wire.buffer).getUint32(0)).toBe(wire.byteLength - 4);
  }
});

test("real TypeScript transport emits literal Python-compatible request frames and consumes literal ACKs", async () => {
  const authority = {}, conversations = [{}, {}, {}, {}], written: string[] = [];
  let events!: Parameters<ReadUsageByteChannel["subscribe"]>[0];
  const transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: conversations.map((conversation, slot) => ({ conversation, slot })),
    channel: { subscribe(value) { events = value; }, write(frame) {
      written.push(Buffer.from(frame).toString("hex")); events.data(bytes(vectors.valid[written.length - 1]!.ackFrameHex)); return Promise.resolve();
    } }, onFailure() { throw new Error("Valid literal unexpectedly refused"); }, now: () => 0, arm: () => () => {} });
  for (const item of vectors.valid.slice(0, 4)) {
    expect(await result(transport.store.commit(conversations[item.slot]!, record(item)))).toBe("ok");
    expect(written.at(-1)).toBe(item.requestFrameHex);
  }
  expect(transport.status(authority)).toEqual({ failed: false, queued: 0, inFlight: false, uncertain: false });
});

test("maximum safe request id and epoch use exact same literal bytes without counter wrap", async () => {
  // Seed only the private counter in an isolated compiled test copy; encoder/parser code is unchanged.
  const raw = readFileSync(new URL("../src/read-usage-store-transport.ts", import.meta.url), "utf8");
  expect(raw.split("counter = 0")).toHaveLength(2);
  const seeded = raw.split("\n").filter(line => !line.startsWith("import ")).join("\n").replaceAll("export ", "")
    .replace("counter = 0", "counter = Number.MAX_SAFE_INTEGER - 1");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(seeded + "\nglobalThis.__VectorFactory = createReadUsageStoreTransport;");
  const context: Record<string, unknown> = { nodeTypes, Object, Array, Reflect, JSON, Map, Set, Number, Uint8Array, ArrayBuffer, DataView, Promise, performance, setTimeout, clearTimeout };
  runInNewContext(compiled, context);
  const factory = context.__VectorFactory as typeof createReadUsageStoreTransport;
  expect(typeof factory).toBe("function");
  const item = vectors.valid[4]!, authority = {}, conversation = {}; let frameHex = "", failures = 0;
  let events!: Parameters<ReadUsageByteChannel["subscribe"]>[0];
  const transport = factory({ ownerAuthority: authority, mappings: [{ conversation, slot: 0 }], onFailure() { failures++; }, now: () => 0, arm: () => () => {},
    channel: { subscribe(value) { events = value; }, write(frame) { frameHex = Buffer.from(frame).toString("hex"); events.data(bytes(item.ackFrameHex)); return Promise.resolve(); } } });
  expect(await result(transport.store.commit(conversation, record(item)))).toBe("ok"); expect(frameHex).toBe(item.requestFrameHex);
  expect(await result(transport.store.commit(conversation, record(item)))).toBe("UNCONFIRMED"); expect(failures).toBe(1);
});

test("real TypeScript record admission rejects the same invalid schema subset before any write", async () => {
  const authority = {}, conversation = {}; let writes = 0, failures = 0;
  const transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: [{ conversation, slot: 0 }],
    channel: { subscribe() {}, write() { writes++; return Promise.resolve(); } }, onFailure() { failures++; }, now: () => 0, arm: () => () => {} });
  for (const name of ["epoch-negative", "epoch-bool", "epoch-too-large", "enabled-number", "enabled-string", "short-instance", "uppercase-instance", "record-extra", "missing-enabled"]) {
    const item = vectors.invalidRequests.find(item => item.name === name)!;
    expect(item).toBeDefined();
    const parsed = JSON.parse(Buffer.from(item.payloadHex, "hex").toString("utf8")) as { record: ReadUsageRecord };
    expect(await result(transport.store.commit(conversation, parsed.record))).toBe("INVALID");
  }
  expect(writes).toBe(0); expect(failures).toBe(0);
});

for (const vector of vectors.invalidAcks) test("literal malformed ACK poisons the actual coordinator: " + vector.name, async () => {
  let signalSent!: () => void;
  const authority = {}, a = {}, b = {}, sent = new Promise<void>(resolve => { signalSent = () => resolve(); });
  let transport!: ReturnType<typeof createReadUsageStoreTransport>, events!: Parameters<ReadUsageByteChannel["subscribe"]>[0];
  let failures = 0, writes = 0;
  const coordinator = new ReadUsageCoordinator({ ownerAuthority: authority, onRevoke() {}, store: { commit: (conversation, value) => transport.store.commit(conversation, value) } });
  coordinator.register(authority, a); coordinator.register(authority, b);
  transport = createReadUsageStoreTransport({ ownerAuthority: authority, mappings: [{ conversation: a, slot: 0 }, { conversation: b, slot: 1 }],
    channel: { subscribe(value) { events = value; }, write() { writes++; signalSent(); return Promise.resolve(); } },
    onFailure() { failures++; coordinator.poisonAll(authority); }, now: () => 0, arm: () => () => {} });
  const first = result(coordinator.on(authority, a)), second = result(coordinator.on(authority, b));
  await sent;
  events.data(bytes(vector.frameHex));
  if (vector.needsEof) { expect(failures).toBe(0); events.eof(); }
  expect(failures).toBe(1); expect((await coordinator.usageVersion(a)).enabled).toBe(false); expect((await coordinator.usageVersion(b)).enabled).toBe(false);
  expect(await Promise.all([first, second])).toEqual(["UNCONFIRMED", "UNCONFIRMED"]);
  events.data(bytes(vectors.valid[0]!.ackFrameHex));
  expect(await result(coordinator.on(authority, b))).toBe("UNCONFIRMED"); expect(writes).toBe(1);
  expect(transport.status(authority)).toMatchObject({ failed: true, inFlight: true, uncertain: true });
});
