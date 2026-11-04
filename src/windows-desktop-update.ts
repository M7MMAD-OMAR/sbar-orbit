/** Windows desktop overlay integrity. Checksums share the publishing feed's trust, not code signing. */
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

export const DESKTOP_MANIFEST = "desktop-manifest.json";
export const DESKTOP_EXE = "desktop/windows-app/Orbit.Desktop.exe";
export const DESKTOP_LAUNCHER = "desktop/windows-app/Orbit.Launcher.exe";
export const DESKTOP_RUNTIME = "runtime/bun.exe";
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_FILES = 4096, MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const REPOSITORY = "M7MMAD-OMAR/sbar-orbit";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type DesktopManifest = { schema: 1; bootstrapProtocol: 1; version: string; platform: "win32"; arch: "x64"; sourceRevision: string; sourceDigest: string; files: { path: string; sha256: string }[] };
function fail(): never { throw new Error("Windows desktop payload is absent, incompatible or failed integrity validation"); }
export function desktopAssetName(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail();
  return "sbar-orbit-" + version + "-windows-x64-desktop.zip";
}
export function safeWindowsPayloadPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 240 || path.split("/").length > 32 || path.includes("\\") || path.startsWith("/") || path.includes(":")) fail();
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || !/^[A-Za-z0-9_. -]+$/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail();
  }
  return path;
}
function overlayPath(path: string) { return path === DESKTOP_RUNTIME || path.startsWith("desktop/windows-app/"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
export function parseDesktopManifest(value: unknown, version: string): DesktopManifest {
  const object = record(value);
  if (Object.keys(object).sort().join(",") !== "arch,bootstrapProtocol,files,platform,schema,sourceDigest,sourceRevision,version"
      || object.schema !== 1 || object.bootstrapProtocol !== 1 || object.version !== version || object.platform !== "win32" || object.arch !== "x64"
      || typeof object.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(object.sourceRevision)
      || typeof object.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(object.sourceDigest)
      || !Array.isArray(object.files) || object.files.length < 3 || object.files.length > MAX_FILES) fail();
  const seen = new Set<string>();
  const files = object.files.map(entry => {
    const item = record(entry), path = safeWindowsPayloadPath(item.path);
    if (Object.keys(item).sort().join(",") !== "path,sha256" || !overlayPath(path) || seen.has(path.toLowerCase())
        || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail();
    seen.add(path.toLowerCase()); return { path, sha256: item.sha256 };
  });
  if (![DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME].every(path => files.some(file => file.path === path))) fail();
  return { schema: 1, bootstrapProtocol: 1, version, platform: "win32", arch: "x64", sourceRevision: object.sourceRevision, sourceDigest: object.sourceDigest, files };
}

/** Identical to managed releaseDigest for source inputs, excluding only new overlay files. */
export async function desktopSourceDigest(directory: string) {
  const entries: [string, string][] = []; let visited = 0, total = 0;
  async function visit(relative: string, required = false) {
    if (++visited > 20000 || relative.split("/").length > 32 || relative.length > 512) fail();
    if (relative === "desktop/windows-app") return;
    const info = await lstat(join(directory, relative)).catch(error => { if (!required && error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) fail();
    if (info.isDirectory()) for (const name of (await readdir(join(directory, relative))).sort()) await visit(relative + "/" + name, true);
    else if (info.isFile()) { total += info.size; if (info.size > MAX_FILE_BYTES || total > MAX_EXPANDED_BYTES) fail(); entries.push([relative, await windowsFileDigest(join(directory, relative))]); }
    else fail();
  }
  for (const name of ["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"])
    await visit(name, ["package.json", "bun.lock", "bin", "src", "scripts"].includes(name));
  return hash(JSON.stringify(entries));
}
export async function windowsFileDigest(path: string) {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) fail();
  const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer); return digest.digest("hex");
}
export async function validateDesktopPayload(directory: string, version: string, expectedSourceDigest?: string) {
  const path = join(directory, DESKTOP_MANIFEST), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail();
  const manifest = parseDesktopManifest(JSON.parse(await readFile(path, "utf8")), version);
  if (expectedSourceDigest !== undefined && manifest.sourceDigest !== expectedSourceDigest) fail();
  const provenancePath = join(directory, "SOURCE-COMMIT.json");
  const provenance = await lstat(provenancePath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (provenance) {
    if (!provenance.isFile() || provenance.isSymbolicLink() || provenance.size > 4096) fail();
    const source = record(JSON.parse(await readFile(provenancePath, "utf8")));
    if (source.schema !== 1 || source.version !== version || source.sourceCommit !== manifest.sourceRevision) fail();
  }
  let total = 0, visited = 0; const actual = new Set<string>();
  async function walk(relative: string) {
    if (++visited > MAX_FILES + 256 || relative.split("/").length > 32 || relative.length > 240) fail();
    const entry = await lstat(join(directory, relative)); if (entry.isSymbolicLink()) fail();
    if (entry.isDirectory()) for (const name of await readdir(join(directory, relative))) await walk(relative + "/" + name);
    else if (entry.isFile()) { total += entry.size; if (total > MAX_EXPANDED_BYTES || actual.size >= MAX_FILES) fail(); actual.add(safeWindowsPayloadPath(relative)); }
    else fail();
  }
  await walk("desktop/windows-app"); await walk("runtime");
  if (actual.size !== manifest.files.length || manifest.files.some(file => !actual.has(file.path))) fail();
  for (const file of manifest.files) if (await windowsFileDigest(join(directory, file.path)) !== file.sha256) fail();
  return manifest;
}

/** Merge only a previously verified overlay into an owned source stage, never replace source files. */
export async function mergeDesktopOverlay(overlay: string, destination: string, manifest: DesktopManifest) {
  const root = resolve(destination);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) fail();
  for (const relative of [...manifest.files.map(file => file.path), DESKTOP_MANIFEST]) {
    safeWindowsPayloadPath(relative);
    let parent = root;
    for (const name of relative.split("/").slice(0, -1)) {
      parent = join(parent, name);
      await mkdir(parent).catch(error => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) fail();
    }
    const input = join(overlay, relative), target = join(root, relative), info = await lstat(input);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(input) !== resolve(input)) fail();
    await copyFile(input, target, constants.COPYFILE_EXCL);
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0; });
type Entry = { path: string; size: number; compressed: number; crc: number; method: number; flags: number; offset: number; directory: boolean };
/** Bounded ZIP32 store/deflate only. No subprocess, ZIP64, encrypted entries, links or overwrites. */
export async function extractDesktopZip(archive: string, destination: string) {
  const before = await lstat(archive);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(archive) !== resolve(archive)) fail();
  const parent = dirname(resolve(destination));
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) fail();
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never extract over existing files or reparse ancestors.
  if (await realpath(destination) !== resolve(destination)) fail();
  const input = await open(archive, "r");
  async function read(offset: number, length: number) {
    const bytes = Buffer.alloc(length); let done = 0;
    while (done < length) { const result = await input.read(bytes, done, length - done, offset + done); if (!result.bytesRead) fail(); done += result.bytesRead; }
    return bytes;
  }
  try {
    const info = await input.stat(); if (!info.isFile() || info.size < 22 || info.size > MAX_ZIP_BYTES) fail();
    const tailSize = Math.min(info.size, 65557), tail = await read(info.size - tailSize, tailSize);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    if (end < 0) fail();
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count !== tail.readUInt16LE(end + 8) || !count || count > MAX_FILES + 256
        || directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize !== info.size - tailSize + end) fail();
    const central = await read(directoryOffset, directorySize), entries: Entry[] = [], seen = new Map<string, string>(), filesystemEntries = new Set<string>();
    let at = 0, expanded = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) fail();
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10), compressed = central.readUInt32LE(at + 20), size = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28), extraLength = central.readUInt16LE(at + 30), commentLength = central.readUInt16LE(at + 32), external = central.readUInt32LE(at + 38), offset = central.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > central.length || flags & ~0x808 || ![0, 8].includes(method)
          || size > MAX_FILE_BYTES || compressed > MAX_ZIP_BYTES || compressed === 0xffffffff || offset === 0xffffffff || central.readUInt16LE(at + 34)) fail();
      const nameBytes = central.subarray(at + 46, at + 46 + nameLength);
      if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes), directory = raw.endsWith("/"), path = safeWindowsPayloadPath(directory ? raw.slice(0, -1) : raw);
      if (!(path === DESKTOP_MANIFEST || overlayPath(path) || directory && ["desktop", "desktop/windows-app", "runtime"].includes(path))) fail();
      const mode = external >>> 16, kind = mode & 0xf000;
      if (external & 0x400 || ![0, 0x8000, 0x4000].includes(kind) || kind === 0x4000 && !directory || kind === 0x8000 && directory || directory && (size || compressed)) fail();
      const key = path.toLowerCase(); if (seen.has(key)) fail();
      for (let length = 1; length <= path.split("/").length; length++) {
        const prefix = path.split("/").slice(0, length).join("/"), prior = seen.get("parent:" + prefix.toLowerCase());
        if (prior && prior !== prefix) fail(); seen.set("parent:" + prefix.toLowerCase(), prefix);
        filesystemEntries.add(prefix.toLowerCase()); if (filesystemEntries.size > MAX_FILES + 256) fail();
      }
      seen.set(key, path); expanded += size; if (expanded > MAX_EXPANDED_BYTES) fail();
      const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      for (let position = 0; position < extra.length;) { if (position + 4 > extra.length) fail(); const tag = extra.readUInt16LE(position), length = extra.readUInt16LE(position + 2); if (tag === 1 || position + 4 + length > extra.length) fail(); position += 4 + length; }
      entries.push({ path, size, compressed, method, flags, offset, crc: central.readUInt32LE(at + 16), directory });
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== central.length || entries.filter(entry => !entry.directory).length > MAX_FILES) fail();
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
      const output = join(destination, entry.path); if (!resolve(output).startsWith(resolve(destination) + sep)) fail();
      await mkdir(dirname(output), { recursive: true });
      if (entry.directory) { await mkdir(output, { recursive: true }); continue; }
      let written = 0, crc = 0xffffffff;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length; if (written > entry.size || written > MAX_FILE_BYTES) return callback(new Error("ZIP output exceeds bound"));
        for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
        callback(null, chunk);
      } });
      if (!entry.compressed) { if (entry.size !== 0 || entry.crc !== 0) fail(); await writeFile(output, Buffer.alloc(0), { flag: "wx", mode: 0o600 }); }
      else if (entry.method === 8) await pipeline(createReadStream(archive, { fd: input.fd, autoClose: false, start, end: finish - 1 }), createInflateRaw(), bound, createWriteStream(output, { flags: "wx", mode: 0o600 }));
      else await pipeline(createReadStream(archive, { fd: input.fd, autoClose: false, start, end: finish - 1 }), bound, createWriteStream(output, { flags: "wx", mode: 0o600 }));
      if (written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail();
    }
  } finally { await input.close(); }
}

