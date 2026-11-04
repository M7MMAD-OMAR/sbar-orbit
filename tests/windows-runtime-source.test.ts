import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import vector from "./fixtures/windows-runtime-source-v2.json";
import { materializeWindowsRuntime, parseRuntimeReceipt, parseRuntimeSource, runtimeDescriptorId, validateRuntimeReceipt, RUNTIME_RECEIPT } from "../src/windows-runtime-source";
// All binary strings/hashes here are synthetic owned fixtures, not official Bun or Windows acceptance.
const roots: string[] = [], sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "orbit-runtime-source-"))); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function crc(bytes: Buffer) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
type ZipEntry = { name: string; bytes?: Buffer; external?: number; method?: number; offset?: number; localExtra?: Buffer };
function zip(entries: ZipEntry[]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = entry.bytes ?? Buffer.from("owned fixture"), method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes, extra = entry.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc(bytes), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc(bytes), 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE((entry.external ?? 0) >>> 0, 38); record.writeUInt32LE(entry.offset ?? offset, 42);
    locals.push(local, name, extra, compressed); central.push(record, name); offset += local.length + name.length + extra.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(entries?: ZipEntry[]) {
  const root = await temporary(), stage = join(root, "stage"), executable = Buffer.from(vector.runtimeBytes); await mkdir(stage);
  const bytes = zip(entries ?? [{ name: "bun-windows-x64/bun.exe", bytes: executable, method: 8 }]);
  const source = parseRuntimeSource({ ...vector.runtimeSource, archiveSha256: sha(bytes), archiveBytes: bytes.length, executableSha256: sha(executable), executableBytes: executable.length });
  const archive = join(root, "synthetic.zip"); await writeFile(archive, bytes);
  const context = { orbitVersion: vector.receipt.orbitVersion, managedRoot: root, downloadAllowed: false, providedArchive: archive, preflight: async () => {} };
  return { root, stage, bytes, source, context, archive };
}
test("native and Bun share thirteen length-prefixed descriptor values", () => {
  const source = parseRuntimeSource(vector.runtimeSource); expect(runtimeDescriptorId(source)).toBe(vector.descriptorId);
  expect(parseRuntimeReceipt(vector.receipt, source, vector.receipt.orbitVersion).descriptorId).toBe(vector.descriptorId);
  expect(vector.orderedValues.map(value => Buffer.byteLength(value) + ":" + value).join("")).toBe(vector.canonical);
});
for (const [label, patch] of [
  ["arbitrary host", { url: "https://evil.invalid/bun.zip" }], ["URL query", { url: vector.runtimeSource.url + "?x=1" }],
  ["credentials", { url: vector.runtimeSource.url.replace("https://", "https://owner@") }], ["traversal", { archiveEntry: "../bun.exe" }],
  ["noncanonical version", { version: "01.4.4" }], ["archive bound", { archiveBytes: 129 * 1024 * 1024 }],
  ["fractional size", { executableBytes: 1.5 }], ["missing size", { archiveBytes: undefined }], ["missing pin", { executableSha256: "pending" }],
  ["extra permission", { downloadAllowed: true }], ["architecture", { arch: "arm64" }],
] as [string, Record<string, unknown>][]) test("descriptor refuses " + label, () => expect(() => parseRuntimeSource({ ...vector.runtimeSource, ...patch })).toThrow());
test("receipt rejects stale version, hashes, authority fields and unknown provenance", () => {
  const source = parseRuntimeSource(vector.runtimeSource);
  for (const patch of [{ schema: 1 }, { orbitVersion: "1.2.3" }, { descriptorId: "0".repeat(64) }, { executableSha256: "a".repeat(64) }, { acquisition: "trusted" }, { cacheOriginVersion: "1.0.0" }, { extra: true }])
    expect(() => parseRuntimeReceipt({ ...vector.receipt, ...patch }, source, vector.receipt.orbitVersion)).toThrow();
});
test("provided official-layout archive completes private runtime and receipt", async () => {
  const f = await fixture(), result = await materializeWindowsRuntime(f.stage, f.source, f.context);
  expect(result.acquisition).toBe("provided-archive"); expect(await readFile(join(f.stage, "runtime/bun.exe"), "utf8")).toBe(vector.runtimeBytes);
  expect(await validateRuntimeReceipt(f.stage, f.source, f.context.orbitVersion)).toEqual(result);
});
test("download consent cannot come from the descriptor", async () => {
  const f = await fixture(); let calls = 0;
  await expect(materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, fetch: (async () => { calls++; throw new Error("not authorized"); }) })).rejects.toThrow("consent");
  expect(calls).toBe(0); expect(await readFile(f.archive)).toEqual(f.bytes);
});
test("official download counts exact bytes and records actual acquisition", async () => {
  const f = await fixture(), seen: string[] = [];
  const request = (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(f.bytes, { headers: { "content-length": String(f.bytes.length) } }); });
  const result = await materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, downloadAllowed: true, fetch: request });
  expect(seen).toEqual([f.source.url]); expect(result.acquisition).toBe("upstream-download");
});
test("fresh resource refusal precedes network and runtime writes", async () => {
  const f = await fixture(); let called = false;
  await expect(materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, downloadAllowed: true,
    preflight: async () => { throw new Error("resource reserve"); }, fetch: (async () => { called = true; throw new Error("unexpected"); }) })).rejects.toThrow("reserve");
  expect(called).toBe(false); await expect(readFile(join(f.stage, RUNTIME_RECEIPT))).rejects.toThrow();
});
test("verified private cache copy requires no network or hardlink", async () => {
  const f = await fixture(), version = f.context.orbitVersion, cache = join(f.root, "versions", version); await mkdir(cache, { recursive: true });
  await materializeWindowsRuntime(cache, f.source, f.context); const before = await readFile(join(cache, "runtime/bun.exe"));
  const result = await materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, cachedVersions: [version], fetch: (async () => { throw new Error("no network"); }) });
  expect(result.acquisition).toBe("verified-cache-copy"); expect(result.cacheOriginVersion).toBe(version);
  await writeFile(join(f.stage, "runtime/bun.exe"), "changed copy"); expect(await readFile(join(cache, "runtime/bun.exe"))).toEqual(before);
});
test("tampered cache is refused and not overwritten", async () => {
  const f = await fixture(), version = f.context.orbitVersion, cache = join(f.root, "versions", version); await mkdir(cache, { recursive: true });
  await materializeWindowsRuntime(cache, f.source, f.context); await writeFile(join(cache, "runtime/bun.exe"), "tampered");
  await expect(materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, cachedVersions: [version] })).rejects.toThrow();
  expect(await readFile(join(cache, "runtime/bun.exe"), "utf8")).toBe("tampered");
});
for (const [label, entries] of [
  ["traversal", [{ name: "../bun.exe", bytes: Buffer.from(vector.runtimeBytes) }]],
  ["extra executable", [{ name: "bun-windows-x64/bun.exe", bytes: Buffer.from(vector.runtimeBytes) }, { name: "bun-windows-x64/extra.exe" }]],
  ["link", [{ name: "bun-windows-x64/bun.exe", bytes: Buffer.from(vector.runtimeBytes), external: 0xa000 << 16 }]],
] as [string, ZipEntry[]][]) test("matching owned archive hash cannot permit " + label, async () => {
  const f = await fixture(entries); await expect(materializeWindowsRuntime(f.stage, f.source, f.context)).rejects.toThrow(); await expect(readFile(join(f.stage, RUNTIME_RECEIPT))).rejects.toThrow();
});
test("executable hash mismatch remains unsealed", async () => {
  const f = await fixture(); await expect(materializeWindowsRuntime(f.stage, { ...f.source, executableSha256: "f".repeat(64) }, f.context)).rejects.toThrow();
  await expect(readFile(join(f.stage, RUNTIME_RECEIPT))).rejects.toThrow();
});
test("redirects cannot leave official HTTPS hosts", async () => {
  const f = await fixture(); let calls = 0;
  await expect(materializeWindowsRuntime(f.stage, f.source, { ...f.context, providedArchive: undefined, downloadAllowed: true,
    fetch: (async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://evil.invalid/bun.zip" } }); }) })).rejects.toThrow(); expect(calls).toBe(1);
});
test("existing runtime and cancellation cannot grant a receipt", async () => {
  const f = await fixture(); await mkdir(join(f.stage, "runtime")); await writeFile(join(f.stage, "runtime/bun.exe"), "existing");
  await expect(materializeWindowsRuntime(f.stage, f.source, f.context)).rejects.toThrow(); expect(await readFile(join(f.stage, "runtime/bun.exe"), "utf8")).toBe("existing");
  const next = await fixture(), controller = new AbortController(); controller.abort(); await expect(materializeWindowsRuntime(next.stage, next.source, { ...next.context, signal: controller.signal })).rejects.toThrow();
  await expect(readFile(join(next.stage, RUNTIME_RECEIPT))).rejects.toThrow();
});
