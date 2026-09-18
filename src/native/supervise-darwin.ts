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
import { becomeSessionLeader, processGroupMembers, processStartedAtMs, signalProcessGroup, SIGNAL } from "../macos";

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

// The group, not the child. Chrome's helpers are separate processes in the same group, and
// signalling one pid leaves the rest of them running, which is the exact failure this file exists
// to prevent.
const graceMs = 4000;
signalProcessGroup(pgid, SIGNAL.TERM);
const deadline = Date.now() + graceMs;
// `pids.length <= 1` and not `=== 0`: this supervisor is itself in the group it is sweeping, so an
// empty group is impossible while this loop is running and waiting for one would always time out.
while (Date.now() < deadline && processGroupMembers(pgid).pids.length > 1) await Bun.sleep(25);
if (processGroupMembers(pgid).pids.length > 1) {
  signalProcessGroup(pgid, SIGNAL.KILL);
  for (let attempt = 0; attempt < 80 && processGroupMembers(pgid).pids.length > 1; attempt++) await Bun.sleep(25);
}
process.exit(child.exitCode ?? 0);
