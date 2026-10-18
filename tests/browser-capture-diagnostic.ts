import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserBackend } from '../src/browser';
import { registerBrowserPhases } from '../src/browser-phase-observer';
import type { startBroker } from '../src/ipc';
import { requireResourceBudget } from '../src/resource-budget';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const describe = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message, text: String(error) } : { text: String(error) };
const pendingSaves: (() => Promise<void>)[] = [];

/** Persistence has its own file hook, outside the original capture/focus test deadline. */
export async function flushTargetCaptureDiagnostics() {
  for (const save of pendingSaves.splice(0)) {
    try { await save(); }
    catch (error) { console.error(JSON.stringify({ productCaptureDiagnosticUnavailable: describe(error) })); }
  }
}

async function executableIdentity(selected: string) {
  const canonical = await realpath(selected);
  const beforePath = await stat(selected, { bigint: true });
  const file = await open(canonical, 'r');
  try {
    const before = await file.stat({ bigint: true });
    const tuple = (value: typeof before) => ({ dev: String(value.dev), ino: String(value.ino), size: String(value.size),
      mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) });
    if (!before.isFile() || before.size <= 0n || before.size > 512n * 1024n * 1024n ||
      beforePath.dev !== before.dev || beforePath.ino !== before.ino)
      throw new Error('Selected executable is not a bounded stable regular file');
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(canonical, { fd: file.fd, autoClose: false,
      signal: AbortSignal.timeout(10000) })) {
      bytes += chunk.length;
      if (bytes > Number(before.size)) throw new Error('Selected executable grew while hashing');
      digest.update(chunk);
    }
    const after = await file.stat({ bigint: true }), afterPath = await stat(selected, { bigint: true });
    const stable = JSON.stringify(tuple(before)) === JSON.stringify(tuple(after)) &&
      JSON.stringify(tuple(beforePath)) === JSON.stringify(tuple(afterPath)) &&
      await realpath(selected) === canonical && bytes === Number(before.size);
    return { selected, canonical, bytes, before: tuple(before), after: tuple(after), stable,
      sha256: stable ? digest.digest('hex') : null, collected: 'after fixture cleanup',
      limit: 'Executable bytes at launch are not measured; this hash binds the stable file read after cleanup' };
  } finally { await file.close(); }
}

/** Register only the fresh target capability. No protocol call or warmup runs here. */
export function targetCaptureDiagnostic(broker: Awaited<ReturnType<typeof startBroker>>, sessionId: string) {
  let registration: ReturnType<typeof registerBrowserPhases>;
  let runtime: { selectedExecutable: string; connectedVersion: string } | undefined;
  let unavailable: unknown;
  try {
    const owned = broker.sessions['get'](sessionId);
    if (!(owned.backend instanceof BrowserBackend)) throw new Error('Target is not an owned browser backend');
    const backend = owned.backend;
    registration = registerBrowserPhases(backend, backend.context, broker.sessions['root'], owned.profile, () => {});
    if (!registration) throw new Error('Target phase capability admission was refused');
    runtime = { selectedExecutable: backend['owned'].executable, connectedVersion: backend['owned'].browser.version() };
  } catch (error) { unavailable = describe(error); }
  const admission = { admitted: registration !== undefined, runtimeAvailable: runtime !== undefined, unavailable,
    ownership: 'Fresh broker target backend/context/workspace/profile; viewer and personal browser excluded',
    label: 'unlabelled', labelScope: 'Only the selected-regression target is registered',
    budgets: { captureDefaultMs: 3000, initialWaitDefaultMs: 5000, testMs: 30000 },
    limit: 'Phase admission and incomplete snapshots are diagnostic evidence, never a root cause or performance pass' };
  const save = async (directory: string, failure: unknown) => {
    const sourceNames = ['src/browser.ts', 'src/browser-presence.ts', 'src/browser-phase-observer.ts',
      'src/chrome.ts', 'src/runtime-paths.ts', 'src/session.ts', 'src/resource-budget.ts',
      'tests/product-ui.test.ts', 'tests/browser-capture-diagnostic.ts', 'tests/viewer-page.ts',
      'viewer/viewer.js', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/limited.ts'];
    const sourceRoot = new URL('../', import.meta.url);
    const files: { path: string; sha256: string; bytes: number }[] = [];
    let sourceError: unknown, executable: unknown, budget: unknown;
    try {
      for (const path of sourceNames) {
        const bytes = await readFile(new URL(path, sourceRoot));
        files.push({ path, sha256: hash(bytes), bytes: bytes.length });
      }
    } catch (error) { sourceError = describe(error); }
    try { if (runtime) executable = await executableIdentity(runtime.selectedExecutable); }
    catch (error) { executable = { complete: false, error: describe(error) }; }
    try { budget = { pid: process.pid, limits: await requireResourceBudget(), association: 'Same fixture process, checked after cleanup' }; }
    catch (error) { budget = { complete: false, error: describe(error) }; }
    const evidence = { schemaVersion: 1, name: 'selected-regression', failure, admission,
      capture: registration?.snapshot() ?? { complete: false, reason: 'Target phase admission unavailable' },
      runtime: { platform: process.platform, bunVersion: Bun.version, bunExecutable: process.execPath,
        selectedExecutable: runtime?.selectedExecutable,
        version: runtime ? { mechanism: 'Playwright cached handshake from this actual owned browser',
          rawResult: runtime.connectedVersion, rawUtf8Sha256: hash(Buffer.from(runtime.connectedVersion)),
          cliStdout: 'not measured', cliStderr: 'not measured', cliExit: 'not measured' }
          : { complete: false, reason: 'Connected target version unavailable' }, executable, budget },
      source: { files, complete: !sourceError && files.length === sourceNames.length, error: sourceError,
        sha256: hash(Buffer.from(JSON.stringify(files))), providerCommitAssertion: process.env.GITHUB_SHA ?? null,
        adapterSourcePin: process.env.ORBIT_CAPTURE_DIAGNOSTIC_SOURCE_SHA256 ?? null,
        limit: 'Actual listed file bytes after cleanup; complete source before/after binding belongs to the external adapter' },
      limit: 'First target capture phases only; root cause, CLI browser version and capture performance remain not measured' };
    const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'product-capture-selected-regression.json');
    await writeFile(path, bytes);
    console.log(JSON.stringify({ productCaptureDiagnostic: evidence, retained: { path, sha256: hash(bytes), bytes: bytes.length } }));
  };
  return {
    admission,
    close() { registration?.close(); },
    enqueueSave(directory: string, failure: unknown) { pendingSaves.push(() => save(directory, failure)); },
  };
}
