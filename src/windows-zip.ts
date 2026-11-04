/** Bounded ZIP32 primitives. Policies are fixed by callers, never accepted from network JSON. */
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
function fail(): never { throw new Error("Windows ZIP failed bounded path or integrity validation"); }
export type WindowsZipPolicy = { maxArchiveBytes: number; maxExpandedBytes: number; maxFileBytes: number; maxEntries: number; maxFiles: number; maxDepth: number; allowPath: (path: string, directory: boolean) => boolean; signal?: AbortSignal };

export function safeWindowsPayloadPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 240 || path.split("/").length > 32 || path.includes("\\") || path.startsWith("/") || path.includes(":")) fail();
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const npmScope = index > 0 && parts[index - 1] === "node_modules" && /^@[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part);
    if (!part || part === "." || part === ".." || (!npmScope && !/^[A-Za-z0-9_. -]+$/.test(part)) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail();
  }
  return path;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0; });
type Entry = { path: string; size: number; compressed: number; crc: number; method: number; flags: number; offset: number; directory: boolean };
/** Bounded ZIP32 store/deflate only. No subprocess, ZIP64, encrypted entries, links or overwrites. */
export async function extractWindowsZip(archive: string, destination: string, policy: WindowsZipPolicy) {
  for (const value of [policy.maxArchiveBytes, policy.maxExpandedBytes, policy.maxFileBytes, policy.maxEntries, policy.maxFiles, policy.maxDepth]) if (!Number.isSafeInteger(value) || value <= 0) fail();
  if (policy.maxArchiveBytes > 256 * 1024 * 1024 || policy.maxExpandedBytes > 768 * 1024 * 1024 || policy.maxFileBytes > 256 * 1024 * 1024 || policy.maxEntries > 20000 || policy.maxFiles > 16384 || policy.maxDepth > 32) fail();
  const before = await lstat(archive);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(archive) !== resolve(archive)) fail();
  const parent = dirname(resolve(destination));
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) fail();
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never extract over existing files or reparse ancestors.
  if (await realpath(destination) !== resolve(destination)) fail();
  const input = await open(archive, "r");
  async function read(offset: number, length: number) {
    policy.signal?.throwIfAborted();
    const bytes = Buffer.alloc(length); let done = 0;
    while (done < length) { const result = await input.read(bytes, done, length - done, offset + done); if (!result.bytesRead) fail(); done += result.bytesRead; }
    return bytes;
  }
  try {
    const info = await input.stat(); if (!info.isFile() || info.size < 22 || info.size > policy.maxArchiveBytes) fail();
    const tailSize = Math.min(info.size, 65557), tail = await read(info.size - tailSize, tailSize);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    if (end < 0) fail();
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count !== tail.readUInt16LE(end + 8) || !count || count > policy.maxEntries
        || directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize !== info.size - tailSize + end) fail();
    const central = await read(directoryOffset, directorySize), entries: Entry[] = [], seen = new Map<string, string>(), filesystemEntries = new Set<string>();
    let at = 0, expanded = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) fail();
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10), compressed = central.readUInt32LE(at + 20), size = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28), extraLength = central.readUInt16LE(at + 30), commentLength = central.readUInt16LE(at + 32), external = central.readUInt32LE(at + 38), offset = central.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > central.length || flags & ~0x808 || ![0, 8].includes(method)
          || size > policy.maxFileBytes || compressed > policy.maxArchiveBytes || compressed === 0xffffffff || offset === 0xffffffff || central.readUInt16LE(at + 34)) fail();
      const nameBytes = central.subarray(at + 46, at + 46 + nameLength);
      if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes), directory = raw.endsWith("/"), path = safeWindowsPayloadPath(directory ? raw.slice(0, -1) : raw);
      if (path.split("/").length > policy.maxDepth || !policy.allowPath(path, directory)) fail();
      const mode = external >>> 16, kind = mode & 0xf000;
      if (external & 0x400 || ![0, 0x8000, 0x4000].includes(kind) || kind === 0x4000 && !directory || kind === 0x8000 && directory || directory && (size || compressed)) fail();
      const key = path.toLowerCase(); if (seen.has(key)) fail();
      for (let length = 1; length <= path.split("/").length; length++) {
        const prefix = path.split("/").slice(0, length).join("/"), prior = seen.get("parent:" + prefix.toLowerCase());
        if (prior && prior !== prefix) fail(); seen.set("parent:" + prefix.toLowerCase(), prefix);
        filesystemEntries.add(prefix.toLowerCase()); if (filesystemEntries.size > policy.maxEntries) fail();
      }
      seen.set(key, path); expanded += size; if (expanded > policy.maxExpandedBytes) fail();
      const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      for (let position = 0; position < extra.length;) { if (position + 4 > extra.length) fail(); const tag = extra.readUInt16LE(position), length = extra.readUInt16LE(position + 2); if (tag === 1 || position + 4 + length > extra.length) fail(); position += 4 + length; }
      entries.push({ path, size, compressed, method, flags, offset, crc: central.readUInt32LE(at + 16), directory });
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== central.length || entries.filter(entry => !entry.directory).length > policy.maxFiles) fail();
    const ranges: [number, number][] = [], ready: { entry: Entry; start: number; finish: number }[] = [];
    for (const entry of entries) {
      const local = await read(entry.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) fail();
      const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28), name = await read(entry.offset + 30, nameLength);
      if (name.toString("utf8") !== entry.path + (entry.directory ? "/" : "")) fail();
      if (!(entry.flags & 8) && (local.readUInt32LE(14) !== entry.crc || local.readUInt32LE(18) !== entry.compressed || local.readUInt32LE(22) !== entry.size)) fail();
      const start = entry.offset + 30 + nameLength + extraLength, finish = start + entry.compressed;
      if (finish > directoryOffset) fail(); ranges.push([entry.offset, finish]);
      const extra = await read(entry.offset + 30 + nameLength, extraLength);
      for (let position = 0; position < extra.length;) { if (position + 4 > extra.length) fail(); const tag = extra.readUInt16LE(position), length = extra.readUInt16LE(position + 2); if (tag === 1 || position + 4 + length > extra.length) fail(); position += 4 + length; }
      ready.push({ entry, start, finish });
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]![0] < ranges[index - 1]![1]) fail();
    for (const { entry, start, finish } of ready) {
      policy.signal?.throwIfAborted();
      const output = join(destination, entry.path); if (!resolve(output).startsWith(resolve(destination) + sep)) fail();
      await mkdir(dirname(output), { recursive: true });
      if (entry.directory) { await mkdir(output, { recursive: true }); continue; }
      let written = 0, crc = 0xffffffff;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length; if (written > entry.size || written > policy.maxFileBytes) return callback(new Error("ZIP output exceeds bound"));
        for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
        callback(null, chunk);
      } });
      if (!entry.compressed) { if (entry.size !== 0 || entry.crc !== 0) fail(); await writeFile(output, Buffer.alloc(0), { flag: "wx", mode: 0o600 }); }
      else if (entry.method === 8) await pipeline(createReadStream(archive, { fd: input.fd, autoClose: false, start, end: finish - 1 }), createInflateRaw(), bound, createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal: policy.signal });
      else await pipeline(createReadStream(archive, { fd: input.fd, autoClose: false, start, end: finish - 1 }), bound, createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal: policy.signal });
      if (written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail();
    }
  } finally { await input.close(); }
}
