/** Windows desktop overlay integrity. Checksums share the publishing feed's trust, not code signing. */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractWindowsZip, safeWindowsPayloadPath } from "./windows-zip";
export { safeWindowsPayloadPath } from "./windows-zip";
import { DEPENDENCY_INVENTORY, mergeWindowsDependencies, validateWindowsDependencies } from "./windows-dependencies";
import { BUN_LICENSE_PATH, parseRuntimeSource, validateRuntimeReceipt, type RuntimeSourceV2 } from "./windows-runtime-source";

export const DESKTOP_MANIFEST = "desktop-manifest.json";
export const DESKTOP_EXE = "desktop/windows-app/Orbit.Desktop.exe";
export const DESKTOP_LAUNCHER = "desktop/windows-app/Orbit.Launcher.exe";
export const DESKTOP_RUNTIME = "runtime/bun.exe";
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_FILES = 4096, MAX_FILE_BYTES = 256 * 1024 * 1024;
const REPOSITORY = "M7MMAD-OMAR/sbar-orbit";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type DesktopManifest = { schema: 2; bootstrapProtocol: 2; version: string; platform: "win32"; arch: "x64"; sourceRevision: string; sourceDigest: string; runtimeSource: RuntimeSourceV2; files: { path: string; sha256: string }[] };
function fail(): never { throw new Error("Windows desktop payload is absent, incompatible or failed integrity validation"); }
export function desktopAssetName(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail();
  return "sbar-orbit-" + version + "-windows-x64-desktop.zip";
}
function overlayPath(path: string) { return path === DESKTOP_RUNTIME || path.startsWith("desktop/windows-app/"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
export function parseDesktopManifest(value: unknown, version: string): DesktopManifest {
  const item = record(value);
  if (Object.keys(item).sort().join(",") !== "arch,bootstrapProtocol,files,platform,runtimeSource,schema,sourceDigest,sourceRevision,version"
      || item.schema !== 2 || item.bootstrapProtocol !== 2 || item.version !== version || item.platform !== "win32" || item.arch !== "x64"
      || typeof item.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(item.sourceRevision)
      || typeof item.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceDigest)
      || !Array.isArray(item.files) || item.files.length < 5 || item.files.length > MAX_FILES) fail();
  const runtimeSource = parseRuntimeSource(item.runtimeSource), seen = new Set<string>();
  const files = item.files.map(entry => {
    const file = record(entry), path = safeWindowsPayloadPath(file.path);
    if (Object.keys(file).sort().join(",") !== "path,sha256" || !overlayPath(path) || seen.has(path.toLowerCase())
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        || path !== DESKTOP_RUNTIME && (file.sha256 === runtimeSource.executableSha256 || file.sha256 === runtimeSource.archiveSha256)) fail();
    seen.add(path.toLowerCase()); return { path, sha256: file.sha256 };
  });
  if (![DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_RUNTIME, BUN_LICENSE_PATH, DEPENDENCY_INVENTORY].every(path => files.some(file => file.path === path))
      || files.find(file => file.path === DESKTOP_RUNTIME)?.sha256 !== runtimeSource.executableSha256
      || files.find(file => file.path === BUN_LICENSE_PATH)?.sha256 !== runtimeSource.license.sha256) fail();
  return { schema: 2, bootstrapProtocol: 2, version, platform: "win32", arch: "x64", sourceRevision: item.sourceRevision, sourceDigest: item.sourceDigest, runtimeSource, files };
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
async function validateOverlay(directory: string, version: string, expectedSourceDigest: string | undefined, publicOverlay: boolean) {
  const root = await lstat(directory); if (!root.isDirectory() || root.isSymbolicLink() || await realpath(directory) !== resolve(directory)) fail();
  const desktop = join(directory, "desktop"); if ((await lstat(desktop)).isSymbolicLink() || await realpath(desktop) !== resolve(desktop)) fail();
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
  await walk("desktop/windows-app");
  if (publicOverlay) {
    if (await lstat(join(directory, "runtime")).catch(error => { if (error.code === "ENOENT") return null; throw error; })) fail();
    const roots = await readdir(directory); if (roots.some(name => !["desktop", "node_modules", DESKTOP_MANIFEST].includes(name))) fail();
    if ((await readdir(desktop)).some(name => name !== "windows-app")) fail();
  } else await walk("runtime");
  const expected = manifest.files.filter(file => !publicOverlay || file.path !== DESKTOP_RUNTIME);
  if (actual.size !== expected.length || expected.some(file => !actual.has(file.path))) fail();
  for (const file of expected) if (await windowsFileDigest(join(directory, file.path)) !== file.sha256) fail();
  const dependencies = await validateWindowsDependencies(directory, manifest.files.find(file => file.path === DEPENDENCY_INVENTORY)!.sha256);
  if (dependencies.some(file => file.sha256 === manifest.runtimeSource.executableSha256 || file.sha256 === manifest.runtimeSource.archiveSha256)) fail();
  if (!publicOverlay) await validateRuntimeReceipt(directory, manifest.runtimeSource, version);
  return manifest;
}
/** Complete private payload only. Runtime omission is never accepted here. */
export async function validateDesktopPayload(directory: string, version: string, expectedSourceDigest?: string) {
  return validateOverlay(directory, version, expectedSourceDigest, false);
}
/** Public artifacts have exactly one declared runtime hole and may not contain any runtime bytes. */
export async function validatePublicDesktopOverlay(directory: string, version: string, expectedSourceDigest?: string) {
  return validateOverlay(directory, version, expectedSourceDigest, true);
}

/** Merge only a previously verified overlay into an owned source stage, never replace source files. */
export async function mergeDesktopOverlay(overlay: string, destination: string, manifest: DesktopManifest) {
  const root = resolve(destination);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) fail();
  for (const relative of [...manifest.files.filter(file => file.path !== DESKTOP_RUNTIME).map(file => file.path), DESKTOP_MANIFEST]) {
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
  await mergeWindowsDependencies(overlay, destination, manifest.files.find(file => file.path === DEPENDENCY_INVENTORY)!.sha256);
}

/** Public schema-2 overlays never carry a runtime. */
export async function extractDesktopZip(archive: string, destination: string) {
  return extractWindowsZip(archive, destination, { maxArchiveBytes: MAX_ZIP_BYTES, maxExpandedBytes: MAX_EXPANDED_BYTES, maxFileBytes: MAX_FILE_BYTES, maxEntries: 20000, maxFiles: 12288, maxDepth: 32,
    allowPath: (path, directory) => path === DESKTOP_MANIFEST || path.startsWith("desktop/windows-app/") || path.startsWith("node_modules/") || directory && ["desktop", "desktop/windows-app", "node_modules"].includes(path) });
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
