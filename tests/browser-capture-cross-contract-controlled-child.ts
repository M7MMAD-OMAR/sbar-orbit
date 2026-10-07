import { expect, mock, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const owners = new Map<string, object>();
mock.module(fileURLToPath(import.meta.resolve('../src/chrome')), () => ({ launchChrome: async (profile: string) => {
  const owned = owners.get(profile); if (!owned) throw new Error('Unowned cross-contract fixture'); return owned;
} }));
const { BrowserBackend } = await import('../src/browser');
const { registerBrowserPhases, beginBrowserCapture } = await import('../src/browser-phase-observer');
const frame = Buffer.from(await Bun.file(new URL('./fixtures/controlled-frame-32x24.jpg', import.meta.url)).arrayBuffer()).toString('base64');
function deferred<T>() { let resolve = (_value: T) => {}; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(work: (value: Awaited<ReturnType<typeof ownedFixture>>) => Promise<void>) {
  const value = await ownedFixture(); const previous = process.env.ORBIT_CAPTURE_TIMEOUT_MS;
  process.env.ORBIT_CAPTURE_TIMEOUT_MS = '500';
  try { await work(value); }
  finally { if (previous === undefined) delete process.env.ORBIT_CAPTURE_TIMEOUT_MS; else process.env.ORBIT_CAPTURE_TIMEOUT_MS = previous; await value.dispose(); }
}
type StubContext = { pages(): StubPage[]; on(): void; setDefaultTimeout(): void; setDefaultNavigationTimeout(): void; newCDPSession(): Promise<unknown> };
type StubPage = { on(name: string, listener: (...args: unknown[]) => void): void; once(name: string, listener: (...args: unknown[]) => void): void; mainFrame(): object; isClosed(): boolean; url(): string; context(): StubContext; title(): Promise<string> };
async function ownedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-product-cross-'))); chmodSync(root, 0o700);
  const profile = join(root, 'profile-owned'); mkdirSync(profile, { mode: 0o700 });
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const mainFrame = {};
  let ready = false, titleCalls = 0, captureCalls = 0, detachCalls = 0;
  let title = () => Promise.resolve('captured original');
  let image = () => Promise.resolve({ data: frame });
  let attach = () => Promise.resolve(channel);
  const page: StubPage = { on(name: string, listener: (...args: unknown[]) => void) { const values = listeners.get(name) ?? []; values.push(listener); listeners.set(name, values); },
    once(name: string, listener: (...args: unknown[]) => void) { this.on(name, listener); },
    mainFrame: () => mainFrame, isClosed: () => false, url: () => 'http://fixture.invalid/original', context: () => context,
    title: () => { titleCalls++; return title(); } };
  const other = { ...page, url: () => 'http://fixture.invalid/other', title: async () => 'selected other' };
  const channel = { send(_name: string, _args: object): unknown { captureCalls++; return image(); }, async detach() { detachCalls++; } };
  const pointer = { on() {}, async send(name: string) { return name === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'pointer-fixture' } } } : {}; } };
  const pages = [page];
  const context: StubContext = { pages: () => pages, on() {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newCDPSession() { return ready ? attach() : Promise.resolve(pointer); } };
  const callbacks: (() => void)[] = [];
  const owned = { context, page, browser: {}, close: () => Promise.resolve(), onClose(listener: () => void) { callbacks.push(listener); } };
  owners.set(profile, owned);
  const backend = await BrowserBackend.create(profile); ready = true;
  const registration = registerBrowserPhases(backend, context, root, profile, () => {});
  expect(registration).toBeDefined();
  return { backend, context, page, other, pages, channel, owned, callbacks, registration,
    setImage(value: typeof image) { image = value; }, setTitle(value: typeof title) { title = value; }, setAttachment(value: typeof attach) { attach = value; },
    titleCalls: () => titleCalls, captureCalls: () => captureCalls, detachCalls: () => detachCalls,
    navigate() { for (const listener of listeners.get('framenavigated') ?? []) listener(mainFrame); },
    async dispose() { registration?.close(); owners.delete(profile); await backend.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); },
  };
}
async function turns() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

