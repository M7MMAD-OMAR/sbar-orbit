import { OrbitError } from "./errors";

/** Retain a cleanup capability when a failed start may still own processes. */
export class OwnedCleanupError extends AggregateError {
  constructor(primary: unknown, cleanup: unknown, readonly retry: () => Promise<void>) {
    super([primary, cleanup], "Owned browser failure and cleanup remain incomplete");
  }
}

export function retryableCleanup(work: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  let done = false;
  return () => {
    if (done) return Promise.resolve();
    return pending ??= work().then(() => { done = true; }, error => { pending = undefined; throw error; });
  };
}

type Job = { terminate(): void; processIds(): number[]; close(): void };
type Root = { exitCode(): number | null };
export type StopEvidence = { rootExitCode: number | null; members?: number[]; confirmed: boolean; handleClosed: boolean };

/** Keep the job queryable until its tree and root are both observed gone. */
export function confirmedWindowsStop(job: Job, root: Root, evidence: StopEvidence,
  clock = () => Date.now(), sleep = (ms: number) => Bun.sleep(ms)) {
  return retryableCleanup(async () => {
    const deadline = clock() + 4000;
    job.terminate();
    for (;;) {
      evidence.members = job.processIds();
      evidence.rootExitCode = root.exitCode();
      const observedAt = clock();
      if (observedAt > deadline)
        throw new OrbitError("BACKEND_FAILED", "Owned browser exit is unconfirmed after cleanup deadline; job and profile retained");
      if (evidence.members.length === 0 && evidence.rootExitCode !== null) break;
      if (observedAt >= deadline)
        throw new OrbitError("BACKEND_FAILED", "Owned browser exit is unconfirmed after cleanup deadline; job and profile retained");
      await sleep(Math.min(25, Math.max(0, deadline - clock())));
    }
    evidence.confirmed = true;
    job.close();
    evidence.handleClosed = true;
  });
}
