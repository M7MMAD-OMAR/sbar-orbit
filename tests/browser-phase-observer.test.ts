import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The launcher module mock exists only in this owned Bun child, never the shared suite process. */
async function runControlledChild(env: NodeJS.ProcessEnv, route: "ordinary" | "owned-alias") {
  const path = fileURLToPath(new URL("./browser-phase-observer-controlled-child.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "test", path], { env, stdout: "pipe", stderr: "pipe", timeout: 35000 });
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 2097152) { child.kill(); throw new Error("owned child output exceeded bound"); } chunks.push(value.value); }
    return Buffer.concat(chunks).toString("utf8");
  }
  const [exit, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]);
  const raw = stdout + stderr;
  const summary = [...raw.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  const passed = [...raw.matchAll(/^\s*(\d+) pass\s*$/gm)];
  const failed = [...raw.matchAll(/^\s*(\d+) fail\s*$/gm)];
  const skipped = [...raw.matchAll(/^\s*(\d+) skip\s*$/gm)];
  const assertions = [...raw.matchAll(/^\s*(\d+) expect\(\) calls\s*$/gm)];
  console.error(JSON.stringify({ phaseFactoryChild: { route, exit, rawBytes: Buffer.byteLength(raw), rawSha256: createHash("sha256").update(raw).digest("hex"), total: summary.length === 1 ? Number(summary[0]?.[1]) : 0, passed: passed.length === 1 ? Number(passed[0]?.[1]) : null, failed: failed.length === 1 ? Number(failed[0]?.[1]) : null, skipped: skipped.length === 0 ? 0 : skipped.length === 1 ? Number(skipped[0]?.[1]) : null, assertions: assertions.length === 1 ? Number(assertions[0]?.[1]) : null, scope: "isolated in-memory launcher controls; no actual browser" } }));
  if (exit !== 0) throw new Error(raw.slice(0, 32768));
  expect(exit).toBe(0); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2097152); expect(summary.length).toBe(1); expect(Number(summary[0]?.[1])).toBe(32); expect(Number(summary[0]?.[2])).toBe(1);
  expect(passed.length).toBe(1); expect(Number(passed[0]?.[1])).toBe(32); expect(failed.length).toBe(1); expect(Number(failed[0]?.[1])).toBe(0); expect(skipped.length).toBe(0); expect(assertions.length).toBe(1);
}
test("phase factory controls stay in an isolated child", async () => { await runControlledChild(process.env, "ordinary"); }, 45000);
test("phase factory controls canonicalize an owned temporary ancestor alias", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-phase-alias-")));
  chmodSync(root, 0o700);
  try {
    const target = join(root, "temporary-owned"), alias = join(root, "temporary-alias");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(realpathSync(alias) === target).toBe(true);
    expect(realpathSync(alias) !== alias).toBe(true);
    console.error(JSON.stringify({ phaseFactoryOwnedAlias: { resolvesToOwnedTarget: realpathSync(alias) === target, lexicalInputDiffers: realpathSync(alias) !== alias } }));
    await runControlledChild({ ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }, "owned-alias");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45000);
