import { expect, test } from 'bun:test';
import { removeFixtureProfile } from './fixture-profile-cleanup';

test('fixture removal waits for a transient Windows profile lock', async () => {
  let attempts = 0;
  const waits: number[] = [];
  await removeFixtureProfile('owned-fixture', {
    platform: 'win32',
    async remove() { if (++attempts === 1) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    async wait(ms) { waits.push(ms); },
  });
  expect(attempts).toBe(2);
  expect(waits).toEqual([100]);
});

test('persistent Windows profile locks still fail after the bounded waits', async () => {
  const failure = Object.assign(new Error('still locked'), { code: 'EBUSY' });
  let attempts = 0;
  const waits: number[] = [];
  await expect(removeFixtureProfile('owned-fixture', {
    platform: 'win32', async remove() { attempts++; throw failure; },
    async wait(ms) { waits.push(ms); },
  })).rejects.toBe(failure);
  expect(attempts).toBe(9);
  expect(waits).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
});

test('fixture removal preserves nontransient Windows errors', async () => {
  const failure = Object.assign(new Error('wrong permissions'), { code: 'EACCES' });
  let waited = false;
  await expect(removeFixtureProfile('owned-fixture', {
    platform: 'win32', async remove() { throw failure; },
    async wait() { waited = true; },
  })).rejects.toBe(failure);
  expect(waited).toBe(false);
});

test('fixture removal does not retry POSIX errors', async () => {
  const failure = Object.assign(new Error('busy'), { code: 'EBUSY' });
  let waited = false;
  await expect(removeFixtureProfile('owned-fixture', {
    platform: 'linux', async remove() { throw failure; },
    async wait() { waited = true; },
  })).rejects.toBe(failure);
  expect(waited).toBe(false);
});
