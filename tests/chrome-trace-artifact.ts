import { createHash, randomUUID, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { reassembleTraceOutput } from "./chrome-trace-output-probe";

export const chromeTraceArtifactByteLimit = 8 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(reason: string): never { throw new Error("chrome-trace-artifact: " + reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function directory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) refuse("directory ownership");
}
function owned(config: { root: string; token: string }) {
  if (!/^[a-f0-9]{64}$/.test(config.token)) refuse("window token");
  directory(dirname(dirname(config.root))); directory(dirname(config.root)); directory(config.root);
  const rootInfo = lstatSync(config.root);
  if (process.platform !== "win32" && ((rootInfo.mode & 0o777) !== 0o700 || rootInfo.uid !== process.getuid?.())) refuse("private owned root");
  const path = join(config.root, "expected-window.json"), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 || realpathSync(path) !== path) refuse("expected window file");
  if (process.platform !== "win32" && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())) refuse("private owned admission");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value) || value.token !== config.token || value.schema !== 1) refuse("expected window mismatch");
}
type PersistencePhase = "frames" | "status";
export type ChromeTraceArtifactIO = { sync?: (fd: number, phase: PersistencePhase) => void };
function persistExclusive(path: string, bytes: Buffer, sync: (fd: number) => void = fsyncSync) {
  const fd = openSync(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) refuse("zero write");
      offset += count;
    }
    sync(fd);
  } finally { closeSync(fd); }
}
export function createChromeTraceArtifactWindow(checkout: string) {
  const output = join(realpathSync(checkout), "output");
  try { directory(output); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(output, { mode: 0o700 }); directory(output);
  }
  const parent = join(output, "chrome-trace");
  try { directory(parent); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(parent, { mode: 0o700 }); directory(parent);
  }
  const config = { root: join(parent, randomUUID()), token: randomBytes(32).toString("hex") };
  mkdirSync(config.root, { mode: 0o700 });
  persistExclusive(join(config.root, "expected-window.json"), Buffer.from(JSON.stringify({ schema: 1, token: config.token }) + "\n"));
  owned(config); return config;
}
export function chromeTraceArtifactConfiguration(env = process.env) {
  const root = env.ORBIT_TEST_CHROME_TRACE_ROOT, token = env.ORBIT_TEST_CHROME_TRACE_TOKEN;
  if (root === undefined && token === undefined) return undefined;
  if (root === undefined || token === undefined || resolve(root) !== root) refuse("partial configuration");
  if (dirname(root) !== join(realpathSync(join(import.meta.dir, "..")), "output/chrome-trace")) refuse("configuration outside checkout");
  const config = { root, token }; owned(config); return config;
}
export function createOwnedChromeTraceArtifactWriter(config: { root: string; token: string }, io: ChromeTraceArtifactIO = {}) {
  owned(config);
  const fd = openSync(join(config.root, "frames.jsonl"), "wx", 0o600);
  const synchronize = io.sync ?? ((descriptor: number, _phase: PersistencePhase) => fsyncSync(descriptor));
  const hash = createHash("sha256");
  let bytes = 0, lines = 0, traceId: string | undefined, message = 0, failed = false, closed = false;
  return {
    writeLine(line: string) {
      try {
        if (closed || failed || line.includes("\n") || line.includes("\r")) refuse("writer state or physical line");
        const part = Buffer.from(line + "\n");
        if (part.length > 4096 || bytes + part.length > chromeTraceArtifactByteLimit) refuse("artifact byte bound");
        const value: unknown = JSON.parse(line);
        if (!object(value) || value.chromeTraceFrame !== "orbit-chrome-trace" || typeof value.traceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.traceId)) refuse("frame identity");
        if (traceId !== undefined && value.traceId !== traceId) refuse("foreign trace");
        traceId = value.traceId;
        let offset = 0;
        while (offset < part.length) {
          const count = writeSync(fd, part, offset, part.length - offset);
          if (count <= 0) refuse("zero write");
          offset += count;
        }
        hash.update(part); bytes += part.length; lines++;
        if (value.kind === "emission-manifest" && typeof value.message === "number") message = value.message;
      } catch (error) { failed = true; throw error; }
    },
    close() {
      if (closed) refuse("duplicate close");
      closed = true;
      try { synchronize(fd, "frames"); } catch { failed = true; }
      try { closeSync(fd); } catch { failed = true; }
      const status = { schema: 1, token: config.token, framesPersisted: !failed, writeFailed: failed, traceId, bytes, lines, message, sha256: hash.digest("hex"), limit: "Frame fsync/close return only. This file cannot attest its own persistence; successful original child exit is required." };
      try {
        owned(config);
        persistExclusive(join(config.root, "capture-status.json"), Buffer.from(JSON.stringify(status) + "\n"), descriptor => synchronize(descriptor, "status"));
      } catch {
        failed = true;
        // Observable refusal only. Persistent cleanup/marker failure still requires child-exit evidence.
        try { unlinkSync(join(config.root, "capture-status.json")); } catch {}
        try { persistExclusive(join(config.root, "capture-refused.json"), Buffer.from(JSON.stringify({ schema: 1, token: config.token, refused: true, reason: "status persistence failed", limit: "Best effort marker; original nonzero child exit remains authoritative" }) + "\n")); } catch {}
      }
      if (failed) refuse("capture persistence failed");
      return status;
    },
  };
}
export function validateChromeTraceArtifact(config: { root: string; token: string }, expected: { messages: number; producer: Record<string, string>; observerHealthy: boolean }) {
  owned(config);
  try { lstatSync(join(config.root, "capture-refused.json")); refuse("capture refusal marker"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const read = (name: string, max: number) => {
    const path = join(config.root, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > max || realpathSync(path) !== path) refuse("retained file bounds");
    if (process.platform !== "win32" && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())) refuse("private owned retained file");
    return readFileSync(path);
  };
  const raw = read("frames.jsonl", chromeTraceArtifactByteLimit), status: unknown = JSON.parse(read("capture-status.json", 4096).toString("utf8"));
  if (!object(status) || status.schema !== 1 || status.token !== config.token || status.framesPersisted !== true || status.writeFailed !== false || status.bytes !== raw.length || status.sha256 !== digest(raw) || status.message !== expected.messages || typeof status.traceId !== "string") refuse("capture seal mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (!text.endsWith("\n")) refuse("unterminated physical line");
  const lines = text.slice(0, -1).split("\n");
  if (status.lines !== lines.length) refuse("line count mismatch");
  const ordinals = new Set<number>();
  for (const line of lines) {
    const frame: unknown = JSON.parse(line);
    if (!object(frame) || frame.traceId !== status.traceId || typeof frame.message !== "number") refuse("foreign frame identity");
    ordinals.add(frame.message);
  }
  if (ordinals.size !== expected.messages || [...ordinals].some(n => !Number.isInteger(n) || n < 1 || n > expected.messages)) refuse("logical ordinals");
  const messages = [];
  for (let n = 1; n <= expected.messages; n++) {
    const reconstructed = reassembleTraceOutput(lines, status.traceId, n);
    if (!object(reconstructed.value.producer) || JSON.stringify(Object.entries(reconstructed.value.producer).sort()) !== JSON.stringify(Object.entries(expected.producer).sort())) refuse("producer mismatch");
    const isFinal = object(reconstructed.value.final);
    if (isFinal !== (n === expected.messages)) refuse("final position");
    messages.push({ ordinal: n, bytes: reconstructed.bytes.length, sha256: digest(reconstructed.bytes), value: reconstructed.value });
  }
  const final = messages.at(-1)?.value.final;
  if (expected.observerHealthy && (!object(final) || final.refused !== 0 || final.observerErrors !== 0 || final.sinkErrors !== 0)) refuse("observer capture failure");
  return { complete: true, traceId: status.traceId, bytes: raw.length, sha256: digest(raw), messages, limit: "Strict captured bytes only; original child exit is required and status cannot attest its own persistence" };
}