async function fixedFetch(url: string, accept: string) {
  const signal = AbortSignal.timeout(120000);
  for (let redirects = 0; redirects < 4; redirects++) {
    const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) fail();
    const response = await fetch(url, { headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); await response.body?.cancel(); if (!location) fail(); url = new URL(location, url).href; continue; }
    return response;
  }
  fail();
}
export async function fetchDesktopOverlay(version: string, archive: string, options: { maturationHours?: number; now?: () => number } = {}) {
  const metadata = await fixedFetch("https://api.github.com/repos/" + REPOSITORY + "/releases/tags/v" + version, "application/vnd.github+json");
  if (metadata.status === 404) return { available: false as const };
  if (!metadata.ok || !metadata.body) fail();
  let bytes = 0, text = ""; const decoder = new TextDecoder();
  for await (const chunk of metadata.body) { bytes += chunk.length; if (bytes > 1024 * 1024) fail(); text += decoder.decode(chunk, { stream: true }); } text += decoder.decode();
  const release = record(JSON.parse(text));
  if (release.tag_name !== "v" + version || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) fail();
  const assets = release.assets.map(record).filter(asset => asset.name === desktopAssetName(version));
  if (!assets.length) return { available: false as const };
  if (assets.length !== 1) fail(); const asset = assets[0]!;
  if (asset.state !== "uploaded" || typeof asset.id !== "number" || !Number.isSafeInteger(asset.id) || asset.id <= 0 || typeof asset.size !== "number" || asset.size <= 0 || asset.size > MAX_ZIP_BYTES
      || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) fail();
  const delay = (options.maturationHours ?? 72) * 3600000, now = (options.now ?? Date.now)();
  if (!Number.isFinite(delay) || delay < 0 || !Number.isFinite(now)) fail();
  for (const timestamp of [release.published_at, asset.created_at]) {
    const published = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(published) || now - published < delay) return { available: false as const };
  }
  const reference = await fixedFetch("https://api.github.com/repos/" + REPOSITORY + "/git/ref/tags/v" + version, "application/vnd.github+json");
  if (!reference.ok) fail();
  async function json(response: Response) {
    if (!response.body) fail(); let count = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of response.body) { count += chunk.length; if (count > 65536) fail(); text += decoder.decode(chunk, { stream: true }); }
    return record(JSON.parse(text + decoder.decode()));
  }
  let target = record((await json(reference)).object);
  for (let depth = 0; target.type === "tag" && depth < 3; depth++) {
    if (typeof target.sha !== "string" || !/^[a-f0-9]{40}$/.test(target.sha)) fail();
    const tag = await fixedFetch("https://api.github.com/repos/" + REPOSITORY + "/git/tags/" + target.sha, "application/vnd.github+json");
    if (!tag.ok) fail(); target = record((await json(tag)).object);
  }
  if (target.type !== "commit" || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/.test(target.sha)) fail();
  const sourceRevision = target.sha;
  const response = await fixedFetch("https://api.github.com/repos/" + REPOSITORY + "/releases/assets/" + asset.id, "application/octet-stream");
  if (!response.ok || !response.body) fail();
  const output = await open(archive, "wx", 0o600), digest = createHash("sha256"); let received = 0;
  try {
    for await (const chunk of response.body) { received += chunk.length; if (received > MAX_ZIP_BYTES || received > asset.size) fail(); digest.update(chunk); let at = 0; while (at < chunk.length) { const wrote = await output.write(chunk, at); if (!wrote.bytesWritten) fail(); at += wrote.bytesWritten; } }
    if (received !== asset.size || "sha256:" + digest.digest("hex") !== asset.digest) fail();
  } finally { await output.close(); }
  return { available: true as const, assetDigest: asset.digest, sourceRevision };
}
