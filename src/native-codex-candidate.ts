import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";

const installedRoot = "/usr/lib/chatgpt";
const format = "orbit-codex-candidate-v1";
const requiredFiles = [
  "app/ChatGPT",
  "app/version",
  "app/resources/app.asar",
  "app/resources/codex",
  "app/.codex-linux/features/shared-app-server-socket/orphan-reaper.js",
  "app/.codex-linux/features/shared-app-server-socket/sidebar-state-bridge.js",
] as const;
const digestPattern = /^[a-f0-9]{64}$/;

export type CodexCandidateManifest = {
  format: typeof format;
  sourceVersion: string;
  sourceAsarSha256: string;
  files: Record<string, string>;
};

function refuse(message: string): never {
  throw new OrbitError("UNSUPPORTED", message);
}

function candidateRoot(executable: string): string {
  if (executable !== resolve(executable) || executable.length > 4096 || executable.includes("\0") ||
      basename(executable) !== "ChatGPT" || basename(dirname(executable)) !== "app")
    refuse("Codex candidate executable needs a canonical staged app path");
  const root = dirname(dirname(executable));
  if (dirname(root) !== "/var/tmp" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(basename(root)))
    refuse("Codex candidate must be under one private /var/tmp directory");
  return root;
}

async function checkedEntry(path: string, directory: boolean, privateDirectory = false,
                            owner = BigInt(process.getuid?.() ?? -1)) {
  const info = await lstat(path, { bigint: true }).catch(() => refuse("Codex candidate file is unavailable"));
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      info.uid !== owner || (info.mode & 0o022n) !== 0n ||
      (privateDirectory && (info.mode & 0o077n) !== 0n) ||
      (!directory && (info.nlink !== 1n || info.size > 512n * 1024n * 1024n)) ||
      await realpath(path) !== path)
    refuse("Codex candidate contains a linked, shared or unowned path");
  return info;
}

async function scanCandidate(root: string) {
  const temporary = await lstat("/var/tmp", { bigint: true });
  if (!temporary.isDirectory() || temporary.uid !== 0n || (temporary.mode & 0o1000n) === 0n ||
      await realpath("/var/tmp") !== "/var/tmp")
    refuse("Codex candidate temporary parent is unsafe");
  await checkedEntry(root, true, true);
  const pending = [join(root, "app")];
  const files: string[] = [];
  let count = 0;
  let bytes = 0n;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const info = await lstat(current, { bigint: true });
    if (++count > 10000 || info.uid !== BigInt(process.getuid?.() ?? -1) ||
        info.isSymbolicLink() || (info.mode & 0o022n) !== 0n)
      refuse("Codex candidate tree is too large or has an unsafe entry");
    if (info.isDirectory()) {
      for (const name of await readdir(current)) pending.push(join(current, name));
    } else if (info.isFile() && info.nlink === 1n && info.size <= 512n * 1024n * 1024n) {
      bytes += info.size;
      if (bytes > 4n * 1024n * 1024n * 1024n)
        refuse("Codex candidate tree exceeds its size limit");
      files.push(current.slice(root.length + 1));
    } else refuse("Codex candidate tree contains a linked or special file");
  }
  files.sort();
  if (requiredFiles.some(path => !files.includes(path)))
    refuse("Codex candidate is missing a required Desktop or bridge file");
  return files;
}

async function sha256(path: string, owner?: bigint): Promise<string> {
  const before = await checkedEntry(path, false, false, owner);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      refuse("Codex candidate file changed before verification");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (offset !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        named.dev !== before.dev || named.ino !== before.ino || named.mtimeNs !== before.mtimeNs)
      refuse("Codex candidate file changed during verification");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function parseManifest(value: unknown): CodexCandidateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("Codex candidate manifest is invalid");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(",") !== "files,format,sourceAsarSha256,sourceVersion" ||
      manifest.format !== format || typeof manifest.sourceVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.sourceVersion) ||
      typeof manifest.sourceAsarSha256 !== "string" || !digestPattern.test(manifest.sourceAsarSha256) ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files))
    refuse("Codex candidate manifest is invalid");
  const files = manifest.files as Record<string, unknown>;
  if (requiredFiles.some(path => !Object.hasOwn(files, path)) ||
      Object.entries(files).some(([path, digest]) =>
        !path.startsWith("app/") || path.includes("\0") || path.split(sep).some(part => !part || part === "." || part === "..") ||
        typeof digest !== "string" || !digestPattern.test(digest)))
    refuse("Codex candidate manifest has missing or unexpected files");
  return manifest as CodexCandidateManifest;
}

