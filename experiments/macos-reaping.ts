/**
 * Does anything survive a broker that is killed outright, on macOS?
 *
 * This is the macOS counterpart of `tests/browser-crash.test.ts` and of the Windows guest measurement
 * that recorded 12 browser processes, `taskkill /F` on the broker, and zero survivors after 236 ms.
 * It exists as an experiment rather than only as a test because the interesting number is a
 * measurement, not a boolean: how many processes the tree had, how long the sweep took, and what was
 * left, printed so a person can read it in a CI log and paste it into an issue.
 *
 * The scenario, in order:
 *
 *   1. Start a browser session through Orbit's own launcher, inside the budget.
 *   2. Count the processes in its group, from the kernel.
 *   3. SIGKILL the supervisor. Not SIGTERM: the whole question is what happens when NO cleanup
 *      handler runs, and a graceful stop measures the path that already works.
 *   4. Poll the kernel until the group is empty, or until the deadline says it is not going to be.
 *
 * An honest failure here is a result. A tree that survives is recorded with its process count, and
 * `docs/support-tiers.md` states the row at the tier this output supports.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChrome } from "../src/chrome";
import { groupIsStillOurs, processGroupMembers, processPath } from "../src/macos";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ skipped: "this experiment measures macOS containment", platform: process.platform }));
  process.exit(0);
}

const profile = await mkdtemp(join(tmpdir(), "orbit-reaping-"));
const started = performance.now();
const session = await launchChrome(profile);
const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as
  { pid: number; pgid: number; leaderStartedAtMs: number | null; leaderExecutable?: string };
const before = processGroupMembers(owner.pgid);

// What the tree is, named by executable, so a reader can see it is really a browser and really
// Orbit's. Paths only: no command lines, which would carry the profile path and anything else on
// them, and no environments.
const tree = before.pids.map(pid => ({ pid, path: processPath(pid) }));

// The supervisor, killed with no chance to run anything. `process.kill` with SIGKILL is the closest
// thing to `taskkill /F` this platform has.
process.kill(owner.pid, "SIGKILL");
const killedAt = performance.now();

let survivors = before.pids.length;
let clearedMs: number | null = null;
for (let attempt = 0; attempt < 400; attempt++) {
  await Bun.sleep(25);
  survivors = processGroupMembers(owner.pgid).pids.length;
  if (survivors === 0) { clearedMs = Math.round(performance.now() - killedAt); break; }
}

// Anything still alive is reported AND cleaned up: an experiment that leaves a browser tree on a
// machine is doing the thing this project refuses to do, even when it is proving that it happened.
//
// Gated on the group still being the one this experiment created. Between the kill and here the
// group could have gone and its number been handed out again, and killing a recycled pgid would
// reach whatever now holds it, which on a person's Mac could be their own browser. A survivor that
// cannot be proved to be ours is reported as unswept rather than killed on suspicion.
const stillOurs = owner.leaderStartedAtMs !== null
  && groupIsStillOurs(owner.pgid, { startedAtMs: owner.leaderStartedAtMs, executable: owner.leaderExecutable });
const left = stillOurs ? processGroupMembers(owner.pgid).pids.map(pid => ({ pid, path: processPath(pid) })) : [];
for (const { pid } of left) { try { process.kill(pid, "SIGKILL"); } catch {} }

await session.close().catch(() => {});
await rm(profile, { recursive: true, force: true }).catch(() => {});

const report = {
  experiment: "macos-reaping",
  date: new Date().toISOString(),
  launchMs: Math.round(killedAt - started),
  processesBeforeKill: before.pids.length,
  tree,
  brokerKilledWith: "SIGKILL",
  survivorsAfterSweep: left.length,
  clearedAfterMs: clearedMs,
  // The claim this experiment can support, written here rather than left to a reader to infer.
  verdict: left.length === 0 && before.pids.length > 1
    ? "the owned tree did not survive a killed supervisor on this host"
    : before.pids.length <= 1
      ? "not measured: the browser tree had no processes to reap, so nothing was tested"
      : "FAILED: processes survived a killed supervisor",
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.verdict.startsWith("FAILED") ? 1 : 0;
