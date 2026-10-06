import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openViewerPage } from './viewer-page';
import { startBroker, call } from '../src/ipc';

async function settleViewerViewport(page: Awaited<ReturnType<typeof openViewerPage>>['page'], viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  // Let the media query and ResizeObserver apply before inspecting active motion.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => {
    const shell = document.querySelector('.shell'), rail = document.querySelector('.rail');
    if (!shell || !rail || shell.classList.contains('sidebar-collapsed') !== (innerWidth <= 900)) return false;
    const style = getComputedStyle(rail), collapsed = shell.classList.contains('sidebar-collapsed');
    if (style.visibility !== (collapsed ? 'hidden' : 'visible') || Number(style.opacity) !== (collapsed ? 0 : 1)) return false;
    // Activity indicators loop forever. All finite layout motion must finish.
    return shell.getAnimations({ subtree: true }).every(animation =>
      animation.effect?.getComputedTiming().iterations === Infinity || animation.playState === 'finished' || animation.playState === 'idle');
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// The broker schema contract is disposable here. The real Python round trip stays in
// viewer-settings.test.ts. No compositor, owner's settings or managed service is used.
const initial = [
  { key: 'blink', kind: 'switch', value: true, label: 'Blink', description: 'Show activity', arabic: { label: 'وميض', description: 'اعرض النشاط', group: 'المظهر' } },
  { key: 'edge', kind: 'choice', value: 'left', choices: ['left', 'right'], label: 'Screen edge', description: 'Choose an edge', arabic: { label: 'حافة الشاشة' } },
  { key: 'accent', kind: 'accent_color', value: '#255fce', choices: ['auto'], default: '#255fce', label: 'Accent', description: 'Choose a color', arabic: { label: 'لون التمييز' } },
  { key: 'colors', kind: 'colors', value: { idle: '#255fce', working: '#ffffff' }, label: 'State colors', description: 'Colors by state', arabic: { label: 'ألوان الحالة' } },
  { key: 'browser', kind: 'browser', value: '', label: 'Browser', description: 'Viewer browser', arabic: { label: 'المتصفح' } },
  { key: 'monitor', kind: 'monitor', value: '', label: 'Monitor', description: 'Panel screen', arabic: { label: 'الشاشة' } },
  { key: 'size', kind: 'number', value: 20, range: [10, 40], label: 'Size', description: 'Mark size', arabic: { label: 'الحجم' } },
].map(entry => ({ group: 'Appearance', ...entry }));

async function settingsFixture(language: string, failLoad = false) {
  const viewer = await openViewerPage('Private product settings fixture', { language, viewport: { width: 1440, height: 1000 } });
  let settings = structuredClone(initial), writes = 0, refuse = false, lists = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/rpc') {
      const { method, params } = await request.json() as { method: string; params: { key: string; value: unknown; all?: boolean } };
      if (method === 'settings.list' && ++lists === 1 && failLoad) return Response.json({ ok: false, error: { message: 'Fixture connection unavailable' } });
      if (method === 'settings.write') {
        writes++;
        if (refuse) return Response.json({ ok: false, error: { message: 'Fixture refused this value' } });
        if (params.all) settings = structuredClone(initial);
        else { const entry = settings.find(entry => entry.key === params.key); if (entry) Object.assign(entry, { value: params.value }); }
      }
      return Response.json({ ok: true, result: method === 'session.list' ? [] : { settings, browsers: [{ id: 'chrome', name: 'Chrome', appWindow: true }], monitors: [{ connector: 'DP-1', width: 1920, height: 1080 }] } });
    }
    if (path === '/theme.css' || path === '/favicon.svg') return new Response('');
    const file = Bun.file(join(import.meta.dir, '../viewer', path === '/' ? 'index.html' : path.slice(1)));
    return await file.exists() ? new Response(file) : new Response('', { status: 404 });
  } });
  await viewer.page.goto(`http://127.0.0.1:${server.port}/?view=settings#fixture`, { waitUntil: 'domcontentloaded' });
  await viewer.page.locator('#settings-view').waitFor();
  if (!failLoad) await viewer.page.locator('.setting').first().waitFor();
  return { ...viewer, writes: () => writes, refuse: () => { refuse = true; }, close: async () => { await viewer.close(); server.stop(true); } };
}

