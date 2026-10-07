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

// This control isolates scheduling from host speed. Screenshot delivery stays
// held until metadata admission has been inspected; no warmup or retry occurs.
test('captured metadata can progress while original screenshot delivery is held', () => fixture(async value => {
  const held = deferred<{ data: string }>();
  value.setImage(() => held.promise);
  const original = value.backend.observe();
  // Attach the rejection handler immediately, retaining the original result.
  const outcome = original.then(frame => ({ frame }), error => ({ error }));
  let atBarrier: { titleCalls: number; capturedPage: boolean; screenshotCalls: number };
  try {
    await turns();
    atBarrier = { titleCalls: value.titleCalls(), capturedPage: value.pages[0] === value.page,
      screenshotCalls: value.captureCalls() };
    value.pages.push(value.other); Object.assign(value.backend, { active: value.other });
  } finally { held.resolve({ data: frame }); }
  const result = await outcome;
  console.log(JSON.stringify({ metadataOverlapBarrier: atBarrier, injectedScreenshotDelivery: 'held',
    budgetMs: 500, wallClockPerformance: 'not measured' }));
  if ('error' in result) throw result.error;
  expect(result.frame.image).toBe(frame);
  expect(result.frame.presence.title).toBe('captured original');
  expect(result.frame.presence.location).toBe('http://fixture.invalid/original');
  expect(result.frame.presence.pageCount).toBe(2);
  expect(result.frame.presence.pageIndex).toBe(1);
  expect(result.frame.presence.tabs).toHaveLength(2);
  expect(value.registration?.snapshot().rows.find(row => row.stage === 'presence-before')?.pending).toBe('screenshot+presence');
  expect(atBarrier).toEqual({ titleCalls: 1, capturedPage: true, screenshotCalls: 1 });
}));

test('pixel rejection preserves error while concurrent metadata remains pending', () => fixture(async value => {
  const title = deferred<string>(); value.setTitle(() => title.promise);
  const original = new Error('Owned pixel rejection during pending metadata');
  value.channel.send = () => Promise.reject(original);
  let caught: unknown;
  try {
    await value.backend.observe().catch(error => { caught = error; });
    await turns();
    expect(caught).toBe(original);
    expect(value.titleCalls()).toBe(1);
    expect(value.registration?.snapshot().pending).toBe(1);
    expect(value.registration?.snapshot().rows.find(row => row.stage === 'screenshot-rejected')?.pending).toBe('presence');
  } finally { title.resolve('captured original'); await turns(); }
  expect(value.registration?.snapshot().pending).toBe(0);
}));
