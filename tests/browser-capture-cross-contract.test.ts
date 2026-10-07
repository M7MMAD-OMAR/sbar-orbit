import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The process-local launcher mock belongs only to this owned child.
test('cross capture controls stay in an isolated child', async () => {
  const path = fileURLToPath(new URL('./browser-capture-cross-contract-controlled-child.ts', import.meta.url));
  const child = Bun.spawn([process.execPath, 'test', path], { env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 35000 });
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const value = await reader.read(); if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > 2097152) { child.kill(); throw new Error('owned cross child output exceeded bound'); }
      chunks.push(value.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const [exit, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]);
  const raw = stdout + stderr;
  const summary = [...raw.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  const passed = [...raw.matchAll(/^\s*(\d+) pass\s*$/gm)], failed = [...raw.matchAll(/^\s*(\d+) fail\s*$/gm)], skipped = [...raw.matchAll(/^\s*(\d+) skip\s*$/gm)];
  const assertions = [...raw.matchAll(/^\s*(\d+) expect\(\) calls\s*$/gm)];
  const cases = [...raw.matchAll(/^\(pass\) (cross .+?) \[[^\n]+\]$/gm)].map(value => value[1]);
  const receipt = { exit, rawBytes: Buffer.byteLength(raw), rawSha256: createHash('sha256').update(raw).digest('hex'), total: summary.length === 1 ? Number(summary[0]?.[1]) : null,
    passed: passed.length === 1 ? Number(passed[0]?.[1]) : null, failed: failed.length === 1 ? Number(failed[0]?.[1]) : null,
    skipped: skipped.length === 0 ? 0 : skipped.length === 1 ? Number(skipped[0]?.[1]) : null, assertions: assertions.length === 1 ? Number(assertions[0]?.[1]) : null, cases,
    scope: 'isolated child synthetic CDP controls; parent real browser control is separate' };
  console.error(JSON.stringify({ crossContractChild: receipt }));
  if (process.env.ORBIT_QA_OUTPUT) {
    await mkdir(process.env.ORBIT_QA_OUTPUT, { recursive: true });
    await writeFile(join(process.env.ORBIT_QA_OUTPUT, 'cross-child.raw.log'), raw);
    await writeFile(join(process.env.ORBIT_QA_OUTPUT, 'cross-child.receipt.json'), JSON.stringify(receipt, null, 2));
  }
  if (exit !== 0) throw new Error(raw.slice(0, 32768));
  expect(exit).toBe(0); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2097152);
  expect(summary.length).toBe(1); expect(Number(summary[0]?.[1])).toBe(9); expect(Number(summary[0]?.[2])).toBe(1);
  expect(passed.length).toBe(1); expect(Number(passed[0]?.[1])).toBe(9);
  expect(failed.length).toBe(1); expect(Number(failed[0]?.[1])).toBe(0); expect(skipped.length).toBe(0);
  expect(assertions.length).toBe(1); expect(receipt.assertions).toBeGreaterThan(0); expect(cases.length).toBe(9);
}, 45000);

// A real owned browser in the parent proves the child did not replace its launcher.
test('cross child leaves real browser capture available in the shared suite', async () => {
  const { BrowserBackend } = await import('../src/browser');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cross-parent-'))); chmodSync(root, 0o700);
  const profile = join(root, 'profile-owned'); mkdirSync(profile, { mode: 0o700 });
  let backend: Awaited<ReturnType<typeof BrowserBackend.create>> | undefined;
  try {
    backend = await BrowserBackend.create(profile, { width: 320, height: 240 });
    const result = await backend.observe();
    expect({ contract: 'parent-real-capture', width: result.width, height: result.height, pages: result.presence.pageCount }).toEqual({ contract: 'parent-real-capture', width: 320, height: 240, pages: 1 });
    expect(result.image.length).toBeGreaterThan(0);
    console.error(JSON.stringify({ crossParentRealCapture: { width: result.width, height: result.height, pages: result.presence.pageCount, imageBytes: Buffer.from(result.image, 'base64').byteLength, ownedTemporaryProfile: true } }));
  } finally { try { await backend?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
}, 45000);
