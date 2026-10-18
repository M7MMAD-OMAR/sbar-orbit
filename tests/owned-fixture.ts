import { OwnedCleanupError, retryableCleanup } from '../src/owned-cleanup';

/** Resources become owned as soon as their acquisition acknowledges success. */
export class OwnedFixtureScope {
  private readonly releases: Array<() => Promise<void>> = [];

  defer(release: () => Promise<void> | void) {
    this.releases.push(retryableCleanup(async () => { await release(); }));
  }

  async close() {
    const failures: unknown[] = [];
    for (const release of [...this.releases].reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    const [only] = failures;
    if (failures.length === 1) throw only;
    if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup remains incomplete');
  }

  async protect<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (primary) {
      try { await this.close(); }
      catch (cleanup) { throw new OwnedCleanupError(primary, cleanup, () => this.close()); }
      throw primary;
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const value = await this.protect(work);
    try { await this.close(); }
    catch (cleanup) { throw new OwnedCleanupError(undefined, cleanup, () => this.close()); }
    return value;
  }
}
