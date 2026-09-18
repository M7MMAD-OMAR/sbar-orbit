/**
 * Own and reap one browser tree on macOS until the broker's pipe closes.
 *
 * The Linux supervisor is `supervise.py` and uses `PR_SET_CHILD_SUBREAPER`, which the kernel honours
 * even against a process that tries to detach. The Windows port needs no supervisor at all because
 * `KILL_ON_JOB_CLOSE` is the kernel doing the same job. macOS has neither, and this file is the
 * honest third answer: a process group, a pipe, and a sweep.
 *
 * How it works, and exactly how strong it is:
 *
 *   - `setpgid(0, 0)` makes this process a group leader. The browser is spawned as a child, so it
 *     and every helper it starts inherit this group id, and the kernel will enumerate the group on
 *     demand through `proc_listpids(PROC_PGRP_ONLY)`.
 *   - stdin is a pipe from the broker that the browser never inherits, so the broker dying, however
 *     it dies, closes it and produces EOF here. That is the signal to reap.
 *   - Reaping is `killpg(SIGTERM)`, then `killpg(SIGKILL)` after a grace period, then a poll until
 *     the kernel reports the group empty.
 *
 * This is BEST EFFORT and not a kernel guarantee, and the difference matters enough to write down:
 * if this supervisor is itself SIGKILLed, nothing runs the sweep, and the browser tree survives with
 * its group intact. What catches that case is the broker's own sweep on start, which reads the
 * session workspace's `owner.json`, confirms the group is still Orbit's, and kills it. Two best
 * effort layers are not one kernel guarantee, and `docs/support-tiers.md` states the macOS row at
 * the tier that evidence supports rather than at the Linux one.
 *
 * Nothing here reads the browser's output, its profile or its pages. It writes one file: the owner
 * record the broker reads to learn the group id.
 */

import { writeFileSync } from "node:fs";
import { becomeSessionLeader, processGroupMembers, processStartedAtMs, SIGNAL } from "../macos";

const [reportPath, executable, ...argv] = process.argv.slice(2);
if (!reportPath || !executable) {
  console.error("Usage: supervise-darwin.ts OWNER_JSON EXECUTABLE [ARGS...]");
  process.exit(2);
}

// Before the spawn, so the child cannot start in the broker's group and be missed by every sweep.
//
// `setsid`, not merely `setpgid`: a new session is a new process group AND a detachment from the
// controlling terminal, so a Ctrl-C or a hangup in the person's shell cannot reach the browser tree
// and the browser cannot reach for their terminal. This is the same thing the Linux supervisor gets
// from `start_new_session=True`.
const pgid = becomeSessionLeader();

let child: Bun.Subprocess;
try {
  child = Bun.spawn([executable, ...argv], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ error: { code: "BACKEND_FAILED", message: "Browser could not start" } }), { mode: 0o600 });
  process.exit(1);
}

writeFileSync(reportPath, JSON.stringify({
  pid: child.pid, pgid,
  // The two facts that turn this pgid from a number into an identity. A pgid is reused, so anything
  // that later sweeps this group has to prove it is still the same group before it signals: see
  // `groupIsStillOurs`. Recorded HERE, by the process that created the group, because that is the
  // only moment the answer is known to be true.
  leaderStartedAtMs: processStartedAtMs(pgid),
  leaderExecutable: process.execPath,
}), { mode: 0o600 });

let stopping = false;
const stop = () => { stopping = true; };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// EOF on stdin is the broker's death or its deliberate stop, and both mean the same thing here.
void (async () => {
  try { for await (const _chunk of Bun.stdin.stream()) { /* the broker never writes; only EOF matters */ } }
  catch {}
  stopping = true;
})();

while (!stopping && child.exitCode === null && child.signalCode === null) await Bun.sleep(50);

/**
 * Is the group still holding anything besides this supervisor?
 *
 * `failed` is treated as YES, deliberately. A read that did not answer is not an empty group, and the
 * two used to be indistinguishable here: the escalation below tests this before sending SIGKILL, so a
 * failed enumeration reported "nothing left" and the tree that had just ignored SIGTERM was never
 * killed at all. Erring toward "something is still there" costs one wasted SIGKILL to a group that
 * was already gone, which is harmless, against leaving a browser running on the person's machine.
 */
function groupStillHoldsSomething() {
  const members = processGroupMembers(pgid);
  if (members.failed) return true;
  return members.pids.filter(pid => pid !== process.pid).length > 0;
}

/**
 * Sweep the group WITHOUT signalling this process.
 *
 * `killpg` on one's own group delivers to the caller too, and for SIGTERM that is merely untidy: the
 * handler above sets a flag that is already set. For SIGKILL it is a defect, because SIGKILL cannot
 * be handled or blocked, so this supervisor would die mid sweep. Everything after the kill, the poll
 * that confirms the group actually emptied and the exit code that tells the broker how the browser
 * ended, would never run. The tree would still be reaped, so the bug is invisible in the one
 * measurement anybody looks at, which is exactly why it is worth fixing rather than tolerating.
 *
 * So the members are enumerated from the kernel and signalled one at a time, skipping this pid. A
 * process that exits between the enumeration and the signal is an ESRCH that means success, which is
 * why the throw is swallowed rather than reported.
 */
function sweepGroupExceptSelf(signal: number) {
  for (const pid of processGroupMembers(pgid).pids) {
    if (pid === process.pid) continue;
    try { process.kill(pid, signal); } catch {}
  }
}

const graceMs = 4000;
sweepGroupExceptSelf(SIGNAL.TERM);
const deadline = Date.now() + graceMs;
while (Date.now() < deadline && groupStillHoldsSomething()) await Bun.sleep(25);
if (groupStillHoldsSomething()) {
  sweepGroupExceptSelf(SIGNAL.KILL);
  for (let attempt = 0; attempt < 80 && groupStillHoldsSomething(); attempt++) await Bun.sleep(25);
}
// What is left after both passes, reported on stderr so the broker's `diagnostics()` can attribute a
// failed reap rather than leaving it to be noticed later. Silent on the ordinary path.
const final = processGroupMembers(pgid);
const survivors = final.pids.filter(pid => pid !== process.pid);
if (survivors.length || final.failed)
  console.error(`orbit supervisor: ${final.failed ? "could not enumerate the group after the sweep" : `${survivors.length} process(es) survived the sweep`}`);
process.exit(child.exitCode ?? 0);
