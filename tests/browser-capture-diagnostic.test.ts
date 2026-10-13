import { expect, test } from 'bun:test';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { captureDiagnosticError, executableIdentity, sourceFileIdentity } from './browser-capture-diagnostic';

test('selected target diagnostic never retains arbitrary error messages or getter values', () => {
  const message = 'secret-cookie https://private.invalid/private/fixture/profile';
  const error = new Error(message);
  Object.defineProperty(error, 'code', { get() { throw new Error(message); } });
  expect(captureDiagnosticError(error)).toEqual({ name: 'Error', code: 'other', message: 'redacted' });
  expect(JSON.stringify(captureDiagnosticError({ code: 'ENOENT', message }))).not.toContain(message);
  expect(captureDiagnosticError({ code: 'ENOENT' }).code).toBe('ENOENT');
});

test('selected executable identity binds exact file after cleanup, retaining launch uncertainty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-capture-identity-'));
  try {
    const path = join(root, 'owned-executable');
    const bytes = Buffer.from('owned disposable executable fixture');
    await writeFile(path, bytes);
    const identity = await executableIdentity(path);
    expect(identity.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(identity.bytes).toBe(bytes.length);
    expect(identity.stable).toBe(true);
    expect(identity.loadedLaunchBytes).toBe('not measured');
    expect(JSON.stringify(identity)).not.toContain(path);
    if (process.platform !== 'win32') {
      const link = join(root, 'selected-link');
      await symlink(path, link);
      const linked = await executableIdentity(link);
      expect(linked.sha256).toBe(identity.sha256);
      expect(linked.selectedPathSha256).not.toBe(linked.canonicalPathSha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected executable identity refuses missing, empty and non-file identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-capture-identity-'));
  try {
    const path = join(root, 'empty');
    await writeFile(path, '');
    await expect(executableIdentity(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(executableIdentity(path)).rejects.toThrow('bounded stable regular file');
    await expect(executableIdentity(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('selected error name getters cannot bypass the fixed name vocabulary', () => {
  const privateName = 'secret-cookie /private/fixture/private-profile';
  let accesses = 0;
  const alternating = new Error('redacted');
  Object.defineProperty(alternating, 'name', { get() { return ++accesses === 1 ? 'Error' : privateName; } });
  expect(captureDiagnosticError(alternating)).toEqual({ name: 'Error', code: 'other', message: 'redacted' });
  expect(accesses).toBe(0);
  const throwing = new Error('redacted');
  Object.defineProperty(throwing, 'name', { get() { ++accesses; throw new Error(privateName); } });
  expect(captureDiagnosticError(throwing).name).toBe('Error');
  expect(accesses).toBe(0);
  expect(captureDiagnosticError({ name: 'TimeoutError', code: 'TIMEOUT' })).toEqual({ name: 'TimeoutError', code: 'TIMEOUT', message: 'redacted' });
  expect(captureDiagnosticError({ name: privateName }).name).toBe('other');
});

test('source retention reads a growing real file only up to the payload limit plus one probe byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-growing-source-'));
  const limit = 1024 * 1024;
  try {
    const path = join(root, 'source');
    await writeFile(path, 'small admitted source');
    let failure: unknown;
    try {
      await sourceFileIdentity(path, { afterAdmission: async () => {
        const writer = await open(path, 'r+');
        try { await writer.truncate(limit * 4); } finally { await writer.close(); }
      } });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: 'Diagnostic read byte bound exceeded' });
    const descriptor = failure !== null && typeof failure === 'object'
      ? Object.getOwnPropertyDescriptor(failure, 'readBytes') : undefined;
    const candidate = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    const readBytes = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
    console.log(JSON.stringify({ growingSourceReadWitness: { readBytes: readBytes ?? null } }));
    expect(readBytes).toBe(limit + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('selected executable refuses an owned FIFO before open can wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-fifo-identity-'));
  const fifo = join(root, 'owned-fifo');
  const child = Bun.spawn(['mkfifo', fifo], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  try {
    expect(await child.exited).toBe(0);
    let failure: unknown;
    try { await executableIdentity(fifo, { timeoutMs: 100 }); }
    catch (error) { failure = error; }
    finally {
      // Unblock the deliberately deficient control's pending owned FIFO reader.
      const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => undefined);
      await writer?.close();
    }
    expect(failure).toMatchObject({ message: 'Diagnostic input is not a bounded regular file' });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostic file result deadline includes the post-admission stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-timeout-identity-'));
  let settleAdmission: (() => void) | undefined;
  let admitted = false;
  let acknowledgeClose: (() => void) | undefined;
  const closed = new Promise<void>(resolve => { acknowledgeClose = resolve; });
  try {
    const path = join(root, 'source');
    await writeFile(path, 'owned source');
    const blocked = new Promise<void>(resolve => { settleAdmission = resolve; });
    const started = performance.now();
    try {
      await expect(sourceFileIdentity(path, { timeoutMs: 250, afterAdmission: () => { admitted = true; return blocked; }, afterClose: () => acknowledgeClose?.() })).rejects.toThrow('Diagnostic file operation timed out');
      expect(admitted).toBe(true);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      settleAdmission?.();
      if (admitted) await closed;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('descriptor prototype value getters cannot bypass fixed diagnostic fields', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  const privateValue = 'secret-cookie /private/fixture/private-profile';
  let prototypeReads = 0, accessorReads = 0;
  const codeTarget = new Error('redacted');
  Object.defineProperty(codeTarget, 'name', { value: 'Error', configurable: true });
  Object.defineProperty(codeTarget, 'code', { get() { ++accessorReads; return privateValue; }, configurable: true });
  const nameTarget = new Error('redacted');
  Object.defineProperty(nameTarget, 'name', { get() { ++accessorReads; return privateValue; }, configurable: true });
  // Null-prototype descriptors avoid inherited value/get fields during installation and restoration.
  const poison = Object.create(null) as PropertyDescriptor;
  poison.configurable = true;
  poison.get = () => ++prototypeReads < 3 ? 'TIMEOUT' : privateValue;
  let codeResult: ReturnType<typeof captureDiagnosticError> | undefined;
  let nameResult: ReturnType<typeof captureDiagnosticError> | undefined;
  let codePrototypeReads = 0, namePrototypeReads = 0;
  try {
    Object.defineProperty(Object.prototype, 'value', poison);
    codeResult = captureDiagnosticError(codeTarget);
    codePrototypeReads = prototypeReads;
    prototypeReads = 0;
    poison.get = () => { ++prototypeReads; return 'TimeoutError'; };
    Object.defineProperty(Object.prototype, 'value', poison);
    nameResult = captureDiagnosticError(nameTarget);
    namePrototypeReads = prototypeReads;
  } finally {
    if (original) {
      const restore = Object.create(null) as PropertyDescriptor;
      for (const key of Object.keys(original)) Object.defineProperty(restore, key, {
        value: Reflect.get(original, key), writable: true, enumerable: true, configurable: true,
      });
      Object.defineProperty(Object.prototype, 'value', restore);
    } else { Reflect.deleteProperty(Object.prototype, 'value'); }
  }
  // Assertions run only after the global prototype has been restored.
  expect(codeResult).toEqual({ name: 'Error', code: 'other', message: 'redacted' });
  expect(codePrototypeReads).toBe(0);
  expect(nameResult).toEqual({ name: 'Error', code: 'other', message: 'redacted' });
  expect(namePrototypeReads).toBe(0);
  expect(accessorReads).toBe(0);
  expect(Object.getOwnPropertyDescriptor(Object.prototype, 'value')).toEqual(original);
});