test('cross JPEG dimensions belong to captured pixels', () => fixture(async value => {
  const result = await value.backend.observe();
  expect({ contract: 'jpeg-geometry', width: result.width, height: result.height }).toEqual({ contract: 'jpeg-geometry', width: 32, height: 24 });
}));
test('cross metadata belongs to original page after selection', () => fixture(async value => {
  const held = deferred<{ data: string }>(); value.setImage(() => held.promise);
  const pending = value.backend.observe(); await turns();
  value.pages.push(value.other); Object.assign(value.backend, { active: value.other }); held.resolve({ data: frame });
  const result = await pending;
  expect({ contract: 'original-page-metadata', title: result.presence.title, pageIndex: result.presence.pageIndex }).toEqual({ contract: 'original-page-metadata', title: 'captured original', pageIndex: 1 });
}));
test('cross navigation promptly invalidates held JPEG and retains late phase', () => fixture(async value => {
  const held = deferred<{ data: string }>(); value.setImage(() => held.promise);
  let outcome = 'pending';
  const pending = value.backend.observe().then(() => { outcome = 'frame'; }, error => { outcome = error.code; });
  await turns(); value.navigate(); await turns();
  try { expect({ contract: 'document-invalidation', outcome }).toEqual({ contract: 'document-invalidation', outcome: 'BACKEND_FAILED' }); }
  finally { held.resolve({ data: frame }); await pending; await turns(); }
  expect(value.registration?.snapshot().pending).toBe(0); expect(value.detachCalls()).toBe(1);
}));
test('cross metadata deadline keeps one actual pending flight', () => fixture(async value => {
  const held = deferred<string>(); value.setTitle(() => held.promise);
  let outcome = 'pending';
  const first = value.backend.observe().then(() => { outcome = 'frame'; }, error => { outcome = error.code; });
  await new Promise(resolve => setTimeout(resolve, 700));
  try {
    expect({ contract: 'metadata-deadline', outcome }).toEqual({ contract: 'metadata-deadline', outcome: 'TIMEOUT' });
    const second = value.backend.observe(); await turns();
    try { expect(value.titleCalls()).toBe(1); expect(value.registration?.snapshot().pending).toBe(2); }
    finally { held.resolve('captured original'); await second; }
  } finally { held.resolve('captured original'); await first; await turns(); }
  expect(value.registration?.snapshot().pending).toBe(0);
}));
test('cross CDP thenable preserves receiver arguments and original await', () => fixture(async value => {
  let receiver: unknown, method: unknown, options: unknown, awaits = 0;
  value.channel.send = function(name, args) { receiver = this; method = name; options = args; return { then(resolve: (result: { data: string }) => void) { awaits++; resolve({ data: frame }); } }; };
  const result = await value.backend.observe();
  expect(receiver).toBe(value.channel); expect(method).toBe('Page.captureScreenshot');
  expect(options).toEqual({ format: 'jpeg', quality: 80, fromSurface: true, captureBeyondViewport: false });
  expect(awaits).toBe(1); expect(result.image).toBe(frame);
  expect(value.registration?.snapshot().rows.map(row => row.stage)).toEqual(['begin', 'attachment-before', 'attachment-settled', 'screenshot-before', 'screenshot-settled', 'presence-before', 'presence-settled', 'race-settled', 'cleanup']);
}));
test('cross CDP rejection preserves original error object', () => fixture(async value => {
  const original = new Error('Owned CDP rejection'); value.channel.send = () => Promise.reject(original);
  let caught: unknown; try { await value.backend.observe(); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(value.registration?.snapshot().pending).toBe(0);
  expect(value.registration?.snapshot().rows.some(row => row.stage === 'screenshot-rejected')).toBe(true);
}));
test('cross close request revokes admission before late screenshot settles', () => fixture(async value => {
  const screenshot = deferred<{ data: string }>(), closing = deferred<void>(); value.setImage(() => screenshot.promise); value.owned.close = () => closing.promise;
  const pending = value.backend.observe(); await turns(); const returned = value.backend.close();
  try {
  expect(returned).toBe(closing.promise); expect(registerBrowserPhases(value.backend, value.context, '', '', () => {})).toBeUndefined();
  expect(beginBrowserCapture(value.backend, value.context, value.page, 500, false)).toBeUndefined();
  expect(value.registration?.snapshot().pending).toBe(1);
  screenshot.resolve({ data: frame }); await pending;
  expect(value.registration?.snapshot().rows.find(row => row.stage === 'screenshot-settled')?.late).toBe(true); expect(value.registration?.snapshot().pending).toBe(0);
  } finally { screenshot.resolve({ data: frame }); closing.resolve(); await pending.catch(() => {}); await returned; }
}));
test('cross owned callback revokes admission before late metadata settles', () => fixture(async value => {
  const metadata = deferred<string>(); value.setTitle(() => metadata.promise);
  const pending = value.backend.observe(); await turns();
  try {
  for (const callback of value.callbacks) callback();
  expect(beginBrowserCapture(value.backend, value.context, value.page, 500, false)).toBeUndefined(); expect(value.registration?.snapshot().pending).toBe(1);
  metadata.resolve('captured original'); await pending;
  expect(value.registration?.snapshot().rows.find(row => row.stage === 'presence-settled')?.late).toBe(true); expect(value.registration?.snapshot().pending).toBe(0);
  } finally { metadata.resolve('captured original'); await pending.catch(() => {}); }
}));
test('cross obsolete late attachment detaches once without capturing', () => fixture(async value => {
  const attachment = deferred<typeof value.channel>(); value.setAttachment(() => attachment.promise);
  const pending = value.backend.observe().catch(error => error.code); await turns(); value.navigate(); await turns();
  attachment.resolve(value.channel); expect(await pending).toBe('BACKEND_FAILED'); await turns();
  expect(value.captureCalls()).toBe(0); expect(value.detachCalls()).toBe(1); expect(value.registration?.snapshot().pending).toBe(0);
}));
