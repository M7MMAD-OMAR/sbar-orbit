import { isAbsolute, join } from "node:path";
import { OrbitError } from "./errors";
import { requireResourceBudget } from "./resource-budget";

/** Owner command only; writes an unapplied configuration bundle. */
export async function prepareNative(directory: string | undefined) {
  if (!directory || !isAbsolute(directory)) throw new OrbitError("INVALID_REQUEST", "Use native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY");
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native preparation requires Linux and Hyprland");
  await requireResourceBudget();
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native/prepare.py"), directory], {
    stdout: "pipe", stderr: "pipe", timeout: 20000,
  });
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) throw new OrbitError("BACKEND_FAILED", "Native preparation output exceeded its bound");
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  }
  let stdout: string, stderr: string, code: number;
  try { [stdout, stderr, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); }
  catch (error) { child.kill(); await child.exited; throw error; }
  let reply: unknown;
  try { reply = JSON.parse(code === 0 ? stdout : stderr); }
  catch { throw new OrbitError("BACKEND_FAILED", "Native preparation did not return a result"); }
  if (code !== 0) throw new OrbitError("CONFIG_REQUIRED", "Native preparation failed; its directory must be private, empty and bound to a live Hyprland host");
  return reply;
}
