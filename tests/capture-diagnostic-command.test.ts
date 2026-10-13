import { expect, test } from "bun:test";
import { diagnosticCommand } from "../experiments/capture-diagnostic-command";

test("diagnostic command retains actual exit and separate stdout and stderr", async () => {
  const result = await diagnosticCommand([process.execPath, "-e",
    'process.stdout.write("owned stdout"); process.stderr.write("owned stderr"); process.exitCode = 7;'],
  { timeoutMs: 10000, graceMs: 1000 });
  expect(result).toMatchObject({ stdout: "owned stdout", stderr: "owned stderr", exitCode: 7,
    timedOut: false, directExitConfirmed: true, outputComplete: true,
    collectionErrors: [], signalErrors: [] });
});

test("diagnostic deadline escalates a TERM-resistant exact child and retains failed outcome", async () => {
  const started = performance.now();
  const result = await diagnosticCommand([process.execPath, "-e",
    'process.on("SIGTERM", () => {}); process.stdout.write("owned ready"); setInterval(() => {}, 1000);'],
  { timeoutMs: 500, graceMs: 500 });
  expect(result.stdout).toContain("owned ready");
  expect(result.timedOut).toBe(true);
  expect(result.directExitConfirmed).toBe(true);
  expect(result.exitCode).not.toBe(0);
  expect(performance.now() - started).toBeLessThan(5000);
});

test("diagnostic output bound rejects overflowing bytes and reaps its exact child", async () => {
  const result = await diagnosticCommand([process.execPath, "-e",
    'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);'],
  { timeoutMs: 10000, maxOutputBytes: 1024, graceMs: 500 });
  expect(Buffer.byteLength(result.stdout)).toBe(1024);
  expect(result.collectionErrors).toContain("stdout bound exceeded");
  expect(result.outputComplete).toBe(false);
  expect(result.directExitConfirmed).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

test("diagnostic command rejects invalid bounds before child creation", async () => {
  await expect(diagnosticCommand([process.execPath, "-e", 'throw new Error("must not launch")'],
    { timeoutMs: 0 })).rejects.toThrow("Invalid diagnostic command bound");
});
