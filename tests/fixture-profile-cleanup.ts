import { rm } from 'node:fs/promises';

type Operations = {
  platform?: NodeJS.Platform;
  remove?: (profile: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
};

export async function removeFixtureProfile(profile: string, operations: Operations = {}) {
  const remove = operations.remove ?? (path => rm(path, { recursive: true }));
  const platform = operations.platform ?? process.platform;
  const wait = operations.wait ?? (milliseconds => Bun.sleep(milliseconds));
  // Bun ignores fs.rm retry options for recursive removal. Wait explicitly for
  // transient Windows locks, retaining failure after eight bounded waits.
  for (let attempt = 0; ; attempt++) {
    try { await remove(profile); return; }
    catch (error) {
      if (platform !== 'win32' || attempt === 8 ||
          !['EBUSY', 'ENOTEMPTY', 'EPERM', 'EMFILE', 'ENFILE'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await wait(100 * (attempt + 1));
    }
  }
}
