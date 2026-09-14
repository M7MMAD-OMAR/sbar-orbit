import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker, call } from '../src/ipc';
import { Sessions } from '../src/session';
import { BrowserBackend } from '../src/browser';
import { createWorkspaceDirectory } from '../src/workspace-storage';

/*
 * The settings are the desktop's, so this test gives the run its own XDG_CONFIG_HOME and
 * XDG_RUNTIME_DIR and never touches the person's real panel.json. The broker spawns the schema
 * program as a child, so the environment has to be set on this process rather than passed in.
 */
test('the viewer reads, writes and resets the desktop settings through the one schema', async () => {
  const config = await mkdtemp(join(tmpdir(), 'orbit-settings-config-'));
  const runtime = await mkdtemp(join(tmpdir(), 'orbit-settings-runtime-'));
  const previousConfig = process.env.XDG_CONFIG_HOME, previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_RUNTIME_DIR = runtime;
  // The mark publishes what the compositor tells it; a page cannot ask a compositor anything.
  await mkdir(join(runtime, 'sbar-orbit'), { recursive: true });
  await writeFile(join(runtime, 'sbar-orbit', 'monitors.json'), JSON.stringify([{ connector: 'DP-3', width: 3840, height: 2160 }]));
  const broker = await startBroker();
  const root = await createWorkspaceDirectory('viewer-settings-qa');
  const viewing = new Sessions(root);
  try {
    const listed = await call(broker.socket, 'settings.list') as { settings: { key: string; kind: string; value: unknown }[]; monitors: unknown[] };
    expect(listed.settings.find(entry => entry.key === 'blink')).toMatchObject({ kind: 'switch', value: true });
    expect(listed.monitors).toEqual([{ connector: 'DP-3', width: 3840, height: 2160 }]);
    // The schema refuses what it always refused, and the refusal reaches the caller as words.
    await expect(call(broker.socket, 'settings.write', { key: 'edge', value: 'sideways' })).rejects.toMatchObject({ code: 'SETTINGS_REFUSED' });
    await expect(call(broker.socket, 'settings.write', { key: 'invented', value: 'x' })).rejects.toMatchObject({ code: 'SETTINGS_REFUSED' });

    const preview = await call(broker.socket, 'preview.open') as { url: string };
    // The panel asks for this link when a person right clicks the mark.
    const settingsLink = await call(broker.socket, 'preview.open', { view: 'settings' }) as { url: string };
    expect(settingsLink.url).toContain('?view=settings#');
    const own = await viewing.dispatch({ method: 'session.create', params: { backend: 'browser', agentName: 'Codex', taskName: 'Viewer settings QA' } }) as { sessionId: string };
    const backend = (viewing as unknown as { sessions: Map<string, { backend: BrowserBackend }> }).sessions.get(own.sessionId)?.backend;
    const page = backend?.context.pages()[0];
    if (!page) throw new Error('Private Orbit page missing');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['ar-SY', 'ar'], configurable: true }));
    await page.goto(settingsLink.url, { waitUntil: 'domcontentloaded' });

    // The link lands on the settings, not on the pictures.
    await page.locator('#settings-view').waitFor({ state: 'visible' });
    expect(await page.locator('.stage-card').isVisible()).toBe(false);
    await page.locator('.settings-group').first().waitFor({ state: 'visible' });
    expect(await page.locator('.setting').count()).toBe(18);
    expect(await page.locator('#settings-view').textContent()).toContain('حافة الشاشة');
    // The names of the two views are the settings module's own words, so the page's language pass has
    // to run again after that module loads or one nav button stays in English.
    expect(await page.locator('#view-settings').textContent()).toBe('الإعدادات');
    // A switch that is on reads as on: the track inverts and the knob travels to the far end.
    expect(await page.locator('.toggle[aria-checked="true"]').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(240, 241, 243)');
    // Controls this page draws itself, rather than whatever the desktop makes of a checkbox.
    expect(await page.locator('.setting[data-kind="switch"] .toggle').first().isVisible()).toBe(true);
    expect(await page.locator('.setting[data-kind="choice"] .segment').first().isVisible()).toBe(true);
    expect(await page.locator('.setting[data-kind="monitor"] .picker-control option').nth(1).textContent()).toContain('DP-3');

    // A change goes through the schema and lands in the file the panel watches.
    const blink = page.locator('.setting[data-kind="switch"] .toggle').last();
    await blink.click();
    await page.waitForFunction(() => (document.querySelector('#settings-status')?.textContent ?? '').length > 0);
    await page.waitForFunction(() => document.querySelectorAll('.toggle[aria-checked="false"]').length > 0);
    const stored = JSON.parse(await readFile(join(config, 'sbar-orbit', 'panel.json'), 'utf8')) as Record<string, unknown>;
    expect(stored.blink).toBe(false);

    // The segmented choice writes the value the schema names, not the word a reader sees.
    await page.locator('.setting[data-kind="choice"]').first().locator('.segment').first().click();
    await page.waitForFunction(() => document.querySelector('.segment[aria-checked="true"]')?.textContent === 'يسار');
    expect(JSON.parse(await readFile(join(config, 'sbar-orbit', 'panel.json'), 'utf8')).edge).toBe('left');

    // Search answers an Arabic word that appears nowhere in the label it finds.
    await page.locator('#settings-search').fill('إشعارات');
    await page.waitForFunction(() => document.querySelectorAll('.setting').length === 2);
    await page.locator('#settings-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.setting').length === 18);

    // Everything back, which is the one destructive thing here, so it asks first.
    await page.locator('#settings-reset').click();
    expect(await page.locator('#settings-reset').getAttribute('data-confirm')).toBe('true');
    await page.locator('#settings-reset').click();
    await page.waitForFunction(() => document.querySelector('.segment[aria-checked="true"]')?.textContent === 'يمين');
    const back = JSON.parse(await readFile(join(config, 'sbar-orbit', 'panel.json'), 'utf8')) as Record<string, unknown>;
    expect(back.blink).toBe(true);
    expect(back.edge).toBe('right');

    // Nothing scrolls sideways: a settings row is a column of text and a control, and the control
    // shrinks before the row does.
    expect(await page.evaluate(() => {
      const work = document.querySelector('.work') as HTMLElement;
      return work.scrollWidth <= work.clientWidth + 1;
    })).toBe(true);
    const shots = process.env.ORBIT_QA_OUTPUT ?? '/tmp/orbit-viewer-settings';
    await page.evaluate(() => { (document.querySelector('.work') as HTMLElement).scrollTop = 0; });
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'settings.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, 'settings-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    // And the sessions are still one click away, from the same button.
    await page.locator('#view-settings').click();
    await page.locator('#settings-view').waitFor({ state: 'hidden' });
    expect(await page.locator('.stage-card').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await viewing.close(); await broker.close();
    await rm(root, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime;
  }
}, 60000);
