import { test, expect } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startBroker, call } from '../src/ipc';
import { Sessions } from '../src/session';
import { BrowserBackend } from '../src/browser';
import { createWorkspaceDirectory } from '../src/workspace-storage';

test('private Orbit viewer prepares, downloads and links a report without publishing', async () => {
  const broker = await startBroker();
  const root = await createWorkspaceDirectory('diagnostics-viewer');
  const viewing = new Sessions(root);
  try {
    await call(broker.socket, 'session.stop', { sessionId: 'missing' }).catch(() => {});
    const preview = await call(broker.socket, 'preview.open') as { url: string };
    const session = await viewing.dispatch({ method: 'session.create', params: { backend: 'browser', agentName: 'Codex', taskName: 'Diagnostic report QA' } }) as { sessionId: string };
    // This is the page of this test's Orbit session, never a host browser.
    const backend = (viewing as unknown as { sessions: Map<string, { backend: BrowserBackend }> }).sessions.get(session.sessionId)?.backend;
    const page = backend?.context.pages()[0];
    if (!page) throw new Error('Private Orbit page unavailable');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const external: string[] = [];
    page.on('request', request => { if (!request.url().startsWith(new URL(preview.url).origin)) external.push(new URL(request.url()).origin); });
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.locator('#report-actions').waitFor({ state: 'visible' });
    expect(await page.locator('#report-status').getAttribute('data-errors')).toBe('1');
    const href = await page.locator('#report-github').getAttribute('href');
    expect(href).toStartWith('https://github.com/M7MMAD-OMAR/sbar-orbit/issues/new?');
    expect(href?.length ?? 99999).toBeLessThanOrEqual(7000);
    const downloaded = page.waitForEvent('download');
    await page.locator('#download-report').click();
    const download = await downloaded;
    const path = await download.path();
    expect(path).toBeTruthy();
    const report = await Bun.file(String(path)).json();
    expect(report.events.some((event: { outcome: string }) => event.outcome === 'error')).toBe(true);
    expect(report.issueUrl).toBeUndefined();
    await mkdir(join(import.meta.dir, '../output/playwright'), { recursive: true });
    await page.screenshot({ path: join(import.meta.dir, '../output/playwright/diagnostics-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(import.meta.dir, '../output/playwright/diagnostics-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally { await viewing.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
}, 45000);