for (const language of ['en', 'ar']) {
  test(`session lifecycle and page selection preserve controls in ${language}`, async () => {
    const broker = await startBroker();
    const viewer = await openViewerPage('Private lifecycle fixture', { language, viewport: { width: 1440, height: 1000 } });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<html><head><title>Product input fixture</title><style>body{margin:0;background:#f5f6f8;font:24px system-ui;color:#192842}h1{padding:40px}input{position:absolute;left:80px;top:160px;width:400px;height:48px;font:24px system-ui}button{position:absolute;left:500px;top:160px;height:48px}output{position:absolute;left:80px;top:260px}</style></head><body><h1>Private product fixture</h1><form onsubmit="event.preventDefault();document.querySelector('output').textContent=document.querySelector('input').value"><input aria-label="Message"><button>Save</button></form><output>Waiting</output></body></html>`, { headers: { 'content-type': 'text/html' } }) });
    const shots = process.env.ORBIT_QA_OUTPUT ?? '/tmp/orbit-product-ui';
    const evidence: Record<string, unknown> = { language };
    try {
      await mkdir(shots, { recursive: true });
      const preview = await call(broker.socket, 'preview.open') as { url: string };
      const { page } = viewer;
      const capture = async (state: string) => {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
          await settleViewerViewport(page, viewport);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: join(shots, `session-${language}-${viewport.width}-${state}.png`), fullPage: true });
        }
      };
      await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
      await page.locator('#empty').waitFor();
      await capture('empty');
      const session = await call(broker.socket, 'session.create', { backend: 'browser', agentName: 'Codex', taskName: 'Private product task', conversationName: 'Fixture conversation', projectName: 'Disposable project' }) as { sessionId: string };
      await call(broker.socket, 'session.act', { ...session, requestId: 'navigate', action: { type: 'navigate', url: `http://127.0.0.1:${server.port}` } });
      await call(broker.socket, 'session.act', { ...session, requestId: 'tab', action: { type: 'open-tab', url: `http://127.0.0.1:${server.port}/second` } });
      await page.locator('#frame').waitFor();
      await capture('running');
      await page.route('**/rpc', async route => {
        if (route.request().postDataJSON()?.method === 'session.pause') await new Promise(resolve => setTimeout(resolve, 350));
        await route.continue();
      });
      await page.locator('#pause').focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('#pause').isDisabled()).toBe(true);
      await page.waitForFunction(() => document.querySelector('#state')?.getAttribute('data-state') === 'paused');
      expect(await page.locator('#resume').evaluate(node => node === document.activeElement)).toBe(true);
      await page.unroute('**/rpc');
      await expect(call(broker.socket, 'session.act', { ...session, requestId: 'refused', action: { type: 'read', selector: 'output' } })).rejects.toMatchObject({ code: 'PAUSED' });
      const first = page.locator('#tabs button').first();
      await first.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#tabs button')?.getAttribute('aria-current') === 'page');
      expect(await first.evaluate(node => node === document.activeElement)).toBe(true);
      if (language === 'ar') expect(await page.locator('#page-location').textContent()).not.toMatch(/tab|of/);
      await capture('takeover');
      const box = await page.locator('#frame').boundingBox();
      if (!box) throw new Error('Private viewer frame missing');
      await page.locator('#frame').click({ position: { x: box.width * 100 / 1280, y: box.height * 180 / 800 } });
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')?.disabled);
      const message = language === 'ar' ? 'اختبار التحكم الخاص' : 'Private takeover verified';
      await page.locator('#text').fill(message);
      await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')?.disabled);
      await page.locator('#press').click();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#press')?.disabled);
      await page.locator('#resume').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#state')?.getAttribute('data-state') === 'running');
      expect(await page.locator('#pause').evaluate(node => node === document.activeElement)).toBe(true);
      evidence.readback = await call(broker.socket, 'session.act', { ...session, requestId: 'readback', action: { type: 'read', selector: 'output' } });
      expect(evidence.readback).toEqual({ text: message });
      let failed = false;
      await page.route('**/rpc', async route => {
        if (!failed && route.request().postDataJSON()?.method === 'session.observe') {
          failed = true; await route.fulfill({ json: { ok: false, error: { code: 'CAPTURE_TIMEOUT', message: 'Disposable capture unavailable' } } });
        } else await route.continue();
      });
      await page.locator('#error').waitFor();
      await capture('capture-error');
      await page.locator('#error').waitFor({ state: 'hidden' });
      await page.unroute('**/rpc');
      await page.goto('about:blank');
      evidence.afterViewerClose = await call(broker.socket, 'session.act', { ...session, requestId: 'viewer-closed', action: { type: 'read', selector: 'output' } });
      expect(evidence.afterViewerClose).toEqual({ text: message });
      await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
      await page.locator('#frame').waitFor();
      // The saved failure prepares a report and opens the tools sheet on reload.
      await page.locator('#report-actions').waitFor();
      expect(await page.locator('#tools').evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
      const toolsSummary = page.locator('#tools summary').first();
      await toolsSummary.focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('#tools').evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
      expect(await page.locator('#stop').isVisible()).toBe(false);
      await page.keyboard.press('Enter');
      expect(await page.locator('#tools').evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
      expect(await page.locator('#stop').isVisible()).toBe(true);
      await page.locator('#stop').click();
      await page.waitForFunction(() => document.querySelector('#state')?.getAttribute('data-state') === 'closed');
      await capture('finished');
      evidence.pausedAgentRefusal = 'PAUSED'; evidence.captureRecovered = failed; evidence.closed = true;
      expect(viewer.errors).toEqual([]);
      await writeFile(join(shots, `session-${language}.json`), JSON.stringify(evidence, null, 2));
    } finally { await viewer.close(); await broker.close(); server.stop(true); }
  }, 45000);

  test(`settings retry an unavailable connection in ${language}`, async () => {
    const fixture = await settingsFixture(language, true);
    try {
      const { page } = fixture;
      const retry = page.getByRole('button', { name: language === 'ar' ? 'حاول مرة أخرى' : 'Try again' });
      await retry.waitFor();
      expect(await page.locator('#settings-groups').textContent()).toContain('Fixture connection unavailable');
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.locator('.setting').first().waitFor();
      expect(await page.locator('#settings-view').getAttribute('aria-busy')).toBe('false');
    } finally { await fixture.close(); }
  }, 30000);

  test(`public onboarding renders and keyboard navigation works in ${language}`, async () => {
    const viewer = await openViewerPage('Private public onboarding fixture', { language, viewport: { width: 1440, height: 1000 } });
    const directory = join(import.meta.dir, '../website/dist');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(directory, path.endsWith('/') ? `${path}index.html` : path));
      return await file.exists() ? new Response(file) : new Response('', { status: 404 });
    } });
    const shots = process.env.ORBIT_QA_OUTPUT ?? '/tmp/orbit-product-ui';
    const evidence: unknown[] = [];
    try {
      await mkdir(shots, { recursive: true });
      const { page } = viewer;
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.goto(`http://127.0.0.1:${server.port}/${language === 'ar' ? 'ar/' : ''}`, { waitUntil: 'networkidle' });
        expect(await page.locator('html').getAttribute('dir')).toBe(language === 'ar' ? 'rtl' : 'ltr');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await page.locator('.skip-link').evaluate(node => node === document.activeElement)).toBe(true);
        if (viewport.width === 390) {
          await page.locator('.menu-toggle').focus();
          await page.keyboard.press('Enter');
          expect(await page.locator('.menu-toggle').getAttribute('aria-expanded')).toBe('true');
          await page.keyboard.press('Tab');
          await page.keyboard.press('Escape');
          expect(await page.locator('.menu-toggle').getAttribute('aria-expanded')).toBe('false');
          expect(await page.locator('.menu-toggle').evaluate(node => node === document.activeElement)).toBe(true);
        }
        for (const section of ['top', 'guide', 'get-started']) {
          await page.locator(`#${section}`).scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(shots, `onboarding-${language}-${viewport.width}-${section}.png`), fullPage: section === 'top' });
        }
        // A baseline fixture predates the platform choice. The separate source contract
        // detects that absence; current renders must prove both commands after repair.
        if (await page.locator('.install-platform').count()) {
          await page.locator('.install-platform button').nth(1).click();
          expect(await page.locator('.installation pre').textContent()).toContain('install.cmd');
          expect(await page.locator('.installation pre').textContent()).not.toContain('./install.sh');
          await page.locator('.install-platform button').first().click();
          expect(await page.locator('.installation pre').textContent()).toContain('./install.sh');
        }
        await page.locator('.copy-button').click();
        await page.waitForFunction(() => (document.querySelector('.copy-status')?.textContent || '').length > 0);
        evidence.push({ language, viewport, copy: await page.locator('.copy-status').textContent(), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
      }
      expect(viewer.errors).toEqual([]);
      await writeFile(join(shots, `onboarding-${language}.json`), JSON.stringify(evidence, null, 2));
    } finally { await viewer.close(); server.stop(true); }
  }, 45000);

  test(`settings names and descriptions are usable in ${language}`, async () => {
    const fixture = await settingsFixture(language);
    try {
      const { page } = fixture;
      const shots = process.env.ORBIT_QA_OUTPUT ?? '/tmp/orbit-product-ui';
      await mkdir(shots, { recursive: true });
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await settleViewerViewport(page, viewport);
        await page.screenshot({ path: join(shots, `settings-${language}-${viewport.width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      const unlabeled = await page.locator('.setting button, .setting input, .setting select, .setting [role="radiogroup"]').evaluateAll(nodes => nodes.filter(node => {
        const label = node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        return !label && !node.textContent?.trim();
      }).map(node => node.outerHTML));
      expect(unlabeled).toEqual([]);
      const toggle = page.getByRole('switch', { name: language === 'ar' ? 'وميض' : 'Blink' });
      expect(await toggle.count()).toBe(1);
      expect(await toggle.getAttribute('aria-describedby')).toBeTruthy();
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.close(); }
  }, 30000);

  test(`settings keep keyboard focus after save and refusal in ${language}`, async () => {
    const fixture = await settingsFixture(language);
    try {
      const { page } = fixture;
      const toggle = page.locator('.toggle').first();
      await toggle.focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.toggle')?.getAttribute('aria-checked') === 'false');
      await page.waitForFunction(() => (document.querySelector('#settings-status')?.textContent || '').length > 0);
      expect(await toggle.evaluate(node => node === document.activeElement)).toBe(true);
      fixture.refuse();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('#settings-status')?.getAttribute('data-error') === 'true');
      expect(await toggle.evaluate(node => node === document.activeElement)).toBe(true);
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      expect(fixture.writes()).toBe(2);
    } finally { await fixture.close(); }
  }, 30000);

  test(`settings choices support arrow keys in ${language}`, async () => {
    const fixture = await settingsFixture(language);
    try {
      const { page } = fixture;
      const group = page.locator('.setting[data-kind="choice"] [role="radiogroup"]');
      await group.locator('[aria-checked="true"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => (document.querySelector('#settings-status')?.textContent || '').length > 0, undefined, { timeout: 2000 });
      expect(await group.locator('[aria-checked="true"]').textContent()).toBe(language === 'ar' ? 'يمين' : 'right');
      expect(await group.locator('[aria-checked="true"]').evaluate(node => node === document.activeElement)).toBe(true);
      expect(await group.locator('[tabindex="0"]').count()).toBe(1);
    } finally { await fixture.close(); }
  }, 30000);
}
