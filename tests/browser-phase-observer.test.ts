import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
/** The launcher module mock exists only in this owned Bun child, never the shared suite process. */
test("phase factory controls stay in an isolated child", async () => {
  const path = fileURLToPath(new URL("./browser-phase-observer-controlled-child.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "test", path], { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 35000 });
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 2097152) { child.kill(); throw new Error("owned child output exceeded bound"); } chunks.push(value.value); }
    return Buffer.concat(chunks).toString("utf8");
  }
  const [exit, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]);
  const raw = stdout + stderr;
  const summary = [...raw.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  console.error(JSON.stringify({ phaseFactoryChild: { exit, rawBytes: Buffer.byteLength(raw), rawSha256: createHash("sha256").update(raw).digest("hex"), total: summary.length === 1 ? Number(summary[0]?.[1]) : 0, scope: "isolated in-memory launcher controls; no actual browser" } }));
  if (exit !== 0) throw new Error(raw.slice(0, 32768));
  expect(exit).toBe(0); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2097152); expect(summary.length).toBe(1); expect(Number(summary[0]?.[1])).toBe(32);
}, 45000);
