import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
export const pipeReceiptBound = 2097152;
export interface PipeAttempt { schema: 1; attempt: string; verb: "observe" | "list"; startedMs: number }
export function newPipeAttempt(verb: "observe" | "list"): PipeAttempt { return { schema: 1, attempt: randomUUID(), verb, startedMs: performance.now() }; }
export function pipeBytes(bytes: Uint8Array) { return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }; }
export interface PipeSupervisorRow { sequence: number; stage: "spawn-returned" | "streams-exit-settled" | "finally-kill-dispatched" | "finally-exit-settled"; clock: "bun-performance-ms"; elapsedMs: number; awaitedExit: number | null; exitCodeSnapshot: number | null }
export interface PipeAttemptReceipt { identity: PipeAttempt; budgets: { communicateSeconds: 6; supervisorMs: 8000; testMs: 15000; rpcMs: 45000; delaySeconds: 0.05 }; supervisor: PipeSupervisorRow[]; python: { clock: "python-perf-counter-ns"; raw: ReturnType<typeof pipeBytes> | undefined }; raw: { capture: "complete" | "not measured"; report: ReturnType<typeof pipeBytes> | undefined; stderr: ReturnType<typeof pipeBytes> | undefined }; actualChildPid: number; deadlineObserved: "not measured"; cleanup: "not measured" }
export function admitPipeAttempt(value: PipeAttemptReceipt) {
  const identity = value.identity;
  if (identity.schema !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.attempt)) return false;
  if (identity.verb !== "observe" && identity.verb !== "list") return false;
  const budgets = value.budgets;
  if (budgets.communicateSeconds !== 6 || budgets.supervisorMs !== 8000 || budgets.testMs !== 15000 || budgets.rpcMs !== 45000 || budgets.delaySeconds !== 0.05) return false;
  if (!Number.isSafeInteger(value.actualChildPid) || value.actualChildPid <= 0 || value.deadlineObserved !== "not measured" || value.cleanup !== "not measured") return false;
  let previous = -1;
  for (const [index, row] of value.supervisor.entries()) {
    if (row.sequence !== index + 1 || row.clock !== "bun-performance-ms" || !Number.isFinite(row.elapsedMs) || row.elapsedMs < previous) return false;
    if (!["spawn-returned", "streams-exit-settled", "finally-kill-dispatched", "finally-exit-settled"].includes(row.stage)) return false;
    if ((row.awaitedExit !== null && !Number.isSafeInteger(row.awaitedExit)) || (row.exitCodeSnapshot !== null && !Number.isSafeInteger(row.exitCodeSnapshot))) return false;
    previous = row.elapsedMs;
  }
  const first = value.supervisor[0], final = value.supervisor.at(-1);
  if (first?.stage !== "spawn-returned" || final?.stage !== "finally-exit-settled") return false;
  if (value.supervisor.filter(row => row.stage === "finally-exit-settled").length !== 1 || value.supervisor.filter(row => row.stage === "streams-exit-settled").length > 1 || value.supervisor.filter(row => row.stage === "finally-kill-dispatched").length > 1) return false;
  if (value.python.clock !== "python-perf-counter-ns" || (value.python.raw !== undefined && (value.python.raw.bytes > 8192 || value.python.raw.bytes < 0 || !/^[0-9a-f]{64}$/.test(value.python.raw.sha256)))) return false;
  if (value.raw.capture === "not measured") return value.raw.report === undefined && value.raw.stderr === undefined;
  return value.raw.capture === "complete" && value.raw.report !== undefined && value.raw.stderr !== undefined && value.raw.report.bytes >= 0 && value.raw.stderr.bytes >= 0 && /^[0-9a-f]{64}$/.test(value.raw.report.sha256) && /^[0-9a-f]{64}$/.test(value.raw.stderr.sha256);
}
export function admitPipeAttempts(values: PipeAttemptReceipt[]) { return values.every(admitPipeAttempt) && new Set(values.map(value => value.identity.attempt)).size === values.length; }
function inside(fixture: string, directory: string) {
  const child = relative(fixture, directory);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}
/** Resolve existing ancestors before creating any receipt directory. */
async function canonicalDestination(directory: string) {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("No owned receipt ancestor");
      missing.unshift(relative(parent, ancestor)); ancestor = parent;
    }
  }
  return resolve(await realpath(ancestor), ...missing);
}
/** Admit canonical ancestry outside the removable fixture before writing artifact bytes. */
export async function retainPipeAttempt(directory: string, fixture: string, value: PipeAttemptReceipt, report: Uint8Array, stderr: Uint8Array, pythonRaw?: Uint8Array) {
  if (!isAbsolute(directory)) throw new Error("Invalid owned pipe receipt directory");
  const canonicalFixture = await realpath(fixture);
  const destination = await canonicalDestination(directory);
  if (inside(canonicalFixture, destination)) throw new Error("Receipt directory resolves inside removable fixture");
  if (!admitPipeAttempt(value) || (value.raw.capture === "complete" && (JSON.stringify(value.raw.report) !== JSON.stringify(pipeBytes(report)) || JSON.stringify(value.raw.stderr) !== JSON.stringify(pipeBytes(stderr))))) throw new Error("Invalid owned pipe receipt");
  if (JSON.stringify(value.python.raw) !== JSON.stringify(pythonRaw === undefined ? undefined : pipeBytes(pythonRaw))) throw new Error("Invalid Python raw receipt");
  for (const bytes of [report, stderr, pythonRaw ?? new Uint8Array()]) if (bytes.byteLength > pipeReceiptBound) throw new Error("Pipe receipt raw overflow");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (inside(canonicalFixture, await realpath(directory))) throw new Error("Receipt ancestry changed");
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pipe receipt directory is not owned directory");
  const slot = join(directory, value.identity.attempt); await mkdir(slot, { mode: 0o700 }); await chmod(slot, 0o700);
  if (value.raw.capture === "complete") {
    await writeFile(join(slot, "report.raw"), report, { flag: "wx", mode: 0o600 });
    await writeFile(join(slot, "stderr.raw"), stderr, { flag: "wx", mode: 0o600 });
  }
  if (pythonRaw !== undefined) await writeFile(join(slot, "python.raw.jsonl"), pythonRaw, { flag: "wx", mode: 0o600 });
  const bytes = JSON.stringify(value) + "\n"; if (Buffer.byteLength(bytes) > pipeReceiptBound) throw new Error("Pipe receipt overflow");
  await writeFile(join(slot, "receipt.json"), bytes, { flag: "wx", mode: 0o600 });
  return { artifact: value.identity.attempt, receiptSha256: createHash("sha256").update(bytes).digest("hex"), capture: value.raw.capture, report: value.raw.report, stderr: value.raw.stderr, python: pythonRaw === undefined ? { state: "not measured" } : pipeBytes(pythonRaw) };
}
