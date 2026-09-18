/**
 * Does the SECOND containment layer actually work?
 *
 * The first layer is the supervisor: it holds a process group and sweeps it when the broker's pipe
 * closes. `experiments/macos-reaping.ts` measures that, and it passes. The gap it cannot cover is the
 * supervisor ITSELF being SIGKILLed, because then nothing runs the sweep and the browser tree is left
 * with nothing above it.
 *
 * `src/macos-orphans.ts` is what closes that gap, and this is what proves it. An audit found the
 * previous attempt at this layer documented in three comments with zero callers, so a layer that is
 * merely written and wired is not a layer that works. The only difference between this file and that
 * mistake is that this one kills a real supervisor and counts what is left.
 *
 * The scenario, in order:
 *
 *   1. Start a real browser session through Orbit's own launcher.
 *   2. SIGKILL the SUPERVISOR, not the browser. No handler runs, no sweep happens, and the browser
 *      tree survives with its process group intact. That is the orphan.
 *   3. Confirm the orphan is really still there, because a test that skips this step would pass
 *      against a tree that had already died on its own.
 *   4. Run `sweepOrphanedSessions()` the way the broker runs it at start.
 *   5. Count what is left.
 *
 * A failure here is a result and is printed as one. The exit code is non zero only when the sweep
 * left something behind, because that is the claim `docs/support-tiers.md` rests on.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchChrome } from "../src/chrome";
import { processGroupMembers, processPath } from "../src/macos";
import { sweepOrphanedSessions } from "../src/macos-orphans";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ skipped: "this experiment measures the macOS orphan sweep", platform: process.platform }));
  process.exit(0);
}

// A workspace root of this experiment's own, laid out the way a real broker lays one out:
// `<root>/broker-XXXX/profile-XXXX/`. The nesting is the point rather than incidental. The first
// version of the sweep looked for `owner.json` one level down, which is not where a session puts it,
// and a fixture built to match that guess would have passed while the real thing found nothing.
const root = await mkdtemp(join(tmpdir(), "orbit-orphan-root-"));
const workspace = await mkdtemp(join(root, "broker-"));
const profile = await mkdtemp(join(workspace, "profile-"));
const report: Record<string, unknown> = { experiment: "macos-orphan-sweep", date: new Date().toISOString() };

try {
  const session = await launchChrome(profile);
  const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as
    { pid: number; pgid: number; leaderStartedAtMs: number | null };
  report.pgid = owner.pgid;
  report.processesAtLaunch = processGroupMembers(owner.pgid).pids.length;

  // The supervisor, killed outright. This is the case the first layer cannot handle: no handler
  // runs, so nothing sweeps the group, and the browser is orphaned.
  process.kill(owner.pid, "SIGKILL");
  await Bun.sleep(600);

  // The orphan has to REALLY be there, or the sweep below is being credited for a tree that died by
  // itself. This is the assertion that makes the rest of the experiment mean anything.
  const orphaned = processGroupMembers(owner.pgid).pids.filter(pid => pid !== process.pid);
  report.orphanedProcesses = orphaned.length;
  report.orphanedTree = orphaned.slice(0, 6).map(pid => ({ pid, path: processPath(pid) }));
  if (!orphaned.length) {
    report.verdict = "not measured: the tree did not survive the supervisor, so there was no orphan to sweep";
    console.log(JSON.stringify(report, null, 2));
    await session.close().catch(() => {});
    process.exit(0);
  }

  // The layer under test, called exactly as `src/cli.ts` calls it at broker start.
  const started = performance.now();
  const sweep = await sweepOrphanedSessions(root);
  report.sweepMs = Math.round(performance.now() - started);
  report.sweep = sweep;

  const survivors = processGroupMembers(owner.pgid).pids.filter(pid => pid !== process.pid);
  report.survivorsAfterSweep = survivors.length;
  // Anything the sweep missed is killed here rather than left on the machine. An experiment that
  // proves a containment failure by leaving a browser running has committed the failure it is
  // documenting.
  for (const pid of survivors) { try { process.kill(pid, "SIGKILL"); } catch {} }

  report.verdict = survivors.length === 0 && sweep.swept.length > 0
    ? "the orphaned tree was found and reaped by the broker's start-up sweep"
    : sweep.swept.length === 0
      ? "FAILED: the sweep did not recognise the orphaned session at all"
      : "FAILED: the sweep ran and processes survived it";
  await session.close().catch(() => {});
} catch (error) {
  report.verdict = `FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300);
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = String(report.verdict).startsWith("FAILED") ? 1 : 0;
