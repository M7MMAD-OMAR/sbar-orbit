import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { OrbitError } from "./errors";

export const uploadByteLimit = 50 * 1024 * 1024;

type UploadReader = { read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }> };

/** Keep descriptor reads bounded even when the file grows after its size was checked. */
export async function readUploadBytes(handle: UploadReader, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > uploadByteLimit)
    throw new OrbitError("INVALID_REQUEST", "Invalid upload byte budget");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let remaining = limit;
  for (;;) {
    // One extra byte distinguishes EOF at the exact limit from an oversized growing file.
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    if (bytesRead > remaining) throw new OrbitError("INVALID_REQUEST", "Upload payload exceeds the in-memory byte limit");
    chunks.push(chunk.subarray(0, bytesRead));
    bytes += bytesRead;
    remaining -= bytesRead;
  }
  return Buffer.concat(chunks, bytes);
}

/** Read selected regular files within one combined payload budget, including concurrent growth. */
export async function readUploadPayloads(files: readonly { path: string; bytes: number }[], limit = uploadByteLimit) {
  const exceedsLimit = () => new OrbitError("INVALID_REQUEST", "Upload payload exceeds the in-memory byte limit");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > uploadByteLimit || files.reduce((total, file) => total + file.bytes, 0) > limit)
    throw exceedsLimit();
  let remaining = limit;
  const payloads: { name: string; mimeType: string; buffer: Buffer }[] = [];
  for (const file of files) {
    // Nonblocking opens cannot hang on a regular file replaced with a FIFO on POSIX.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const handle = await open(file.path, flags).catch(() => {
      throw new OrbitError("INVALID_REQUEST", "Upload source could not be opened as a regular file");
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new OrbitError("INVALID_REQUEST", "Upload source is not a regular file");
      if (info.size > remaining) throw exceedsLimit();
      const buffer = await readUploadBytes(handle, remaining);
      remaining -= buffer.length;
      payloads.push({ name: basename(file.path), mimeType: Bun.file(file.path).type || "application/octet-stream", buffer });
    } finally { await handle.close(); }
  }
  return payloads;
}