export async function validateStagedCodexCandidate(
  executable: string,
  pinnedManifestSha256: string,
  sourceRoot = installedRoot,
): Promise<void> {
  if (!digestPattern.test(pinnedManifestSha256))
    refuse("Codex candidate needs a broker-pinned manifest SHA-256");
  const root = candidateRoot(executable);
  const candidateFiles = await scanCandidate(root);
  const manifestPath = join(root, "candidate-manifest.json");
  const manifestInfo = await checkedEntry(manifestPath, false);
  if (manifestInfo.size > 2n * 1024n * 1024n || (manifestInfo.mode & 0o077n) !== 0n)
    refuse("Codex candidate manifest must be private and bounded");
  const manifestBytes = await readFile(manifestPath);
  const manifestAfter = await lstat(manifestPath, { bigint: true });
  if (manifestBytes.length !== Number(manifestInfo.size) ||
      manifestAfter.dev !== manifestInfo.dev || manifestAfter.ino !== manifestInfo.ino ||
      manifestAfter.mtimeNs !== manifestInfo.mtimeNs ||
      createHash("sha256").update(manifestBytes).digest("hex") !== pinnedManifestSha256)
    refuse("Codex candidate manifest does not match the broker pin");
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); }
  catch { refuse("Codex candidate manifest is invalid JSON"); }
  const manifest = parseManifest(parsed);
  if (Object.keys(manifest.files).sort().join("\0") !== candidateFiles.join("\0"))
    refuse("Codex candidate tree differs from the broker-pinned manifest");
  if ((await readFile(join(root, "app", "version"), "utf8")).trim() !== manifest.sourceVersion ||
      (await readFile(join(sourceRoot, "version"), "utf8")).trim() !== manifest.sourceVersion)
    refuse("Codex candidate version differs from the installed Desktop");
  const sourceOwner = sourceRoot === installedRoot ? 0n : BigInt(process.getuid?.() ?? -1);
  if (await sha256(join(sourceRoot, "ChatGPT"), sourceOwner) !== manifest.files["app/ChatGPT"] ||
      await sha256(join(sourceRoot, "resources", "app.asar"), sourceOwner) !== manifest.sourceAsarSha256 ||
      manifest.files["app/resources/app.asar"] === manifest.sourceAsarSha256)
    refuse("Codex candidate does not match its installed source or patched ASAR");
  for (const path of candidateFiles) {
    if (await sha256(join(root, ...path.split(sep))) !== manifest.files[path])
      refuse("Codex candidate file differs from the broker-pinned manifest");
  }
}

export async function writeStagedCodexCandidateManifest(executable: string, sourceRoot = installedRoot) {
  const root = candidateRoot(executable);
  const candidateFiles = await scanCandidate(root);
  const sourceVersion = (await readFile(join(sourceRoot, "version"), "utf8")).trim();
  if (!/^\d+\.\d+\.\d+$/.test(sourceVersion) ||
      (await readFile(join(root, "app", "version"), "utf8")).trim() !== sourceVersion)
    refuse("Codex candidate version differs from the installed Desktop");
  const sourceOwner = sourceRoot === installedRoot ? 0n : BigInt(process.getuid?.() ?? -1);
  const sourceExecutable = await sha256(join(sourceRoot, "ChatGPT"), sourceOwner);
  const sourceAsarSha256 = await sha256(join(sourceRoot, "resources", "app.asar"), sourceOwner);
  const files: Record<string, string> = {};
  for (const path of candidateFiles) files[path] = await sha256(join(root, ...path.split(sep)));
  if (files["app/ChatGPT"] !== sourceExecutable || files["app/resources/app.asar"] === sourceAsarSha256)
    refuse("Codex candidate executable or ASAR does not match a patched source copy");
  const manifest: CodexCandidateManifest = { format, sourceVersion, sourceAsarSha256, files };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(root, "candidate-manifest.json");
  await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  try { await validateStagedCodexCandidate(executable, manifestSha256, sourceRoot); }
  catch (error) {
    await rm(manifestPath, { force: true });
    throw error;
  }
  return { manifestPath, manifestSha256 };
}
