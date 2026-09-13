import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Sessions } from "../src/session";

test("failed tool calls have a diagnostic ID and a private ready report", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-diagnostic-test-"));
  const sessions = new Sessions(root);
  try {
    let failure: any;
    try { await sessions.dispatch({ method: "session.act", params: { sessionId: "secret-value", requestId: "private-request", action: { type: "fill", text: "password-123" } } }); }
    catch (error) { failure = error; }
    expect(failure.diagnosticId).toMatch(/^[a-f0-9-]{36}$/);
    const report: any = await sessions.dispatch({ method: "diagnostics.report" });
    expect(report.events.some((event: any) => event.traceId === failure.diagnosticId && event.outcome === "error")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(JSON.stringify(report)).not.toContain("private-request");
    expect(JSON.stringify(report)).not.toContain("password-123");
  } finally { await sessions.close(); await rm(root, { recursive: true, force: true }); }
});

import { Diagnostics } from '../src/diagnostics';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { OrbitError } from '../src/errors';
import { startBroker, call } from '../src/ipc';

test('diagnostics survive restart, rotate, and exclude exception secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-diagnostics-'));
  try {
    const diagnostics = new Diagnostics(root, 1400);
    for (let i = 0; i < 14; i++) {
      await diagnostics.run({ method: 'session.act', params: { sessionId: 'sensitive-id', requestId: 'retry-id', action: { type: 'fill', text: 'secret-input', url: 'https://secret.example/?token=secret' } } }, async () => { throw new Error('secret exception'); }).catch(() => {});
    }
    const report = await new Diagnostics(root, 1400).report();
    expect(report.events.length).toBeGreaterThan(0);
    expect(report.events.length).toBeLessThan(28);
    expect(report.collection.failedReads).toBe(0);
    expect(JSON.stringify(report)).not.toContain('secret');
    for (const name of ['events.jsonl', 'events.previous.jsonl']) {
      const info = await stat(join(root, name));
      expect(info.size).toBeLessThanOrEqual(1400);
      expect(info.mode & 0o777).toBe(0o600);
    }
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const issue = new URL(report.issueUrl);
    expect(issue.origin).toBe('https://github.com');
    expect(issue.pathname).toBe('/M7MMAD-OMAR/sbar-orbit/issues/new');
    expect(issue.searchParams.get('body')).toContain(report.reportId);
    expect(report.issueUrl.length).toBeLessThanOrEqual(7000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retry IDs correlate attempts without storing input, and unfinished operations remain visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-diagnostics-'));
  try {
    const diagnostics = new Diagnostics(root);
    let finish: (() => void) | undefined;
    const pending = diagnostics.run({ method: 'session.act', params: { requestId: 'same-request' } }, () => new Promise<void>(resolve => { finish = resolve; }));
    while (!finish) await Bun.sleep(5);
    const during = await new Diagnostics(root).report();
    expect(during.events.map(e => e.outcome)).toEqual(['started']);
    finish(); await pending;
    await diagnostics.run({ method: 'session.act', params: { requestId: 'same-request' } }, async () => ({}));
    const report = await diagnostics.report();
    expect(new Set(report.events.map(e => e.request)).size).toBe(1);
    expect(new Set(report.events.map(e => e.traceId)).size).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe log files fail visibly without breaking operations or changing their target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-diagnostics-'));
  try {
    const target = join(root, 'private');
    await writeFile(target, 'secret outside diagnostic log');
    await symlink(target, join(root, 'events.jsonl'));
    const diagnostics = new Diagnostics(root);
    expect(await diagnostics.run({ method: 'doctor' }, async () => 42)).toBe(42);
    const report = await diagnostics.report();
    expect(report.collection.failedWrites).toBe(2);
    expect(report.collection.failedReads).toBeGreaterThan(0);
    expect(report.events.length).toBe(2);
    expect(await readFile(target, 'utf8')).toBe('secret outside diagnostic log');
    expect(JSON.stringify(report)).not.toContain('secret');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IPC preserves diagnostic IDs and authenticated preview can prepare reports', async () => {
  const broker = await startBroker();
  try {
    let failure: unknown;
    try { await call(broker.socket, 'session.stop', { sessionId: 'missing' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OrbitError);
    expect((failure as OrbitError).diagnosticId).toBeDefined();
    const preview = await call(broker.socket, 'preview.open') as { url: string };
    const url = new URL(preview.url);
    const result = await fetch(`${url.origin}/rpc`, { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'diagnostics.report' }) });
    const envelope: any = await result.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.result.events.some((event: any) => event.traceId === (failure as OrbitError).diagnosticId)).toBe(true);
    const denied = await fetch(`${url.origin}/rpc`, { method: 'POST', body: JSON.stringify({ method: 'diagnostics.report' }) });
    expect(denied.status).toBe(403);
  } finally { await broker.close(); }
});
