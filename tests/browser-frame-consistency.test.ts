import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBackend } from '../src/browser';
import type { Page } from 'playwright';

test('browser frame keeps its captured page and dimensions when tab actions finish concurrently', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orbit-frame-consistency-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<html><head><title>${path}</title><style>html,body{margin:0;width:100%;height:100%;background:${path === '/first' ? '#ff0000' : '#0000ff'}}</style></head><body>${path}</body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  let backend: BrowserBackend | undefined;
  let releaseCapture = () => {};
  try {
    backend = await BrowserBackend.create(profile, { width: 640, height: 480 });
    const origin = `http://127.0.0.1:${server.port}`;
    await backend.act({ type: 'navigate', url: `${origin}/first` });
    const firstPage = backend.context.pages()[0];
    if (!firstPage) throw new Error('Owned first page is missing');
    let captured = () => {};
    const capturedBytes = new Promise<void>(resolve => { captured = resolve; });
    const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
    const attach = backend.context.newCDPSession.bind(backend.context);
    let hold = true;
    backend.context.newCDPSession = async page => {
      const session = await attach(page);
      const send = session.send.bind(session);
      session.send = async (method, params) => {
        const result = await send(method, params);
        if (method === 'Page.captureScreenshot' && hold) {
          hold = false;
          // The screenshot is already real Chromium output. Only its delivery
          // is held while real tab and resize actions finish independently.
          captured();
          await captureGate;
        }
        return result;
      };
      return session;
    };
    const observing = backend.observe();
    await capturedBytes;
    await backend.act({ type: 'open-tab', url: `${origin}/second` });
    await backend.act({ type: 'resize', width: 800, height: 600 });
    releaseCapture();
    const frame = await observing;
    const decoded = await firstPage.evaluate(async image => {
      const bytes = Uint8Array.from(atob(image), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Owned decoder canvas unavailable');
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: canvas.width, height: canvas.height, pixel: [...context.getImageData(100, 100, 1, 1).data] };
    }, frame.image);
    const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'browser-frame.jpg'), Buffer.from(frame.image, 'base64'));
    const evidence = { decoded, width: frame.width, height: frame.height, presence: frame.presence, current: await backend.presence() };
    await writeFile(join(output, 'browser-frame-consistency.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browserFrameConsistency: evidence }));
    expect(decoded.pixel[0] ?? 0).toBeGreaterThan(240);
    expect(decoded.pixel[1] ?? 255).toBeLessThan(10);
    expect(decoded.pixel[2] ?? 255).toBeLessThan(10);
    expect(frame.presence.location).toBe(`${origin}/first`);
    expect(frame.presence.pageIndex).toBe(1);
    expect(frame.width).toBe(decoded.width);
    expect(frame.height).toBe(decoded.height);
    expect(evidence.current.location).toBe(`${origin}/second`);
    expect(backend.surface).toEqual({ width: 800, height: 600 });
  } finally {
    releaseCapture();
    try { await backend?.close(); await rm(profile, { recursive: true }); }
    finally { server.stop(true); }
  }
}, 30000);

for (const change of ['navigate', 'close'] as const) {
  test(`browser rejects an obsolete captured page after ${change}`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'orbit-frame-lifecycle-'));
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      const version = ++requests;
      return new Response(`<html><title>Version ${version}</title><style>html,body{margin:0;background:${version === 1 ? '#ff0000' : '#0000ff'}}</style></html>`, { headers: { 'content-type': 'text/html' } });
    } });
    let backend: BrowserBackend | undefined;
    let release = () => {};
    try {
      backend = await BrowserBackend.create(profile, { width: 640, height: 480 });
      const url = `http://127.0.0.1:${server.port}/same`;
      await backend.act({ type: 'navigate', url });
      const page = backend.context.pages()[0];
      if (!page) throw new Error('Owned captured page is missing');
      let captured = () => {};
      const bytesReady = new Promise<void>(resolve => { captured = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const attach = backend.context.newCDPSession.bind(backend.context);
      let hold = true;
      backend.context.newCDPSession = async target => {
        const channel = await attach(target);
        const send = channel.send.bind(channel);
        channel.send = async (method, params) => {
          const result = await send(method, params);
          if (method === 'Page.captureScreenshot' && hold) {
            hold = false; captured(); await gate;
          }
          return result;
        };
        return channel;
      };
      const observation = backend.observe().then(
        frame => ({ status: 'fulfilled', presence: frame.presence }),
        error => ({ status: 'rejected', code: error instanceof Error && 'code' in error ? error.code : undefined, error: String(error) }),
      );
      await bytesReady;
      if (change === 'navigate') {
        // The URL remains identical, so a URL comparison alone cannot detect
        // that the pixels came from the document before this real navigation.
        await backend.act({ type: 'navigate', url });
      } else {
        await backend.act({ type: 'open-tab', url: `${url}/survivor` });
        await backend.act({ type: 'close-tab', tab: 1 });
      }
      release();
      const outcome = await observation;
      const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
      await mkdir(output, { recursive: true });
      const evidence = { change, capturedPageClosed: page.isClosed(), current: await backend.presence(), outcome };
      await writeFile(join(output, `browser-frame-${change}.json`), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ browserFrameLifecycle: evidence }));
      expect(outcome).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
    } finally {
      release();
      try { await backend?.close(); await rm(profile, { recursive: true }); }
      finally { server.stop(true); }
    }
  }, 30000);
}

