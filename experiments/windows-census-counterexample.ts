/** Opt-in evidence probe. This does not repair or certify the production collector. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";
import { assertSameIdentity, CensusFixtureError, createCensusChild } from "../tests/windows-census-fixture";
import { captureProcessWitnesses, WitnessCaptureError } from "../tests/windows-process-witness";

const paths = ["experiments/windows-census-counterexample.ts", "tests/windows-census-fixture.ts",
  "tests/windows-process-witness.ts", "tests/browser-crash.test.ts", "tests/windows-census-controls.test.ts",
  "tests/windows-crash-evidence.test.ts", "tests/windows-witness-race.test.ts",
  "src/resource-budget.ts", "src/windows-job.ts", "src/errors.ts", "src/cpu-sample.ts",
  "src/service.ts", "src/autostart.ts", "src/macos.ts", "src/macos-budget.ts", "src/macos-scheduling.ts",
  "scripts/limited.ts", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json",
  ".github/workflows/windows-census-counterexample.yml", ".github/workflows/verify.yml",
  "docs/windows-census-counterexample.md", "docs/support-tiers.md", "AGENTS.md",
  ".gitattributes", "bin/sbar-orbit.cmd", "install.cmd"];
const cmdPaths = new Set(["bin/sbar-orbit.cmd", "install.cmd"]);
async function manifest() {
  const attributes = await readFile(".gitattributes", "utf8");
  if (!attributes.split(/\r?\n/).includes("*.cmd text eol=crlf"))
    throw new Error("Declared cmd checkout attributes changed");
  const canonical: Record<string, string> = {}, checkout: Record<string, string> = {};
  for (const path of paths) {
    const raw = await readFile(path);
    checkout[path] = createHash("sha256").update(raw).digest("hex");
    let bytes = raw;
    if (cmdPaths.has(path)) {
      if (raw.some(byte => byte > 127)) throw new Error("Known cmd source must be ASCII");
      const text = raw.toString("ascii").replace(/\r\n/g, "\n");
      if (text.includes("\r")) throw new Error("Known cmd source has unexpected bare CR");
      bytes = Buffer.from(text, "ascii");
    }
    canonical[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return { canonical, checkout };
}
type ProbeDependencies = {
  createChild: typeof createCensusChild;
  resourceBudget: typeof requireResourceBudget;
  sourceManifest: typeof manifest;
  writeReport: typeof writeFile;
  environment: { platform: string; arch: string; optIn: string | undefined; bunVersion: string };
};

function failureEvidence(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth >= 16 || seen.has(value)) return { message: "Nested failure evidence limit reached" };
  if (!(value instanceof Error)) return { value: String(value) };
  seen.add(value);
  return { name: value.name, message: value.message, stack: value.stack,
    ...(value instanceof AggregateError ? { errors: [...value.errors].map(error => failureEvidence(error, seen, depth + 1)) } : {}),
    ...(value.cause !== undefined ? { cause: failureEvidence(value.cause, seen, depth + 1) } : {}) };
}

export async function runCensusCounterexample(output: string, overrides: Partial<ProbeDependencies> = {}) {
  if (process.env.ORBIT_TEST_NATIVE === "1") throw new Error("Native activation is held before any process creation");
  const dependencies: ProbeDependencies = {
    createChild: createCensusChild, resourceBudget: requireResourceBudget, sourceManifest: manifest, writeReport: writeFile,
    environment: { platform: process.platform, arch: process.arch, optIn: process.env.ORBIT_WINDOWS_CENSUS_PROBE, bunVersion: Bun.version },
    ...overrides,
  };
  if (!output || !isAbsolute(output)) throw new Error("An absolute owned report destination is required");
  const report: Record<string, unknown> = { state: "not measured", capability: "unknown", limit:
    "Two controlled owned-child trials. Collector unchanged; no browser, compositor, host integration or production cleanup claim." };
  let exitCode = 2;
  let retryOwnedCleanup: (() => Promise<void>) | undefined;
  try {
    if (dependencies.environment.platform !== "win32" || dependencies.environment.arch !== "x64" || dependencies.environment.optIn !== "1")
      throw new Error("Actual Windows x64 opt-in prerequisite is not measured");
    await dependencies.resourceBudget();
    const source = await dependencies.sourceManifest();
    report.environment = { platform: dependencies.environment.platform, arch: dependencies.environment.arch, bunVersion: dependencies.environment.bunVersion };
    report.source = source.canonical;
    report.checkoutSource = source.checkout;
    report.sourceContract = "Canonical exact bytes except ASCII CRLF to LF for bin/sbar-orbit.cmd and install.cmd under declared *.cmd text eol=crlf; checkout hashes remain raw";
    const trials: Record<string, unknown>[] = [];
    report.trials = trials;
    const captureStarted = performance.now();
    const captureDeadline = captureStarted + 14000;
    report.acquisitionDeadlineMilliseconds = 14000;
    for (const mode of ["deferred", "retained"] as const) {
      let fixture: Awaited<ReturnType<typeof createCensusChild>> | undefined;
      let witnesses: ReturnType<typeof captureProcessWitnesses> | undefined;
      let retained: number | undefined, transferred = false, looseClosed = false;
      let retryCaptureClose: (() => void) | undefined;
      const trial: Record<string, unknown> = { mode, state: "unknown", events: [] };
      const events = trial.events as string[];
      const started = performance.now();
      trial.startedAtAcquisitionMilliseconds = started - captureStarted;
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
      let primaryFailure: unknown;
      let hasPrimaryFailure = false;
      try {
        fixture = await dependencies.createChild(captureDeadline);
        trial.live = fixture.live;
        trial.liveAtAcquisitionMilliseconds = performance.now() - captureStarted;
        const row = Object.freeze({ pid: fixture.live.pid, parentPid: fixture.live.parentPid });
        trial.census = [row];
        events.push("owned live row emitted, creator handles closed");
        if (mode === "retained") {
          trial.acquisitionAtMilliseconds = performance.now() - captureStarted;
          retained = fixture.witnessApi.open(row.pid);
          assertSameIdentity(fixture.witnessApi.identity(retained), fixture.live);
          if (fixture.witnessApi.state(retained).state !== "alive") throw new Error("Retained fixture child exited before acquisition acknowledgment");
          events.push("same live creation identity retained before exit gate");
        }
        trial.exitGateAtMilliseconds = performance.now() - captureStarted;
        await fixture.release();
        trial.jobExit = await fixture.waitExited();
        trial.jobEmptyAtMilliseconds = performance.now() - captureStarted;
        if (performance.now() >= captureDeadline) throw new Error("Controlled census capture deadline expired");
        events.push("private owned job confirmed empty before census completion");
        await Bun.sleep(25);
        if (performance.now() >= captureDeadline) throw new Error("Controlled census completion deadline expired");
        trial.censusCompleteAtMilliseconds = performance.now() - captureStarted;
        events.push("census completion delivered");
        try {
          if (mode === "deferred") trial.acquisitionAtMilliseconds = performance.now() - captureStarted;
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
      } catch (error) {
        primaryFailure = error;
        hasPrimaryFailure = true;
        trial.primaryError = failureEvidence(error);
        throw error;
      } finally {
        try { await cleanup(); }
        catch (error) {
          trial.cleanupError = failureEvidence(error);
          throw new CensusFixtureError(hasPrimaryFailure ? primaryFailure : "Trial cleanup is unknown", error, cleanup);
        }
        trial.cleanupConfirmed = true;
        trial.cleanup = fixture?.cleanupReceipt;
        trial.witnessCleanupConfirmed = true;
        trial.elapsedMilliseconds = performance.now() - started;
      }
    }
    report.elapsedMilliseconds = performance.now() - captureStarted;
    report.sourceUnchanged = JSON.stringify(await dependencies.sourceManifest()) === JSON.stringify(source);
    report.checkoutSourceUnchanged = report.sourceUnchanged;
    if (!report.sourceUnchanged) throw new Error("Probe source changed during measurement");
    const [deferred, retained] = trials;
    const deferredLive = deferred?.live as { pid: number; creationTicks: string } | undefined;
    const retainedLive = retained?.live as { pid: number; creationTicks: string } | undefined;
    if (!deferredLive || !retainedLive ||
      (deferredLive.pid === retainedLive.pid && deferredLive.creationTicks === retainedLive.creationTicks))
      throw new Error("Separate trials must have distinct actual creation identities");
    if (deferred?.counterexample && retained?.state === "same identity exit measured") {
      report.state = "counterexample reproduced";
      // This validates a counterexample, never an unknown process-exit capability.
      exitCode = 0;
    } else report.state = "not measured: deferred acquisition failure was not reproduced";
  } catch (error) {
    report.failure = failureEvidence(error);
    if (error instanceof CensusFixtureError) {
      retryOwnedCleanup = error.close;
      report.primaryError = failureEvidence(error.errors[0]);
      report.cleanupError = failureEvidence(error.errors[1]);
      try { await error.close(); retryOwnedCleanup = undefined; report.cleanupRetryConfirmed = true; }
      catch (cleanup) { report.cleanupRetryConfirmed = false; report.cleanupRetryError = failureEvidence(cleanup); }
    }
    report.error = error instanceof Error ? error.message : String(error);
    report.state = "not measured: invalid or incomplete fixture";
  } finally {
    await dependencies.writeReport(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  return { report, exitCode, retryCleanup: retryOwnedCleanup, summary: { total: exitCode === 0 ? 2 : 1, failed: exitCode === 0 ? 0 : 1, skipped: 0,
    state: report.state, capability: report.capability, output } };
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw new Error("An absolute owned report destination is required");
  const result = await runCensusCounterexample(output);
  console.log(JSON.stringify(result.summary));
  process.exitCode = result.exitCode;
}
