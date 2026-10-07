import { test, expect } from 'bun:test';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import ts from '@typescript/typescript6';
import { openViewerPage } from './viewer-page';
import { OwnedFixtureScope } from './owned-fixture';
import { OwnedCleanupError, retryableCleanup } from '../src/owned-cleanup';

/** Execute a complete authentic function body with explicit, audited bindings. */
async function authenticFunction<T>(filename: string, name: string, bindings: Record<string, unknown>): Promise<T> {
  const directory = process.env.ORBIT_FIXTURE_SOURCE_DIRECTORY ?? import.meta.dir;
  const source = await readFile(join(directory, filename), 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const definition = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!definition) throw new Error(`Authentic function ${name} missing from ${filename}`);
  const original = source.slice(definition.getStart(ast), definition.getEnd());
  const bound = original.replace(/^export /, '').replaceAll('import.meta.dir', 'fixtureDirectory');
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(bound);
  console.error(JSON.stringify({ fixtureControlSource: filename, name,
    sha256: createHash('sha256').update(original).digest('hex'),
    bindingNames: Object.keys(bindings), directory, astPackage: '@typescript/typescript6', astVersion: ts.version,
    transformations: ['remove export modifier', 'bind import.meta.dir', 'strip TypeScript types'] }));
  return new Function(...Object.keys(bindings), `${javascript}\nreturn ${name};`)(...Object.values(bindings)) as T;
}

