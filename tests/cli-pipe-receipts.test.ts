import { expect, test } from "bun:test";
import { admitPipeAttempt, admitPipeAttempts, pipeBytes, retainPipeAttempt, type PipeAttemptReceipt } from "./cli-pipe-receipts";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
function valid(): PipeAttemptReceipt { return { identity: { schema: 1, attempt: "11111111-1111-4111-8111-111111111111", verb: "observe", startedMs: 0 }, budgets: { communicateSeconds: 6, supervisorMs: 8000, testMs: 15000, rpcMs: 45000, delaySeconds: 0.05 }, supervisor: [{ sequence: 1, stage: "spawn-returned", clock: "bun-performance-ms", elapsedMs: 0, awaitedExit: null, exitCodeSnapshot: null }, { sequence: 2, stage: "streams-exit-settled", clock: "bun-performance-ms", elapsedMs: 8000, awaitedExit: 143, exitCodeSnapshot: null }, { sequence: 3, stage: "finally-exit-settled", clock: "bun-performance-ms", elapsedMs: 8001, awaitedExit: 143, exitCodeSnapshot: null }], python: { clock: "python-perf-counter-ns", raw: pipeBytes(new TextEncoder().encode("{broken\n")) }, raw: { capture: "complete", report: pipeBytes(new Uint8Array()), stderr: pipeBytes(new Uint8Array()) }, actualChildPid: 1, deadlineObserved: "not measured", cleanup: "not measured" }; }
test("settled exit preserves null snapshot as unknown", () => { const receipt = valid(); expect(admitPipeAttempt(receipt)).toBe(true); expect(receipt.supervisor.at(-1)?.awaitedExit).toBe(143); expect(receipt.supervisor.at(-1)?.exitCodeSnapshot).toBeNull(); expect(receipt.cleanup).toBe("not measured"); });
test("duplicate attempt receipts are refused", () => { const receipt = valid(); expect(admitPipeAttempts([receipt])).toBe(true); expect(admitPipeAttempts([receipt, receipt])).toBe(false); });
test("missing terminal supervisor evidence is refused", () => { const receipt = valid(); receipt.supervisor.pop(); expect(admitPipeAttempt(receipt)).toBe(false); });
test("reversed sequence and clocks are refused", () => { const receipt = valid(); const last = receipt.supervisor.at(-1); if (!last) throw new Error("Missing controlled row"); last.sequence = 1; expect(admitPipeAttempt(receipt)).toBe(false); last.sequence = 3; last.elapsedMs = 1; expect(admitPipeAttempt(receipt)).toBe(false); });
test("altered original deadline is refused", () => { const receipt = valid(); Object.assign(receipt.budgets, { supervisorMs: 16000 }); expect(admitPipeAttempt(receipt)).toBe(false); });
test("raw malformed sidecar is retained before fixture removal", async () => { const root = await mkdtemp(join(tmpdir(), "orbit-pipe-receipt-control-")); const fixture = join(root, "removable"), directory = join(root, "receipts"); const receipt = valid(); try { await mkdir(fixture); const result = await retainPipeAttempt(directory, fixture, receipt, new Uint8Array(), new Uint8Array(), new TextEncoder().encode("{broken\n")); await rm(fixture, { recursive: true, force: true }); expect(await readFile(join(directory, result.artifact, "python.raw.jsonl"), "utf8")).toBe("{broken\n"); expect(JSON.parse(await readFile(join(directory, result.artifact, "receipt.json"), "utf8")).supervisor[2].exitCodeSnapshot).toBeNull(); } finally { await rm(root, { recursive: true, force: true }); } });

test("invalid UTF8 drained bytes remain unchanged in retained artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-pipe-invalid-utf8-")), fixture = join(root, "fixture"), directory = join(root, "receipts");
  const original = new Uint8Array([0xff, 0xc3, 0x28, 0xe2, 0x82]);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(original.slice(0, 2)); controller.enqueue(original.slice(2)); controller.close(); } });
  const captured = new Uint8Array(await new Response(stream).arrayBuffer());
  const receipt = valid(); receipt.raw.report = pipeBytes(captured); receipt.python.raw = undefined;
  try { await mkdir(fixture); const result = await retainPipeAttempt(directory, fixture, receipt, captured, new Uint8Array());
    expect(await readFile(join(directory, result.artifact, "report.raw"))).toEqual(Buffer.from(original));
    expect(result.report).toEqual(pipeBytes(original));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("ancestor alias into removable fixture refuses receipt admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-pipe-alias-")), fixture = join(root, "fixture"), alias = join(root, "alias");
  const directory = join(alias, "receipts"), receipt = valid(); receipt.python.raw = undefined;
  try { await mkdir(fixture); await symlink(fixture, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(retainPipeAttempt(directory, fixture, receipt, new Uint8Array(), new Uint8Array())).rejects.toThrow("resolves inside removable fixture");
    await expect(readFile(join(fixture, "receipts", receipt.identity.attempt, "receipt.json"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