test('browser observation bounds real pending pointer metadata without accumulating reads', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orbit-frame-metadata-'));
  const previousBudget = process.env.ORBIT_CAPTURE_TIMEOUT_MS;
  const trace: Record<string, unknown>[] = [];
  const mark = (event: string, details = {}) => trace.push({ event, at: performance.now(), ...details });
  let requested = () => {}, release = () => {};
  const requestStarted = new Promise<void>(resolve => { requested = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/pending') { mark('response-pending'); requested(); await gate; }
    return new Response(`<html><title>${path}</title><body>${path}</body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  let backend: BrowserBackend | undefined;
  let navigating: Promise<unknown> | undefined;
  let titleCalls = 0, pointerCalls = 0;
  try {
    process.env.ORBIT_CAPTURE_TIMEOUT_MS = '500';
    backend = await BrowserBackend.create(profile);
    const origin = `http://127.0.0.1:${server.port}`;
    await backend.act({ type: 'navigate', url: `${origin}/first` });
    await backend.presence();
    const page = backend.context.pages()[0];
    if (!page) throw new Error('Owned page missing');
    const title = page.title.bind(page);
    page.title = async () => {
      titleCalls++; mark('title-enter');
      try { return await title(); } finally { mark('title-settled'); }
    };
    const pointers = (backend as unknown as { pointers: Map<Page, () => Promise<{ x: number; y: number } | null>> }).pointers;
    const pointer = pointers.get(page);
    if (!pointer) throw new Error('Owned pointer observer missing');
    pointers.set(page, async () => {
      pointerCalls++; mark('pointer-enter');
      // This invokes the installed observer's real CDP Runtime.evaluate.
      try { return await pointer(); } finally { mark('pointer-settled'); }
    });
    const attach = backend.context.newCDPSession.bind(backend.context);
    backend.context.newCDPSession = async target => {
      const channel = await attach(target);
      const send = channel.send.bind(channel);
      channel.send = async (method, params) => {
        const result = await send(method, params);
        if (method === 'Page.captureScreenshot' && 'data' in result && typeof result.data === 'string')
          mark('real-pixels', { bytes: result.data.length });
        return result;
      };
      return channel;
    };
    navigating = backend.act({ type: 'navigate', url: `${origin}/pending` }).then(() => mark('navigation-settled'));
    await requestStarted;
    const outcomes = [];
    for (let poll = 0; poll < 3; poll++) {
      const observing = backend.observe().then(
        () => ({ status: 'fulfilled' }),
        error => ({ status: 'rejected', code: error.code, error: String(error) }),
      );
      const boundary = await Promise.race([observing, Bun.sleep(750).then(() => ({ status: 'still-pending' }))]);
      outcomes.push(boundary); mark('poll-boundary', { poll, boundary, titleCalls, pointerCalls });
      if (boundary.status === 'still-pending') { release(); await observing; break; }
    }
    const pendingCalls = { titleCalls, pointerCalls };
    release(); await navigating;
    const recovered = await backend.observe();
    mark('recovered', { title: recovered.presence.title });
    const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
    await mkdir(output, { recursive: true });
    const evidence = { outcomes, pendingCalls, trace };
    await writeFile(join(output, 'browser-frame-metadata.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browserFrameMetadata: evidence }));
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'rejected', code: 'TIMEOUT' });
    expect(pendingCalls).toEqual({ titleCalls: 1, pointerCalls: 1 });
    expect(trace.filter(entry => entry.event === 'real-pixels').length).toBeGreaterThanOrEqual(3);
    expect(recovered.presence.title).toBe('/pending');
  } finally {
    release(); await navigating?.catch(() => {});
    if (previousBudget === undefined) delete process.env.ORBIT_CAPTURE_TIMEOUT_MS;
    else process.env.ORBIT_CAPTURE_TIMEOUT_MS = previousBudget;
    try { await backend?.close(); await rm(profile, { recursive: true }); }
    finally { server.stop(true); }
  }
}, 30000);