test('authentic settings acquisition closes its actual private viewer and local server on navigation rejection', async () => {
  const primary = new Error('Controlled navigation rejection after owned acquisition');
  let viewer: Awaited<ReturnType<typeof openViewerPage>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let viewerCloses = 0;
  let serverStops = 0;
  const acquire = async (...args: Parameters<typeof openViewerPage>) => {
    viewer = await openViewerPage(...args);
    const owned = viewer;
    return { ...owned, page: new Proxy(owned.page, { get(target, key) {
      if (key === 'goto') return async () => { throw primary; };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }), close: async () => { viewerCloses++; await owned.close(); } };
  };
  const runtime = new Proxy(Bun, { get(target, key) {
    if (key === 'serve') return (options: Parameters<typeof Bun.serve>[0]) => {
      server = Bun.serve(options);
      const owned = server;
      return new Proxy(owned, { get(value, property) {
        if (property === 'stop') return (force: boolean) => { serverStops++; return owned.stop(force); };
        const result = Reflect.get(value, property, value);
        return typeof result === 'function' ? result.bind(value) : result;
      } });
    };
    return Reflect.get(target, key, target);
  } });
  const fixture = await authenticFunction<(language: string, failLoad: boolean) => Promise<unknown>>(
    'product-ui.test.ts', 'settingsFixture', { openViewerPage: acquire, Bun: runtime, join, initial: [],
      fixtureDirectory: import.meta.dir, OwnedFixtureScope });
  let rejection: unknown;
  try {
    try { await fixture('ar', true); } catch (error) { rejection = error; }
    if (!viewer || !server) throw new Error('Control did not acquire its real private viewer and server');
    let reachable = false;
    try { reachable = (await fetch(`http://127.0.0.1:${server.port}/theme.css`)).ok; } catch {}
    console.error(JSON.stringify({ fixtureCleanupWitness: { viewerCloses, serverStops,
      privatePageClosed: viewer.page.isClosed(), localServerReachable: reachable,
      primaryPreserved: rejection === primary }, scope: 'Deterministic navigation rejection, initial Windows timing cause not measured' }));
    expect(rejection).toBe(primary);
    expect(viewerCloses).toBe(1);
    expect(serverStops).toBe(1);
    expect(viewer.page.isClosed()).toBe(true);
    expect(reachable).toBe(false);
  } finally {
    // Independently clean the negative control's intentionally exposed old resources.
    try { await viewer?.close(); } finally { await server?.stop(true); }
  }
}, 45000);

test('fixture cleanup retains primary identity, releases every owner and retries only failed closers', async () => {
  const scope = new OwnedFixtureScope();
  const primary = new Error('primary');
  const cleanup = new Error('cleanup');
  let successfulCalls = 0, failingCalls = 0;
  scope.defer(() => { successfulCalls++; });
  scope.defer(() => { if (++failingCalls === 1) throw cleanup; });
  let rejection: unknown;
  try { await scope.run(async () => { throw primary; }); } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(OwnedCleanupError);
  if (!(rejection instanceof OwnedCleanupError)) throw new Error('Missing retry owner');
  expect(rejection.errors).toEqual([primary, cleanup]);
  expect(rejection.errors[0]).toBe(primary);
  expect(successfulCalls).toBe(1);
  await rejection.retry();
  await rejection.retry();
  expect({ successfulCalls, failingCalls }).toEqual({ successfulCalls: 1, failingCalls: 2 });
});

test('authentic viewer setup retains owned root until Sessions.close acknowledges success and preserves primary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-viewer-cleanup-control-'));
  const primary = new Error('session.create failed');
  const cleanup = new Error('session cleanup unconfirmed');
  let closeCalls = 0, removeCalls = 0;
  class ControlledSessions {
    async dispatch() { throw primary; }
    async close() { if (++closeCalls === 1) throw cleanup; }
  }
  const acquire = await authenticFunction<(name: string) => Promise<unknown>>('viewer-page.ts', 'openViewerPage', {
    createWorkspaceDirectory: async () => root, Sessions: ControlledSessions,
    rm: async (...args: Parameters<typeof rm>) => { removeCalls++; return rm(...args); },
    OwnedCleanupError, retryableCleanup,
  });
  try {
    let rejection: unknown;
    try { await acquire('Controlled owned cleanup'); } catch (error) { rejection = error; }
    const retained = await access(root).then(() => true, () => false);
    console.error(JSON.stringify({ viewerSetupCleanupWitness: { closeCalls, removeCalls, rootRetained: retained,
      primaryFirst: rejection instanceof OwnedCleanupError && rejection.errors[0] === primary } }));
    expect(retained).toBe(true);
    expect(removeCalls).toBe(0);
    expect(rejection).toBeInstanceOf(OwnedCleanupError);
    if (!(rejection instanceof OwnedCleanupError)) throw new Error('Missing setup retry owner');
    expect(rejection.errors[0]).toBe(primary);
    expect(rejection.errors[1]).toBe(cleanup);
    await rejection.retry();
    await rejection.retry();
    expect({ closeCalls, removeCalls }).toEqual({ closeCalls: 2, removeCalls: 1 });
    expect(await access(root).then(() => true, () => false)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('successful fixture body retains a failed cleanup owner for explicit retry', async () => {
  const scope = new OwnedFixtureScope();
  const cleanup = new Error('cleanup after body success');
  let calls = 0;
  scope.defer(() => { if (++calls === 1) throw cleanup; });
  let rejection: unknown;
  try { await scope.run(async () => 'completed'); } catch (error) { rejection = error; }
  if (!(rejection instanceof OwnedCleanupError)) throw new Error('Missing successful-body cleanup retry owner');
  expect(rejection.errors).toEqual([undefined, cleanup]);
  await rejection.retry();
  await rejection.retry();
  expect(calls).toBe(2);
});

test('authentic settings acquisition releases its actual private viewer when local server creation throws', async () => {
  const primary = new Error('Controlled local server creation failure');
  let viewer: Awaited<ReturnType<typeof openViewerPage>> | undefined;
  let closeCalls = 0;
  const acquire = async (...args: Parameters<typeof openViewerPage>) => {
    viewer = await openViewerPage(...args);
    const owned = viewer;
    return { ...owned, close: async () => { closeCalls++; await owned.close(); } };
  };
  const runtime = new Proxy(Bun, { get(target, key) {
    if (key === 'serve') return () => { throw primary; };
    return Reflect.get(target, key, target);
  } });
  const fixture = await authenticFunction<(language: string) => Promise<unknown>>('product-ui.test.ts', 'settingsFixture', {
    openViewerPage: acquire, Bun: runtime, join, initial: [], fixtureDirectory: import.meta.dir, OwnedFixtureScope,
  });
  try {
    let rejection: unknown;
    try { await fixture('ar'); } catch (error) { rejection = error; }
    if (!viewer) throw new Error('Control did not acquire its actual private viewer');
    console.error(JSON.stringify({ serverCreationCleanupWitness: { closeCalls, pageClosed: viewer.page.isClosed(), primaryPreserved: rejection === primary } }));
    expect(rejection).toBe(primary);
    expect(closeCalls).toBe(1);
    expect(viewer.page.isClosed()).toBe(true);
  } finally { await viewer?.close(); }
}, 45000);

test('authentic viewer root removal retry does not repeat acknowledged Sessions cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-viewer-root-control-'));
  const primary = new Error('session setup failure');
  const cleanup = new Error('root removal failure');
  let closeCalls = 0, removeCalls = 0;
  class ControlledSessions {
    async dispatch() { throw primary; }
    async close() { closeCalls++; }
  }
  const acquire = await authenticFunction<(name: string) => Promise<unknown>>('viewer-page.ts', 'openViewerPage', {
    createWorkspaceDirectory: async () => root, Sessions: ControlledSessions,
    rm: async (...args: Parameters<typeof rm>) => { if (++removeCalls === 1) throw cleanup; return rm(...args); },
    OwnedCleanupError, retryableCleanup,
  });
  try {
    let rejection: unknown;
    try { await acquire('Controlled owned root removal'); } catch (error) { rejection = error; }
    expect(await access(root).then(() => true, () => false)).toBe(true);
    if (!(rejection instanceof OwnedCleanupError)) throw new Error('Missing root removal retry owner');
    expect(rejection.errors[0]).toBe(primary);
    expect(rejection.errors[1]).toBe(cleanup);
    await rejection.retry();
    await rejection.retry();
    expect({ closeCalls, removeCalls }).toEqual({ closeCalls: 1, removeCalls: 2 });
    expect(await access(root).then(() => true, () => false)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
