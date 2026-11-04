/** Direct upstream runtime acquisition. No lifecycle, installer, desktop or IPC dependencies. */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import { extractWindowsZip } from "./windows-zip";

export const RUNTIME_RECEIPT = "runtime-source-receipt.json";
export const BUN_LICENSE_PATH = "desktop/windows-app/notices/bun/LICENSE.md";
export const MAX_RUNTIME_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
export type RuntimeSourceV2 = {
  kind: "bun-official-zip"; version: string; platform: "win32"; arch: "x64"; url: string;
  archiveSha256: string; archiveBytes: number; archiveEntry: "bun-windows-x64/bun.exe";
  executablePath: "runtime/bun.exe"; executableSha256: string; executableBytes: number;
  license: { url: string; sha256: string };
};
export type RuntimeReceiptV2 = {
  schema: 2; descriptorId: string; orbitVersion: string; runtimeVersion: string;
  executablePath: "runtime/bun.exe"; executableSha256: string; executableBytes: number;
  archiveSha256: string; archiveBytes: number; sourceUrl: string; archiveEntry: string;
  acquisition: "upstream-download" | "provided-archive" | "verified-cache-copy"; cacheOriginVersion: string | null;
};
function fail(message = "Windows runtime source failed integrity, consent or resource validation"): never { throw new Error(message); }
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const orbitVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
export function parseRuntimeSource(value: unknown): RuntimeSourceV2 {
  const item = object(value), license = object(item.license);
  if (Object.keys(item).sort().join(",") !== "arch,archiveBytes,archiveEntry,archiveSha256,executableBytes,executablePath,executableSha256,kind,license,platform,url,version"
      || Object.keys(license).sort().join(",") !== "sha256,url" || item.kind !== "bun-official-zip" || item.platform !== "win32" || item.arch !== "x64"
      || typeof item.version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(item.version)
      || item.url !== "https://github.com/oven-sh/bun/releases/download/bun-v" + item.version + "/bun-windows-x64.zip"
      || item.archiveEntry !== "bun-windows-x64/bun.exe" || item.executablePath !== "runtime/bun.exe"
      || !hex(item.archiveSha256) || !hex(item.executableSha256) || !hex(license.sha256)
      || license.url !== "https://raw.githubusercontent.com/oven-sh/bun/bun-v" + item.version + "/LICENSE.md"
      || typeof item.archiveBytes !== "number" || !Number.isSafeInteger(item.archiveBytes) || item.archiveBytes <= 0 || item.archiveBytes > MAX_RUNTIME_ARCHIVE_BYTES
      || typeof item.executableBytes !== "number" || !Number.isSafeInteger(item.executableBytes) || item.executableBytes <= 0 || item.executableBytes > MAX_RUNTIME_BYTES) fail();
  return { kind: "bun-official-zip", version: item.version, platform: "win32", arch: "x64", url: item.url as string,
    archiveSha256: item.archiveSha256, archiveBytes: item.archiveBytes, archiveEntry: "bun-windows-x64/bun.exe",
    executablePath: "runtime/bun.exe", executableSha256: item.executableSha256, executableBytes: item.executableBytes,
    license: { url: license.url as string, sha256: license.sha256 } };
}
export function runtimeDescriptorId(value: RuntimeSourceV2) {
  const source = parseRuntimeSource(value);
  const fields = [source.kind, source.version, source.platform, source.arch, source.url, source.archiveSha256, String(source.archiveBytes), source.archiveEntry,
    source.executablePath, source.executableSha256, String(source.executableBytes), source.license.url, source.license.sha256];
  return createHash("sha256").update(fields.map(field => Buffer.byteLength(field, "utf8") + ":" + field).join(""), "utf8").digest("hex");
}
export function parseRuntimeReceipt(value: unknown, source: RuntimeSourceV2, version: string): RuntimeReceiptV2 {
  source = parseRuntimeSource(source); const item = object(value);
  if (!orbitVersion(version) || Object.keys(item).sort().join(",") !== "acquisition,archiveBytes,archiveEntry,archiveSha256,cacheOriginVersion,descriptorId,executableBytes,executablePath,executableSha256,orbitVersion,runtimeVersion,schema,sourceUrl"
      || item.schema !== 2 || item.descriptorId !== runtimeDescriptorId(source) || item.orbitVersion !== version || item.runtimeVersion !== source.version
      || item.executablePath !== source.executablePath || item.executableSha256 !== source.executableSha256 || item.executableBytes !== source.executableBytes
      || item.archiveSha256 !== source.archiveSha256 || item.archiveBytes !== source.archiveBytes || item.sourceUrl !== source.url || item.archiveEntry !== source.archiveEntry
      || typeof item.acquisition !== "string" || !["upstream-download", "provided-archive", "verified-cache-copy"].includes(item.acquisition)
      || (item.acquisition === "verified-cache-copy" ? !orbitVersion(item.cacheOriginVersion) : item.cacheOriginVersion !== null)) fail();
  return item as unknown as RuntimeReceiptV2;
}
async function absent(path: string) { return lstat(path).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; }); }
async function canonicalDirectory(path: string) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail(); }
export async function runtimeFileDigest(path: string, expectedBytes?: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MAX_RUNTIME_BYTES || expectedBytes !== undefined && info.size !== expectedBytes || await realpath(path) !== resolve(path)) fail();
  const input = await open(path, "r");
  try {
    const pinned = await input.stat(); if (!pinned.isFile() || pinned.size !== info.size || pinned.dev !== info.dev || pinned.ino !== info.ino) fail();
    const hash = createHash("sha256"); let count = 0;
    for await (const chunk of createReadStream(path, { fd: input.fd, autoClose: false })) {
      count += (chunk as Buffer).length; if (count > MAX_RUNTIME_BYTES || expectedBytes !== undefined && count > expectedBytes) fail(); hash.update(chunk as Buffer);
    }
    if (count !== info.size || expectedBytes !== undefined && count !== expectedBytes) fail(); return hash.digest("hex");
  } finally { await input.close(); }
}
export async function validateRuntimeReceipt(directory: string, source: RuntimeSourceV2, version: string) {
  source = parseRuntimeSource(source); await canonicalDirectory(directory); await canonicalDirectory(join(directory, "runtime"));
  const file = join(directory, RUNTIME_RECEIPT), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || await realpath(file) !== resolve(file)) fail();
  const receipt = parseRuntimeReceipt(JSON.parse(await readFile(file, "utf8")), source, version);
  if (await runtimeFileDigest(join(directory, source.executablePath), source.executableBytes) !== source.executableSha256) fail();
  return receipt;
}
export async function runtimeAcquisitionPreflight(directory: string, bytes: number) {
  if (freemem() < 512 * 1024 * 1024) fail("Insufficient available memory for private runtime acquisition");
  const space = await statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 64n * 1024n * 1024n) fail("Insufficient available disk space for private runtime acquisition");
}
/** Only the callable HTTP surface used here, not Bun fetch.preconnect. */
export type RuntimeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type RuntimeAcquisitionContext = {
  orbitVersion: string; managedRoot: string; cachedVersions?: readonly string[];
  /** Caller-owned consent/settings, never read from downloaded manifest fields. */
  downloadAllowed: boolean; providedArchive?: string; signal?: AbortSignal;
  /** Owned source fixtures only. The CLI does not deserialize these callbacks. */
  fetch?: RuntimeFetch; preflight?: typeof runtimeAcquisitionPreflight;
};
function receipt(source: RuntimeSourceV2, context: RuntimeAcquisitionContext, acquisition: RuntimeReceiptV2["acquisition"], cacheOriginVersion: string | null): RuntimeReceiptV2 {
  return { schema: 2, descriptorId: runtimeDescriptorId(source), orbitVersion: context.orbitVersion, runtimeVersion: source.version,
    executablePath: source.executablePath, executableSha256: source.executableSha256, executableBytes: source.executableBytes,
    archiveSha256: source.archiveSha256, archiveBytes: source.archiveBytes, sourceUrl: source.url, archiveEntry: source.archiveEntry, acquisition, cacheOriginVersion };
}
async function download(source: RuntimeSourceV2, path: string, request: RuntimeFetch, signal: AbortSignal, created: () => void) {
  let url = source.url;
  for (let redirects = 0; redirects < 4; redirects++) {
    signal.throwIfAborted(); const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash
        || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) fail();
    const response = await request(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel(); if (!location) fail(); url = new URL(location, url).href; continue;
    }
    if (!response.ok || !response.body) fail("Official runtime download was unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== source.archiveBytes)) { await response.body.cancel(); fail(); }
    const output = await open(path, "wx", 0o600); created(); let size = 0; const hash = createHash("sha256");
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length; if (size > source.archiveBytes || size > MAX_RUNTIME_ARCHIVE_BYTES) fail(); hash.update(chunk);
        let at = 0; while (at < chunk.length) { const wrote = await output.write(chunk, at); if (!wrote.bytesWritten) fail(); at += wrote.bytesWritten; }
      }
      if (size !== source.archiveBytes || hash.digest("hex") !== source.archiveSha256) fail();
    } finally { await output.close(); }
    return;
  }
  fail("Official runtime redirect limit exceeded");
}
export async function materializeWindowsRuntime(directory: string, value: RuntimeSourceV2, context: RuntimeAcquisitionContext) {
  const source = parseRuntimeSource(value); if (!orbitVersion(context.orbitVersion) || typeof context.downloadAllowed !== "boolean" || (context.cachedVersions?.length ?? 0) > 32) fail();
  directory = resolve(directory); await canonicalDirectory(directory);
  if (!await absent(join(directory, "runtime")) || !await absent(join(directory, RUNTIME_RECEIPT))) fail("Runtime stage must be new and exclusive");
  const deadline = AbortSignal.timeout(300000), signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
  signal.throwIfAborted(); const preflight = context.preflight ?? runtimeAcquisitionPreflight;
  const finish = async (result: RuntimeReceiptV2) => {
    signal.throwIfAborted(); if (await runtimeFileDigest(join(directory, source.executablePath), source.executableBytes) !== source.executableSha256) fail();
    await writeFile(join(directory, RUNTIME_RECEIPT), JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
    return validateRuntimeReceipt(directory, source, context.orbitVersion);
  };
  for (const version of context.cachedVersions ?? []) {
    if (!orbitVersion(version)) fail();
    const root = resolve(context.managedRoot); await canonicalDirectory(root); await canonicalDirectory(join(root, "versions"));
    const cached = join(root, "versions", version);
    try { await validateRuntimeReceipt(cached, source, version); } catch { continue; }
    signal.throwIfAborted(); await preflight(directory, source.executableBytes); await mkdir(join(directory, "runtime"));
    await copyFile(join(cached, source.executablePath), join(directory, source.executablePath), constants.COPYFILE_EXCL);
    return finish(receipt(source, context, "verified-cache-copy", version));
  }
  if (!context.providedArchive && !context.downloadAllowed) fail("Runtime download requires explicit installer or update consent");
  await preflight(directory, source.archiveBytes + source.executableBytes);
  const archive = join(directory, ".bun-upstream-" + crypto.randomUUID() + ".zip"), extracted = join(directory, ".bun-extracted-" + crypto.randomUUID());
  let extractedComplete = false, archiveCreated = false;
  try {
    if (context.providedArchive) {
      if (await runtimeFileDigest(context.providedArchive, source.archiveBytes) !== source.archiveSha256) fail();
      await copyFile(context.providedArchive, archive, constants.COPYFILE_EXCL); archiveCreated = true;
    } else await download(source, archive, context.fetch ?? fetch, signal, () => { archiveCreated = true; });
    if (await runtimeFileDigest(archive, source.archiveBytes) !== source.archiveSha256) fail();
    // Only the fixed official root and one executable may be materialized.
    await extractWindowsZip(archive, extracted, { maxArchiveBytes: MAX_RUNTIME_ARCHIVE_BYTES, maxExpandedBytes: MAX_RUNTIME_BYTES, maxFileBytes: MAX_RUNTIME_BYTES,
      maxEntries: 32, maxFiles: 1, maxDepth: 8, allowPath: (path, isDirectory) => isDirectory ? path === "bun-windows-x64" : path === source.archiveEntry, signal });
    extractedComplete = true;
    const executable = join(extracted, source.archiveEntry);
    if (await runtimeFileDigest(executable, source.executableBytes) !== source.executableSha256) fail();
    signal.throwIfAborted(); await mkdir(join(directory, "runtime"));
    await copyFile(executable, join(directory, source.executablePath), constants.COPYFILE_EXCL);
    return await finish(receipt(source, context, context.providedArchive ? "provided-archive" : "upstream-download", null));
  } finally {
    // Both exact UUID paths were exclusively created for this private staging operation.
    if (archiveCreated) await rm(archive, { force: true });
    // A failed extraction stays quarantined; never erase a pre-existing extraction target.
    if (extractedComplete) await rm(extracted, { recursive: true, force: true });
  }
}
