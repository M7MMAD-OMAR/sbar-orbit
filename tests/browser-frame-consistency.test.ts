import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBackend, captureTimeoutMs } from '../src/browser';
import type { Page } from 'playwright';
import { fixturePhases } from './fixture-phases';

test('browser frame keeps its captured page and dimensions when tab actions finish concurrently', async () => {
  const trace = fixturePhases('first-frame-consistency');
  const profile = await trace.observe('profile-create', mkdtemp(join(tmpdir(), 'orbit-frame-consistency-')));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<html><head><title>${path}</title><style>html,body{margin:0;width:100%;height:100%;background:${path === '/first' ? '#ff0000' : '#0000ff'}}</style></head><body>${path}</body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  let backend: BrowserBackend | undefined;
  let releaseCapture = () => {};
  let restorePointer = () => {};
  try {
    backend = await trace.observe('backend-create', BrowserBackend.create(profile, { width: 640, height: 480 }));
    const origin = `http://127.0.0.1:${server.port}`;
    await trace.observe('initial-navigate', backend.act({ type: 'navigate', url: `${origin}/first` }));
    const firstPage = backend.context.pages()[0];
    if (!firstPage) throw new Error('Owned first page is missing');
    for (const method of ['capturedPresence', 'presenceOf', 'bindPointer'])
      trace.method(backend, method, `metadata.${method}`);
    trace.method(firstPage, 'title', 'metadata.captured-page-title');
    const pointers = backend['pointers'];
    const pointer = pointers.get(firstPage);
    if (pointer) {
      const wrapped: typeof pointer = function(this: unknown, ...args: Parameters<typeof pointer>) {
        return trace.observe('metadata.cached-pointer', pointer.apply(this, args));
      };
      pointers.set(firstPage, wrapped);
      restorePointer = () => { if (pointers.get(firstPage) === wrapped) pointers.set(firstPage, pointer); };
    } else trace.phase('metadata.cached-pointer', 'unavailable');
    let captured = () => {};
    const capturedBytes = new Promise<void>(resolve => { captured = resolve; });
    const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
    const attach = backend.context.newCDPSession.bind(backend.context);
    let hold = true;
    backend.context.newCDPSession = async page => {
      const session = await trace.observe('cdp-attach', attach(page));
      const send = session.send.bind(session);
      session.send = async (method, params) => {
        const operation = send(method, params);
        const result = await (method === 'Page.captureScreenshot' ? trace.observe('capture-send', operation) : operation);
        if (method === 'Page.captureScreenshot' && hold) {
          hold = false;
          trace.phase('real-raw-bytes-ready', 'done');
          // The screenshot is already real Chromium output. Only its delivery
          // is held while real tab and resize actions finish independently.
          captured();
          await trace.observe('held-capture-delivery', captureGate);
        }
        return result;
      };
      return session;
    };
    const observing = backend.observe();
    trace.observe('observation', observing);
    await trace.observe('captured-bytes-gate', capturedBytes);
    await trace.observe('open-tab', backend.act({ type: 'open-tab', url: `${origin}/second` }));
    await trace.observe('resize', backend.act({ type: 'resize', width: 800, height: 600 }));
    trace.phase('release-capture', 'start');
    releaseCapture();
    trace.phase('release-capture', 'done');
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
    trace.phase('finally-release-capture', 'start');
    releaseCapture();
    trace.phase('finally-release-capture', 'done');
    try {
      trace.phase('backend-close', 'start');
      await backend?.close();
      trace.phase('backend-close', 'done');
      await trace.observe('profile-remove', rm(profile, { recursive: true }));
    } finally {
      server.stop(true); trace.phase('server-stop', 'done');
      try { restorePointer(); } catch {}
      trace.finish();
    }
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
    const started = performance.now();
    const trace: Record<string, unknown>[] = [];
    let capturedPage: Page | undefined;
    const mark = (phase: string, details: Record<string, unknown> = {}) => {
      if (trace.length < 32) trace.push({ elapsedMs: Math.round(performance.now() - started), phase,
        documentVersion: capturedPage ? backend?.['documentVersions'].get(capturedPage) : undefined, ...details });
    };
    const committed = (frame: import('playwright').Frame) => {
      if (frame === capturedPage?.mainFrame()) mark('main-frame-committed');
    };
    try {
      backend = await BrowserBackend.create(profile, { width: 640, height: 480 });
      const url = `http://127.0.0.1:${server.port}/same`;
      await backend.act({ type: 'navigate', url });
      const page = backend.context.pages()[0];
      if (!page) throw new Error('Owned captured page is missing');
      capturedPage = page;
      page.on('framenavigated', committed);
      let captured = () => {};
      const bytesReady = new Promise<void>(resolve => { captured = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const attach = backend.context.newCDPSession.bind(backend.context);
      let hold = true;
      backend.context.newCDPSession = async target => {
        const channel = await attach(target);
        const send = channel.send.bind(channel);
        channel.send = async (method, params) => {
          if (method === 'Page.captureScreenshot') mark('capture-send-start');
          const result = await send(method, params);
          if (method === 'Page.captureScreenshot' && hold) {
            mark('capture-raw-bytes-ready');
            hold = false; captured(); await gate;
            mark('capture-delivery-released');
          }
          return result;
        };
        return channel;
      };
      mark('observation-start');
      const observation = backend.observe().then(
        frame => { mark('observation-fulfilled'); return { status: 'fulfilled', presence: frame.presence }; },
        error => {
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          mark(code === 'TIMEOUT' ? 'original-timeout-observed' : 'observation-rejected', { code });
          return { status: 'rejected', code, error: String(error) };
        },
      );
      await bytesReady;
      if (change === 'navigate') {
        // The URL remains identical, so a URL comparison alone cannot detect
        // that the pixels came from the document before this real navigation.
        mark('navigation-start');
        try { await backend.act({ type: 'navigate', url }); mark('navigation-settled'); }
        catch (error) {
          mark('navigation-rejected', { code: error instanceof Error && 'code' in error ? error.code : undefined });
          throw error;
        }
      } else {
        await backend.act({ type: 'open-tab', url: `${url}/survivor` });
        await backend.act({ type: 'close-tab', tab: 1 });
      }
      mark('capture-gate-release');
      release();
      const outcome = await observation;
      const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
      await mkdir(output, { recursive: true });
      const evidence = { change, capturedPageClosed: page.isClosed(), current: await backend.presence(), outcome, trace };
      await writeFile(join(output, `browser-frame-${change}.json`), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ browserFrameLifecycle: evidence }));
      expect(outcome).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
    } finally {
      mark('finally-gate-release');
      release();
      capturedPage?.off('framenavigated', committed);
      try { await backend?.close(); await rm(profile, { recursive: true }); }
      finally {
        server.stop(true);
        const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
        await mkdir(output, { recursive: true }).then(() => writeFile(join(output, `browser-frame-${change}-phases.json`), JSON.stringify({ change, trace }, null, 2))).catch(() => {});
        try { console.log(JSON.stringify({ browserFramePhases: { change, trace } })); } catch {}
      }
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
    expect(backend['observationInvalidations'].size).toBe(0);
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

for (const change of ['navigate', 'close'] as const) {
  test(`browser promptly rejects known obsolete held pixels after ${change}`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'orbit-prompt-obsolete-'));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><title>Owned prompt fixture</title><style>body{background:#ff0000}</style></html>', { headers: { 'content-type': 'text/html' } }) });
    const started = performance.now();
    const budget = captureTimeoutMs();
    const trace: Record<string, unknown>[] = [];
    const mark = (phase: string, details: Record<string, unknown> = {}) => { if (trace.length < 24) trace.push({ elapsedMs: Math.round(performance.now() - started), phase, ...details }); };
    let backend: BrowserBackend | undefined;
    let page: Page | undefined;
    let release = () => {};
    let observing: Promise<void> | undefined;
    let promptOutcome: { status: string; code?: unknown } | undefined;
    const readOutcome = (): { status: string; code?: unknown } | undefined => promptOutcome;
    let atAssertion: Record<string, unknown> | undefined;
    let deliveryReleased = false;
    const committed = (frame: import('playwright').Frame) => { if (frame === page?.mainFrame()) mark('main-frame-committed', { documentVersion: page ? backend?.['documentVersions'].get(page) : undefined }); };
    try {
      backend = await BrowserBackend.create(profile, { width: 640, height: 480 });
      const url = `http://127.0.0.1:${server.port}/same`;
      await backend.act({ type: 'navigate', url });
      if (change === 'close') { await backend.act({ type: 'open-tab', url: `${url}/survivor` }); await backend.act({ type: 'select-tab', tab: 1 }); }
      page = backend.context.pages()[0];
      if (!page) throw new Error('Owned captured page missing');
      page.on('framenavigated', committed);
      const originalVersion = backend['documentVersions'].get(page);
      let bytesReady = () => {};
      const captured = new Promise<void>(resolve => { bytesReady = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const attach = backend.context.newCDPSession.bind(backend.context);
      let rawByteCount = 0, jpegSignatureValid = false, hold = true;
      backend.context.newCDPSession = async target => {
        const channel = await attach(target);
        const send = channel.send.bind(channel);
        channel.send = async (method, params) => {
          const result = await send(method, params);
          if (method === 'Page.captureScreenshot' && hold) {
            hold = false;
            if ('data' in result && typeof result.data === 'string') {
              const bytes = Buffer.from(result.data, 'base64'); rawByteCount = bytes.length;
              jpegSignatureValid = bytes[0] === 0xff && bytes[1] === 0xd8;
            }
            mark('real-jpeg-ready', { rawByteCount, jpegSignatureValid }); bytesReady();
            await gate; deliveryReleased = true; mark('held-delivery-released');
          }
          return result;
        };
        return channel;
      };
      const observedAt = performance.now();
      mark('observation-start', { originalVersion, budget });
      observing = backend.observe().then(
        () => { promptOutcome = { status: 'fulfilled' }; mark('observation-fulfilled'); },
        error => { promptOutcome = { status: 'rejected', code: error instanceof Error && 'code' in error ? error.code : undefined }; mark('observation-rejected', promptOutcome); },
      );
      await captured;
      expect(jpegSignatureValid).toBe(true);
      if (change === 'navigate') await backend.act({ type: 'navigate', url });
      else await backend.act({ type: 'close-tab', tab: 1 });
      const currentVersion = backend['documentVersions'].get(page);
      const knownObsolete = page.isClosed() || currentVersion !== originalVersion;
      mark('actual-change-complete', { knownObsolete, currentVersion, closed: page.isClosed() });
      await Bun.sleep(0);
      const observationElapsedMs = performance.now() - observedAt;
      if (!knownObsolete || observationElapsedMs >= budget || readOutcome()?.code === 'TIMEOUT') {
        mark('inconclusive-boundary', { knownObsolete, observationElapsedMs, budget });
        throw new Error('Prompt obsolete control inconclusive before the original capture deadline');
      }
      atAssertion = { knownObsolete, observationElapsedMs, budget, rawByteCount, jpegSignatureValid, deliveryReleased, outcome: readOutcome() ?? { status: 'pending' } };
      mark('prompt-boundary', atAssertion);
      expect(deliveryReleased).toBe(false);
      expect(promptOutcome).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
      expect(backend['observationInvalidations'].size).toBe(0);
    } finally {
      release();
      await observing;
      page?.off('framenavigated', committed);
      try { await backend?.close(); await rm(profile, { recursive: true }); }
      finally {
        server.stop(true);
        const evidence = { change, atAssertion, trace };
        const output = process.env.ORBIT_QA_OUTPUT ?? join(tmpdir(), 'orbit-frame-consistency');
        await mkdir(output, { recursive: true }).then(() => writeFile(join(output, `browser-prompt-obsolete-${change}.json`), JSON.stringify(evidence, null, 2))).catch(() => {});
        try { console.log(JSON.stringify({ browserPromptObsolete: evidence })); } catch {}
      }
    }
  }, 30000);
}

test('browser obsolete metadata stays single-flight until real settlement and then recovers', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orbit-obsolete-metadata-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(`<html><title>${new URL(request.url).pathname}</title><body>Owned metadata fixture</body></html>`, { headers: { 'content-type': 'text/html' } }) });
  let backend: BrowserBackend | undefined;
  let release = () => {};
  let observing: Promise<unknown> | undefined;
  let calls = 0;
  const trace: Record<string, unknown>[] = [];
  const started = performance.now();
  const mark = (phase: string, details = {}) => { if (trace.length < 24) trace.push({ phase, elapsedMs: Math.round(performance.now() - started), ...details }); };
  try {
    backend = await BrowserBackend.create(profile);
    const origin = `http://127.0.0.1:${server.port}`;
    await backend.act({ type: 'navigate', url: `${origin}/first` });
    await backend.presence();
    const page = backend.context.pages()[0];
    if (!page) throw new Error('Owned metadata page missing');
    const pointer = backend['pointers'].get(page);
    if (!pointer) throw new Error('Owned pointer observer missing');
    let ready = () => {};
    const metadataReady = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    backend['pointers'].set(page, async () => {
      calls++;
      const value = await pointer();
      if (hold) { hold = false; mark('real-pointer-result-held', { calls }); ready(); await gate; }
      return value;
    });
    observing = backend.observe().then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', code: error.code }));
    await metadataReady;
    const oldFlight = backend['metadataFlights'].get(page);
    if (!oldFlight) throw new Error('Actual held metadata flight missing');
    await backend.act({ type: 'navigate', url: `${origin}/second` });
    expect(await observing).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
    expect(backend['observationInvalidations'].size).toBe(0);
    expect(backend['metadataFlights'].get(page)).toBe(oldFlight);
    expect(backend['documentVersions'].get(page)).not.toBe(oldFlight.documentVersion);
    for (let poll = 0; poll < 2; poll++) {
      const outcome = await backend.observe().then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', code: error.code }));
      mark('new-generation-boundary', { poll, outcome, calls });
      expect(outcome).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
      expect(backend['metadataFlights'].get(page)).toBe(oldFlight);
      expect(calls).toBe(1);
      expect(backend['observationInvalidations'].size).toBe(0);
    }
    release(); await oldFlight.promise;
    await Bun.sleep(0);
    expect(backend['metadataFlights'].size).toBe(0);
    const recovered = await backend.observe();
    mark('recovered', { calls, title: recovered.presence.title });
    expect(recovered.presence.title).toBe('/second');
    expect(calls).toBe(2);
    expect(backend['metadataFlights'].size).toBe(0);
    expect(backend['observationInvalidations'].size).toBe(0);
  } finally {
    release(); await observing;
    try { await backend?.close(); await rm(profile, { recursive: true }); }
    finally { server.stop(true); try { console.log(JSON.stringify({ obsoleteMetadataFlight: trace })); } catch {} }
  }
}, 30000);

test('browser obsolete late attachment releases its own channel without capturing or clearing a fresh one', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orbit-obsolete-attachment-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><title>Owned attachment fixture</title></html>', { headers: { 'content-type': 'text/html' } }) });
  let backend: BrowserBackend | undefined;
  let release = () => {};
  let observing: Promise<unknown> | undefined;
  let oldCaptures = 0, detached = 0;
  try {
    backend = await BrowserBackend.create(profile);
    const url = `http://127.0.0.1:${server.port}/same`;
    await backend.act({ type: 'navigate', url });
    const page = backend.context.pages()[0];
    if (!page) throw new Error('Owned attachment page missing');
    let attached = () => {}, detachDone = () => {};
    const oldAttached = new Promise<void>(resolve => { attached = resolve; });
    const oldDetached = new Promise<void>(resolve => { detachDone = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const attach = backend.context.newCDPSession.bind(backend.context);
    let hold = true;
    backend.context.newCDPSession = async target => {
      const channel = await attach(target);
      if (hold) {
        hold = false;
        const send = channel.send.bind(channel), detach = channel.detach.bind(channel);
        channel.send = async (method, params) => { if (method === 'Page.captureScreenshot') oldCaptures++; return send(method, params); };
        channel.detach = async () => { try { await detach(); detached++; } finally { detachDone(); } };
        attached(); await gate;
      }
      return channel;
    };
    observing = backend.observe().then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', code: error.code }));
    await oldAttached;
    await backend.act({ type: 'navigate', url });
    expect(await observing).toMatchObject({ status: 'rejected', code: 'BACKEND_FAILED' });
    expect(backend['observationInvalidations'].size).toBe(0);
    const freshFrame = await backend.observe();
    const freshAttachment = backend['captureSessions'].get(page);
    if (!freshAttachment) throw new Error('Actual fresh capture attachment missing');
    release(); await oldDetached;
    expect(detached).toBe(1);
    expect(oldCaptures).toBe(0);
    expect(backend['captureSessions'].get(page)).toBe(freshAttachment);
    expect(freshAttachment.released).toBe(false);
    expect(freshFrame.presence.title).toBe('Owned attachment fixture');
    expect(backend['observationInvalidations'].size).toBe(0);
    try { console.log(JSON.stringify({ obsoleteLateAttachment: { detached, oldCaptures, freshAttachmentRetained: true } })); } catch {}
  } finally {
    release(); await observing;
    try { await backend?.close(); await rm(profile, { recursive: true }); }
    finally { server.stop(true); }
  }
}, 30000);
