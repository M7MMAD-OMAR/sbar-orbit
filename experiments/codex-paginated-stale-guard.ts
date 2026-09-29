import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PaginatedPageRequest } from "../src/codex-authority-gate";
import { createDisposablePaginatedReader } from "./codex-paginated-bwrap-bridge";

const MAX_FILES = 1000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 8;
const SQLITE_FILES = ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm",
  "thread_history_1.sqlite", "thread_history_1.sqlite-wal", "thread_history_1.sqlite-shm"];
const TOP_LEVEL = new Set([...SQLITE_FILES, "sessions"]);

type Fingerprint = { kind: "file" | "directory"; device: string; inode: string;
  mode: string; size: string; modified: string; changed: string; sha256?: string };
type Snapshot = Record<string, Fingerprint>;

export class StalePaginatedReadError extends Error {
  constructor() { super("Disposable paginated source changed during page read"); }
}

function fingerprintMetadata(info: BigIntStats): Omit<Fingerprint, "kind" | "sha256"> {
  return { device: String(info.dev), inode: String(info.ino), mode: String(info.mode),
    size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs) };
}

function sameMetadata(a: ReturnType<typeof fingerprintMetadata>, b: ReturnType<typeof fingerprintMetadata>) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function hashStableFile(path: string, before: BigIntStats,
                              total: { files: number; bytes: number }): Promise<Fingerprint> {
  if (!before.isFile() || ++total.files > MAX_FILES ||
      (total.bytes += Number(before.size)) > MAX_BYTES)
    throw new Error("Disposable paginated source exceeds its file or byte limit");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOATIME);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameMetadata(fingerprintMetadata(before), fingerprintMetadata(opened)))
      throw new StalePaginatedReadError();
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead === 0) throw new StalePaginatedReadError();
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameMetadata(fingerprintMetadata(opened), fingerprintMetadata(after)))
      throw new StalePaginatedReadError();
    return { kind: "file", ...fingerprintMetadata(after), sha256: digest.digest("hex") };
  } finally { await handle.close(); }
}

async function fingerprintTree(root: string): Promise<Snapshot> {
  const result: Snapshot = {};
  const total = { files: 0, bytes: 0 };
  const record = async (path: string, depth: number): Promise<void> => {
    const before = await lstat(path, { bigint: true });
    const key = relative(root, path) || ".";
    if (before.isFile()) {
      if (key.startsWith("sessions/") && !key.endsWith(".jsonl"))
        throw new Error("Disposable paginated source has an unexpected session file");
      result[key] = await hashStableFile(path, before, total);
      return;
    }
    if (!before.isDirectory() || depth > MAX_DEPTH)
      throw new Error("Disposable paginated source has an invalid entry");
    const names = (await readdir(path)).sort();
    if (path === root && names.some(name => !TOP_LEVEL.has(name)))
      throw new Error("Disposable paginated source contains an unexpected root file");
    const after = await lstat(path, { bigint: true });
    if (!sameMetadata(fingerprintMetadata(before), fingerprintMetadata(after)))
      throw new StalePaginatedReadError();
    result[key] = { kind: "directory", ...fingerprintMetadata(after) };
    for (const name of names) await record(join(path, name), depth + 1);
    const final = await lstat(path, { bigint: true });
    if (!sameMetadata(fingerprintMetadata(after), fingerprintMetadata(final)))
      throw new StalePaginatedReadError();
  };
  await record(root, 0);
  if (result["state_5.sqlite"]?.kind !== "file" ||
      result["thread_history_1.sqlite"]?.kind !== "file" ||
      result.sessions?.kind !== "directory")
    throw new Error("Disposable paginated source is missing required files");
  return result;
}

export async function guardDisposablePaginatedRead<T>(fixture: string, read: () => Promise<T>): Promise<T> {
  const root = await realpath(fixture);
  const before = await fingerprintTree(root);
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try { result = await read(); }
  catch (error) { failed = true; failure = error; }
  let after: Snapshot;
  try { after = await fingerprintTree(root); }
  catch { throw new StalePaginatedReadError(); }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new StalePaginatedReadError();
  if (failed) throw failure;
  return result as T;
}

export async function createDisposableStaleGuardedReader(binary: string, fixture: string) {
  const read = await createDisposablePaginatedReader(binary, fixture);
  return (request: PaginatedPageRequest) => guardDisposablePaginatedRead(fixture, () => read(request));
}
