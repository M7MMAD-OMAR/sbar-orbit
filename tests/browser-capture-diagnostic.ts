import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserBackend } from '../src/browser';
import { registerBrowserPhases } from '../src/browser-phase-observer';
import type { startBroker } from '../src/ipc';
import { requireResourceBudget } from '../src/resource-budget';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pendingSaves: (() => Promise<void>)[] = [];
const ownField = Object.hasOwn;
const codes = ['TIMEOUT', 'BACKEND_FAILED', 'BACKEND_ERROR', 'SESSION_NOT_FOUND', 'RESOURCE_LIMIT_REQUIRED', 'ENOENT', 'EACCES'];

/** Error metadata is fixed vocabulary. Arbitrary messages, paths and getters never enter evidence. */
export function captureDiagnosticError(error: unknown) {
  let name = 'other', code = 'other';
  try {
    if (error instanceof Error) name = 'Error';
    const nameDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'name') : undefined;
    const candidateName = nameDescriptor && ownField(nameDescriptor, 'value') ? nameDescriptor.value : undefined;
    if (typeof candidateName === 'string' && ['Error', 'TimeoutError', 'AggregateError', 'OwnedCleanupError'].includes(candidateName)) name = candidateName;
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const candidateCode = descriptor && ownField(descriptor, 'value') ? descriptor.value : undefined;
    if (typeof candidateCode === 'string' && codes.includes(candidateCode)) code = candidateCode;
  } catch {}
  return { name, code, message: 'redacted' };
}

/** Persistence runs in a file hook, outside the original capture/focus test deadline. */
export async function flushTargetCaptureDiagnostics() {
  for (const save of pendingSaves.splice(0)) {
    try { await save(); }
    catch (error) { console.error(JSON.stringify({ productCaptureDiagnosticUnavailable: captureDiagnosticError(error) })); }
  }
}

type ReadOptions = { timeoutMs?: number; afterAdmission?: () => Promise<void>; afterClose?: () => void };
const sourceLimit = 1024 * 1024;
const executableLimit = 512 * 1024 * 1024;

