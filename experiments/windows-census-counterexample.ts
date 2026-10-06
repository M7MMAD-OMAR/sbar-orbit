/** Opt-in evidence probe. This does not repair or certify the production collector. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";
import { assertSameIdentity, CensusFixtureError, createCensusChild } from "../tests/windows-census-fixture";
import { captureProcessWitnesses, WitnessCaptureError } from "../tests/windows-process-witness";

const paths = ["experiments/windows-census-counterexample.ts", "tests/windows-census-fixture.ts",
  "tests/windows-process-witness.ts", "tests/browser-crash.test.ts", "tests/windows-census-controls.test.ts",
  "src/resource-budget.ts", "src/windows-job.ts", "scripts/limited.ts", "package.json", "bun.lock", "bunfig.toml"];
async function manifest() {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
}
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("An absolute owned report destination is required");
const report: Record<string, unknown> = { state: "not measured", capability: "unknown", limit:
  "Two controlled owned-child trials. Collector unchanged; no browser, compositor, host integration or production cleanup claim." };
let exitCode = 2;
try {
  if (process.platform !== "win32" || process.arch !== "x64" || process.env.ORBIT_WINDOWS_CENSUS_PROBE !== "1")
    throw new Error("Actual Windows x64 opt-in prerequisite is not measured");
  await requireResourceBudget();
  const source = await manifest();
  report.source = source;
  const trials: Record<string, unknown>[] = [];
  report.trials = trials;
  const captureDeadline = performance.now() + 14000;
  for (const mode of ["deferred", "retained"] as const) {
    let fixture: Awaited<ReturnType<typeof createCensusChild>> | undefined;
    let witnesses: ReturnType<typeof captureProcessWitnesses> | undefined;
    let retained: number | undefined, transferred = false, looseClosed = false;
    let retryCaptureClose: (() => void) | undefined;
    const trial: Record<string, unknown> = { mode, state: "unknown", events: [] };
    const events = trial.events as string[];
    const cleanup = async () => {
      const errors: unknown[] = [];
      try { witnesses?.close(); retryCaptureClose?.(); } catch (error) { errors.push(error); }
      if (retained !== undefined && !transferred && !looseClosed && fixture) {
        try { fixture.witnessApi.close(retained); looseClosed = true; } catch (error) { errors.push(error); }
      }
      try { await fixture?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Probe cleanup is unknown");
    };
    trials.push(trial);
    try {
      fixture = await createCensusChild(captureDeadline);
      trial.live = fixture.live;
      const row = Object.freeze({ pid: fixture.live.pid, parentPid: fixture.live.parentPid });
      trial.census = [row];
      events.push("owned live row emitted, creator handles closed");
      if (mode === "retained") {
        retained = fixture.witnessApi.open(row.pid);
        assertSameIdentity(fixture.witnessApi.identity(retained), fixture.live);
        if (fixture.witnessApi.state(retained).state !== "alive") throw new Error("Retained fixture child exited before acquisition acknowledgment");
        events.push("same live creation identity retained before exit gate");
      }
      await fixture.release();
      await fixture.waitExited();
      if (performance.now() >= captureDeadline) throw new Error("Controlled census capture deadline expired");
      events.push("private owned job confirmed empty before census completion");
      await Bun.sleep(25);
      events.push("census completion delivered");
      try {
        witnesses = captureProcessWitnesses([row.pid], mode === "deferred" ? fixture.witnessApi : {
          ...fixture.witnessApi,
          open(pid) {
            if (pid !== row.pid || retained === undefined || transferred) throw new Error("Retained fixture handle ownership mismatch");
            transferred = true;
            return retained;
          },
        });
      } catch (error) {
        if (error instanceof WitnessCaptureError) { retryCaptureClose = error.close; throw error; }
        trial.acquisitionError = error instanceof Error ? error.message : String(error);
        if (mode === "deferred" && error instanceof Error && error.message.startsWith(`OpenProcess owned PID ${row.pid} failed, error `)) {
          trial.state = "unknown";
          trial.counterexample = "actual deferred acquisition failed after the owned job became empty";
        } else throw error;
      }
      if (witnesses) {
        const measured = witnesses.observe();
        trial.measured = measured;
        const item = measured[0];
        if (measured.length !== 1 || !item || item.pid !== row.pid) throw new Error("Owned row was omitted or substituted");
        assertSameIdentity(item, fixture.live);
        if (item.state !== "exited" || item.exitTicks === "0" || item.exitCode !== 0) throw new Error("Controlled stable owned exit is unknown");
        trial.state = mode === "retained" ? "same identity exit measured" : "counterexample not reproduced";
      }
    } finally {
      try { await cleanup(); }
      catch (error) { throw new CensusFixtureError("Trial cleanup is unknown", error, cleanup); }
      trial.cleanupConfirmed = true;
    }
  }
  report.sourceUnchanged = JSON.stringify(await manifest()) === JSON.stringify(source);
  if (!report.sourceUnchanged) throw new Error("Probe source changed during measurement");
  const [deferred, retained] = trials;
  if (deferred?.counterexample && retained?.state === "same identity exit measured") {
    report.state = "counterexample reproduced";
    // This validates a counterexample, never an unknown process-exit capability.
    exitCode = 0;
  } else report.state = "not measured: deferred acquisition failure was not reproduced";
} catch (error) {
  if (error instanceof CensusFixtureError) {
    try { await error.close(); } catch (cleanup) { report.cleanupError = String(cleanup); }
  }
  report.error = error instanceof Error ? error.message : String(error);
  report.state = "not measured: invalid or incomplete fixture";
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ total: exitCode === 0 ? 2 : 1, failed: exitCode === 0 ? 0 : 1, skipped: 0,
  state: report.state, capability: report.capability, output }));
process.exitCode = exitCode;
