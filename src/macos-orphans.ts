/**
 * The second containment layer: reap browser trees whose supervisor died without sweeping.
 *
 * The first layer is `src/native/supervise-darwin.ts`, which holds a process group and sweeps it when
 * the broker's pipe closes. That covers a broker that exits, crashes or is killed, because a pipe is
 * torn down by the kernel and cannot be skipped. What it does not cover is the supervisor ITSELF
 * being SIGKILLed: nothing runs, the group survives, and the browser keeps going with nothing above
 * it. Linux has the same gap and closes it with `sweepOwnedGroup()` in `src/owned-group.ts`, called
 * from the Fedora backend.
 *
 * On macOS that layer was documented in three separate comments and **did not exist**. An audit found
 * `signalOwnedProcessGroup` had no callers anywhere in the tree. The consequence was worse than a
 * missing feature: `cleanWorkspaces()` runs at broker start, decides a workspace is abandoned because
 * no broker answers for it, and deletes the directory. So an orphaned browser was not merely left
 * running, its profile was deleted from under it while it ran.
 *
 * This is what closes it. Every session workspace holds an `owner.json` naming the process group and
 * the facts that prove the group is Orbit's, and this walks them before any cleanup happens.
 *
 * What it is NOT: a kernel guarantee. Two best effort layers do not add up to `KILL_ON_JOB_CLOSE`,
 * and `docs/support-tiers.md` states the macOS row at the tier that evidence supports rather than at
 * the Linux one.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { groupIsStillOurs, processGroupMembers, requireDarwin, SIGNAL } from "./macos";
import { workspaceRoot } from "./workspace-storage";

type OwnerRecord = { pgid?: number; leaderStartedAtMs?: number | null; leaderExecutable?: string };

export type OrphanSweep = {
  /** Workspaces that carried a process group record at all. */
  inspected: number;
  /** Groups proved to be Orbit's and still alive, then signalled. */
  swept: { workspace: string; pgid: number; processes: number; escalated: boolean; cleared: boolean }[];
  /**
   * Records whose group could not be proved ours: a reused pgid, a wrong executable, or an
   * unreadable start time. Left alone and reported, because the alternative is signalling a group
   * that may belong to the person, which is the one thing this project must never do.
   */
  refused: { workspace: string; pgid: number; reason: string }[];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Signal one proved group, graceful first and then not, skipping this process.
 *
 * `killpg` is not used: the broker is not in the group it is sweeping, but the pid list is walked
 * anyway so a member that exits mid sweep is an ESRCH rather than an error, and so the same code
 * shape is used here as in the supervisor. Self is skipped defensively, in case a future caller is
 * inside the group.
 */
async function sweepGroup(pgid: number, graceMs = 2000) {
  const signalMembers = (signal: number) => {
    for (const pid of processGroupMembers(pgid).pids) {
      if (pid === process.pid) continue;
      try { process.kill(pid, signal); } catch {}
    }
  };
  // `failed` counts as still holding something: an unreadable group is not an empty one, and
  // treating it as empty is what stopped the supervisor escalating to SIGKILL for a whole release.
  const stillThere = () => {
    const members = processGroupMembers(pgid);
    if (members.failed) return true;
    return members.pids.filter(pid => pid !== process.pid).length > 0;
  };
  const before = processGroupMembers(pgid).pids.length;
  signalMembers(SIGNAL.TERM);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && stillThere()) await sleep(25);
  let escalated = false;
  if (stillThere()) {
    escalated = true;
    signalMembers(SIGNAL.KILL);
    for (let attempt = 0; attempt < 80 && stillThere(); attempt++) await sleep(25);
  }
  return { processes: before, escalated, cleared: !stillThere() };
}

/**
 * Reap every owned browser tree that outlived its supervisor.
 *
 * Called at broker start, BEFORE `cleanWorkspaces()`, which is the ordering that matters: cleaning
 * first would delete the profile of a browser that is still running out of it.
 *
 * Ownership is proved before anything is signalled, by the same `groupIsStillOurs` the live
 * containment check uses: the leader's recorded start time and executable have to match what the
 * kernel says now. A pgid whose number was handed out again fails that, and is reported rather than
 * signalled. There is no path here that signals a group Orbit did not create.
 */
export async function sweepOrphanedSessions(root = workspaceRoot()): Promise<OrphanSweep> {
  requireDarwin();
  const result: OrphanSweep = { inspected: 0, swept: [], refused: [] };
  let workspaces: string[];
  try { workspaces = await readdir(root); } catch { return result; }
  for (const workspace of workspaces.sort()) {
    // A session's profile directory, which is where the supervisor wrote its record. Sessions live
    // one level down, so both shapes are tried rather than assuming a layout.
    for (const candidate of [join(root, workspace, "owner.json"), join(root, workspace, "profile", "owner.json")]) {
      let owner: OwnerRecord;
      try { owner = JSON.parse(await readFile(candidate, "utf8")); } catch { continue; }
      if (!Number.isInteger(owner.pgid) || owner.pgid! <= 1) continue;
      result.inspected++;
      const pgid = owner.pgid!;
      // Nothing left in the group is the ordinary case: the supervisor swept it properly and this
      // workspace is simply finished. Not reported as swept, because nothing was.
      const members = processGroupMembers(pgid);
      if (!members.failed && !members.pids.length) continue;
      if (typeof owner.leaderStartedAtMs !== "number") {
        result.refused.push({ workspace, pgid, reason: "no leader start time was recorded, so the group cannot be proved Orbit's" });
        continue;
      }
      if (!groupIsStillOurs(pgid, { startedAtMs: owner.leaderStartedAtMs, executable: owner.leaderExecutable })) {
        result.refused.push({ workspace, pgid, reason: "the process group id no longer belongs to the process Orbit started" });
        continue;
      }
      result.swept.push({ workspace, pgid, ...await sweepGroup(pgid) });
    }
  }
  return result;
}
