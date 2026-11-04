/** Exact Windows dependency tree attestation, sealed by the desktop manifest's inventory hash. */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeWindowsPayloadPath } from "./windows-zip";
export const DEPENDENCY_INVENTORY = "desktop/windows-app/dependency-files.tsv";
export const MAX_DEPENDENCY_FILES = 8192;
export const MAX_DEPENDENCY_ENTRIES = 20000;
export const MAX_DEPENDENCY_BYTES = 256 * 1024 * 1024;
export const MAX_DEPENDENCY_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DEPENDENCY_INVENTORY_BYTES = 2 * 1024 * 1024;
export type WindowsDependencyFile = { path: string; sha256: string };
function fail(): never { throw new Error("Windows dependency inventory or exact tree failed integrity validation"); }
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function parseWindowsDependencies(text: string): WindowsDependencyFile[] {
  if (!text || Buffer.byteLength(text) > MAX_DEPENDENCY_INVENTORY_BYTES || !/^[\x09\x0a\x20-\x7e]+$/.test(text) || !text.endsWith("\n")) fail();
  const rows = text.slice(0, -1).split("\n"); if (rows.length > MAX_DEPENDENCY_FILES) fail();
  const files: WindowsDependencyFile[] = [], seen = new Map<string, string>(); let previous = "";
  for (const row of rows) {
    if (!/^[a-f0-9]{64}\tnode_modules\//.test(row)) fail();
    const sha256 = row.slice(0, 64), path = safeWindowsPayloadPath(row.slice(65));
    if (!path.startsWith("node_modules/") || ordinal(previous, path) >= 0 || seen.has("file:" + path.toLowerCase())) fail();
    for (let depth = 1; depth <= path.split("/").length; depth++) {
      const part = path.split("/").slice(0, depth).join("/"), key = part.toLowerCase(), prior = seen.get(key);
      if (prior !== undefined && prior !== part) fail(); seen.set(key, part);
      if (depth < path.split("/").length && seen.has("file:" + key)) fail();
    }
    if (seen.has("parent:" + path.toLowerCase())) fail();
    for (let depth = 1; depth < path.split("/").length; depth++) seen.set("parent:" + path.split("/").slice(0, depth).join("/").toLowerCase(), path);
    seen.set("file:" + path.toLowerCase(), path); files.push({ path, sha256 }); previous = path;
  }
  if (!files.some(file => file.path === "node_modules/@modelcontextprotocol/sdk/package.json")) fail();
  return files;
}
async function canonicalDirectory(path: string) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail(); }
async function fileDigest(path: string, maximum: number) {
  const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maximum || await realpath(path) !== resolve(path)) fail();
  const input = await open(path, "r");
  try {
    const info = await input.stat(); if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) fail();
    let bytes = 0; const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { fd: input.fd, autoClose: false })) { bytes += (chunk as Buffer).length; if (bytes > maximum || bytes > info.size) fail(); hash.update(chunk as Buffer); }
    if (bytes !== info.size) fail(); return hash.digest("hex");
  } finally { await input.close(); }
}
export async function validateWindowsDependencies(root: string, expectedInventorySha256: string) {
  root = resolve(root); await canonicalDirectory(root);
  if (!/^[a-f0-9]{64}$/.test(expectedInventorySha256)) fail();
  let parent = root;
  for (const segment of DEPENDENCY_INVENTORY.split("/").slice(0, -1)) { parent = join(parent, segment); await canonicalDirectory(parent); }
  const inventory = join(root, DEPENDENCY_INVENTORY);
  const metadata = await lstat(inventory); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > MAX_DEPENDENCY_INVENTORY_BYTES || await realpath(inventory) !== resolve(inventory)) fail();
  const input = await open(inventory, "r"); let text: string;
  try {
    const pinned = await input.stat(); if (!pinned.isFile() || pinned.ino !== metadata.ino || pinned.dev !== metadata.dev || pinned.size !== metadata.size) fail();
    const bytes = Buffer.alloc(metadata.size); let offset = 0;
    while (offset < bytes.length) { const read = await input.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) fail(); offset += read.bytesRead; }
    if ((await input.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || createHash("sha256").update(bytes).digest("hex") !== expectedInventorySha256) fail();
    text = bytes.toString("utf8");
  } finally { await input.close(); }
  const entries = parseWindowsDependencies(text), expected = new Map(entries.map(entry => [entry.path, entry.sha256]));
  const directories = new Set<string>();
  for (const entry of entries) for (let length = 1; length < entry.path.split("/").length; length++) directories.add(entry.path.split("/").slice(0, length).join("/"));
  let visited = 0, count = 0, bytes = 0; const folded = new Set<string>();
  async function visit(relative: string) {
    if (++visited > MAX_DEPENDENCY_ENTRIES) fail(); safeWindowsPayloadPath(relative);
    const path = join(root, relative), info = await lstat(path), key = relative.toLowerCase();
    if (folded.has(key) || info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail(); folded.add(key);
    if (info.isDirectory()) {
      if (!directories.has(relative)) fail();
      for (const name of await readdir(path)) await visit(relative + "/" + name);
    } else if (info.isFile()) {
      bytes += info.size; if (++count > MAX_DEPENDENCY_FILES || bytes > MAX_DEPENDENCY_BYTES || !expected.has(relative)
          || await fileDigest(path, MAX_DEPENDENCY_FILE_BYTES) !== expected.get(relative)) fail();
    } else fail();
  }
  await visit("node_modules"); if (count !== entries.length) fail(); return entries;
}
export async function mergeWindowsDependencies(overlay: string, destination: string, expectedInventorySha256: string) {
  const entries = await validateWindowsDependencies(overlay, expectedInventorySha256); destination = resolve(destination); await canonicalDirectory(destination);
  if (await lstat(join(destination, "node_modules")).catch(error => { if (error.code === "ENOENT") return null; throw error; })) fail();
  for (const entry of entries) {
    let parent = destination;
    for (const segment of entry.path.split("/").slice(0, -1)) { parent = join(parent, segment); await mkdir(parent).catch(error => { if (error.code !== "EEXIST") throw error; }); await canonicalDirectory(parent); }
    await copyFile(join(overlay, entry.path), join(destination, entry.path), constants.COPYFILE_EXCL);
  }
  // Revalidate copied bytes, never trust a source-to-destination race or a successful copy alone.
  if (await fileDigest(join(destination, DEPENDENCY_INVENTORY), MAX_DEPENDENCY_INVENTORY_BYTES) !== expectedInventorySha256) fail();
  await validateWindowsDependencies(destination, expectedInventorySha256);
}
/** Publisher/owned-fixture builder only. Never normalizes or removes an existing user tree. */
export async function writeWindowsDependencyInventory(root: string) {
  root = resolve(root); await canonicalDirectory(root); const entries: WindowsDependencyFile[] = []; let count = 0, bytes = 0;
  async function visit(relative: string) {
    if (++count > MAX_DEPENDENCY_ENTRIES) fail(); safeWindowsPayloadPath(relative);
    const path = join(root, relative), info = await lstat(path);
    if (info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail();
    if (info.isDirectory()) { const names = await readdir(path); if (!names.length) fail(); for (const name of names) await visit(relative + "/" + name); }
    else if (info.isFile()) { bytes += info.size; if (bytes > MAX_DEPENDENCY_BYTES || entries.length >= MAX_DEPENDENCY_FILES) fail(); entries.push({ path: relative, sha256: await fileDigest(path, MAX_DEPENDENCY_FILE_BYTES) }); }
    else fail();
  }
  await visit("node_modules"); entries.sort((a, b) => ordinal(a.path, b.path)); const text = entries.map(entry => entry.sha256 + "\t" + entry.path + "\n").join("");
  parseWindowsDependencies(text); const file = join(root, DEPENDENCY_INVENTORY); await mkdir(dirname(file), { recursive: true });
  await canonicalDirectory(dirname(file)); await writeFile(file, text, { flag: "wx", mode: 0o600 });
  const sha256 = createHash("sha256").update(text).digest("hex"); await validateWindowsDependencies(root, sha256); return { text, sha256, entries };
}