/** Fixture hook permits deterministic post-admission growth without replacing real file reads. */
export function boundedRegularFileIdentity(selected: string, limit: number, options: ReadOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > executableLimit ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new Error('Invalid diagnostic read bound');
  let timedOut = false;
  const expires = performance.now() + timeoutMs;
  const check = () => { if (timedOut || performance.now() >= expires) throw new Error('Diagnostic file operation timed out'); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error('Diagnostic file operation timed out')); }, timeoutMs);
  });
  const work = (async () => {
    check();
    const canonical = await realpath(selected);
    check();
    const beforePath = await stat(selected, { bigint: true });
    check();
    const canonicalBefore = await lstat(canonical, { bigint: true });
    check();
    // A racing FIFO replacement cannot block open on platforms supporting O_NONBLOCK.
    if (!beforePath.isFile() || !canonicalBefore.isFile() || beforePath.size > BigInt(limit) ||
      beforePath.dev !== canonicalBefore.dev || beforePath.ino !== canonicalBefore.ino)
      throw new Error('Diagnostic input is not a bounded regular file');
    const file = await open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      check();
      const before = await file.stat({ bigint: true });
      check();
      const tuple = (value: typeof before) => ({ dev: String(value.dev), ino: String(value.ino), size: String(value.size),
        mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) });
      if (!before.isFile() || before.size > BigInt(limit) || before.dev !== canonicalBefore.dev ||
        before.ino !== canonicalBefore.ino || JSON.stringify(tuple(before)) !== JSON.stringify(tuple(beforePath)))
        throw new Error('Diagnostic handle admission failed');
      await options.afterAdmission?.();
      check();
      const digest = createHash('sha256');
      // Allocate one fixed chunk. The one-byte probe distinguishes EOF at the payload limit.
      const buffer = Buffer.alloc(Math.min(65536, limit + 1));
      let bytes = 0;
      while (true) {
        check();
        const requested = Math.min(buffer.length, limit - bytes + 1);
        const read = await file.read(buffer, 0, requested, bytes);
        check();
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > limit) {
          const error = new Error('Diagnostic read byte bound exceeded');
          Object.defineProperty(error, 'readBytes', { value: bytes });
          throw error;
        }
        digest.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await file.stat({ bigint: true });
      check();
      const afterPath = await stat(selected, { bigint: true });
      check();
      const canonicalAfter = await lstat(canonical, { bigint: true });
      check();
      const selectedAfter = await realpath(selected);
      check();
      const stable = canonicalAfter.isFile() && selectedAfter === canonical &&
        JSON.stringify(tuple(before)) === JSON.stringify(tuple(after)) &&
        JSON.stringify(tuple(beforePath)) === JSON.stringify(tuple(afterPath)) &&
        JSON.stringify(tuple(canonicalBefore)) === JSON.stringify(tuple(canonicalAfter)) && bytes === Number(before.size);
      return { selectedPathSha256: hash(Buffer.from(selected)), canonicalPathSha256: hash(Buffer.from(canonical)),
        bytes, before: tuple(before), after: tuple(after), stable, sha256: stable ? digest.digest('hex') : null,
        payloadLimitBytes: limit, readLimitBytes: limit + 1, chunkAllocationBytes: buffer.length, operationTimeoutMs: timeoutMs,
        noFollowOpen: Boolean(constants.O_NOFOLLOW), nonblockingOpen: Boolean(constants.O_NONBLOCK),
        limit: 'Result deadline bounds all stages; pending kernel request cancellation is not measured' };
    } finally { await file.close(); options.afterClose?.(); }
  })();
  // Work owns any late-opened handle and closes it after outstanding operations settle.
  return Promise.race([work, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export async function sourceFileIdentity(selected: string, options: ReadOptions = {}) {
  const identity = await boundedRegularFileIdentity(selected, sourceLimit, { ...options, timeoutMs: options.timeoutMs ?? 1000 });
  if (!identity.stable || identity.sha256 === null) throw new Error('Diagnostic source changed during retention');
  return { sha256: identity.sha256, bytes: identity.bytes };
}

/** This binds the exact selected file after cleanup. It cannot identify loaded launch bytes. */
export async function executableIdentity(selected: string, options: ReadOptions = {}) {
  const identity = await boundedRegularFileIdentity(selected, executableLimit, options);
  if (identity.bytes === 0) throw new Error('Selected executable is not a bounded stable regular file');
  return { ...identity, collected: 'after fixture scope cleanup attempt', loadedLaunchBytes: 'not measured',
    limit: 'Stable file read after cleanup attempt only; loaded launch bytes and pending kernel request cancellation are not measured' };
}

type CleanupOutcome = 'scope fulfilled; survivor census not measured' | 'scope rejected; cleanup completion not measured';

/** Register only the fresh target capability. No protocol call or warmup runs here. */
export function targetCaptureDiagnostic(broker: Awaited<ReturnType<typeof startBroker>>, sessionId: string) {
  let registration: ReturnType<typeof registerBrowserPhases>;
  let runtime: { selectedExecutable: string; connectedVersion: string } | undefined;
  let unavailable: ReturnType<typeof captureDiagnosticError> | undefined;
  try {
    const owned = broker.sessions['get'](sessionId);
    if (!(owned.backend instanceof BrowserBackend)) throw new Error('Target is not an owned browser backend');
    const backend = owned.backend;
    registration = registerBrowserPhases(backend, backend.context, broker.sessions['root'], owned.profile, () => {});
    if (!registration) throw new Error('Target phase capability admission was refused');
    runtime = { selectedExecutable: backend['owned'].executable, connectedVersion: backend['owned'].browser.version() };
  } catch (error) { unavailable = captureDiagnosticError(error); }
  const admission = { admitted: registration !== undefined, runtimeAvailable: runtime !== undefined, unavailable,
    ownership: 'Fresh broker target backend/context/workspace/profile; viewer and personal browser excluded',
    label: 'unlabelled', labelScope: 'Only the selected-regression target is registered',
    budgets: { captureDefaultMs: 3000, initialWaitDefaultMs: 5000, testMs: 30000 },
    limit: 'Defaults are not effective-budget measurements; phase admission is not a root cause or performance pass' };
  const save = async (directory: string, failure: ReturnType<typeof captureDiagnosticError> | undefined, cleanup: CleanupOutcome) => {
    const sourceNames = ['src/browser.ts', 'src/browser-presence.ts', 'src/browser-phase-observer.ts',
      'src/chrome.ts', 'src/runtime-paths.ts', 'src/session.ts', 'src/resource-budget.ts',
      'tests/product-ui.test.ts', 'tests/browser-capture-diagnostic.ts', 'tests/owned-fixture.ts', 'tests/viewer-page.ts',
      'viewer/viewer.js', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/limited.ts'];
    const sourceRoot = new URL('../', import.meta.url);
    const files: { path: string; sha256: string; bytes: number }[] = [];
    let sourceError: ReturnType<typeof captureDiagnosticError> | undefined, executable: unknown, budget: unknown;
    try {
      for (const path of sourceNames) {
        const identity = await sourceFileIdentity(fileURLToPath(new URL(path, sourceRoot)));
        files.push({ path, ...identity });
      }
    } catch (error) { sourceError = captureDiagnosticError(error); }
    try { if (runtime) executable = await executableIdentity(runtime.selectedExecutable); }
    catch (error) { executable = { complete: false, error: captureDiagnosticError(error), loadedLaunchBytes: 'not measured' }; }
    try {
      const limits = await requireResourceBudget();
      budget = { available: true, enforcedLimitsSha256: hash(Buffer.from(JSON.stringify(limits))),
        association: 'Same fixture process, checked after cleanup attempt; utilization not measured' };
    } catch (error) { budget = { complete: false, error: captureDiagnosticError(error) }; }
    const version = runtime?.connectedVersion;
    const evidence = { schemaVersion: 1, name: 'selected-regression', failure, admission, cleanup,
      capture: registration?.snapshot() ?? { complete: false, reason: 'Target phase admission unavailable' },
      runtime: { platform: process.platform, bunVersion: Bun.version,
        selectedExecutablePathSha256: runtime ? hash(Buffer.from(runtime.selectedExecutable)) : null,
        version: version !== undefined && version.length <= 65536
          ? { mechanism: 'Playwright cached handshake from this actual owned browser',
            numeric: /^\d+(?:\.\d+)+$/.test(version) ? version : 'not measured', rawUtf8Sha256: hash(Buffer.from(version)),
            cliStdout: 'not measured', cliStderr: 'not measured', cliExit: 'not measured' }
          : { complete: false, reason: 'Connected target version unavailable or beyond retention bound' }, executable, budget },
      source: { files, complete: !sourceError && files.length === sourceNames.length, error: sourceError,
        sha256: hash(Buffer.from(JSON.stringify(files))),
        limit: 'Listed source bytes after cleanup attempt only; source before/after binding and dependency identity are not measured' },
      limit: 'Target capture/navigation phases only; root cause, loaded launch bytes, survivor census and capture performance remain not measured' };
    const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryState = await lstat(directory);
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink() || await realpath(directory) !== resolve(directory) ||
      (process.platform !== 'win32' && directoryState.uid !== process.getuid?.()))
      throw new Error('Diagnostic output is not an owned canonical directory');
    const artifact = await open(join(directory, 'product-capture-selected-regression.json'), 'wx', 0o600);
    try { await artifact.writeFile(bytes); } finally { await artifact.close(); }
    console.log(JSON.stringify({ productCaptureDiagnostic: { name: evidence.name, admitted: admission.admitted,
      sha256: hash(bytes), bytes: bytes.length, loadedLaunchBytes: 'not measured' } }));
  };
  return {
    admission,
    close() { registration?.close(); },
    enqueueSave(directory: string, failure: ReturnType<typeof captureDiagnosticError> | undefined, cleanup: CleanupOutcome) {
      if (pendingSaves.length < 8) pendingSaves.push(() => save(directory, failure, cleanup));
    },
  };
}
