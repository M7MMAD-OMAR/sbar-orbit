import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { type BrowserContext } from "playwright";
import { launchChrome } from "../src/chrome";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { admitExperimentObserver, type ExperimentObserverFactory } from "./owned-browser-observation";

// Functional browser evidence and compositor evidence have separate admission.
// No ambient compositor is queried, even when hyprctl exists on PATH.
export async function runBrowserExperiment(observerFactory?: ExperimentObserverFactory) {
  const output = join(import.meta.dir, "../output/playwright");
  await mkdir(output, { recursive: true });
  const root = await createWorkspaceDirectory("browser-experiment");
  const profiles = [join(root, "a"), join(root, "b")];
  await Bun.write(join(output, "latest.json"), JSON.stringify({ status: "running", pid: process.pid, profileRoot: root, startedAt: new Date().toISOString() }) + "\n");
  let currentPhase = "before-launch";
  const checkpoint = (phase: string) => {
    currentPhase = phase;
    return Bun.write(join(output, "latest.json"), JSON.stringify({ status: "running", pid: process.pid, profileRoot: root, phase }) + "\n");
  };
  const contexts: BrowserContext[] = [];
  const ownedBrowsers: Awaited<ReturnType<typeof launchChrome>>[] = [];
  const started = performance.now();
  const samples: { at: number; rssKiB: number }[] = [];
  const owned = new Set<number>();
  let monitoring = true;
  let monitorErrors = 0;
  let focusErrors = 0;
  let focusMonitoring = true;
  let observer: ReturnType<typeof admitExperimentObserver> | undefined;
  const focusSamples: { activePid: number; clientPids: readonly number[] }[] = [];
  let report: Record<string, unknown> = {};
  let bodyFailed = false;
  let sampleOrdinal = 0;
  let rssBoundary: { stage: string; browserOrdinal?: number } = { stage: "before-sample" };
  const rssFailures: { originalError: unknown; sampleOrdinal: number; phaseAtStart: string;
    phaseAtCatch: string; stage: string; browserOrdinal?: number; samplerPid: number;
    observation: "sample" | "final-residual" }[] = [];
  let rssFailuresDropped = 0;
  const retainRssFailure = (originalError: unknown, ordinal: number, phaseAtStart: string,
    observation: "sample" | "final-residual" = "sample") => {
    if (rssFailures.length >= 32) { rssFailuresDropped++; return; }
    rssFailures.push({ originalError, sampleOrdinal: ordinal, phaseAtStart, phaseAtCatch: currentPhase,
      ...rssBoundary, samplerPid: process.pid, observation });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(Bun.file(join(import.meta.dir, "fixture.html"))),
  });
  const processStats = async () => {
    rssBoundary = { stage: "platform-admission" };
    if (process.platform !== "linux") {
      if (!["darwin", "win32"].includes(process.platform)) throw new Error("Browser experiment platform has no owned RSS sampler");
      let rssKiB = 0;
      for (const [index, browser] of ownedBrowsers.entries()) {
        rssBoundary = { stage: "owned-browser-rss", browserOrdinal: index + 1 };
        if (!browser.sampleResidentProcesses) throw new Error("Owned browser did not provide its platform RSS sampler");
        const sample = await browser.sampleResidentProcesses();
        rssBoundary = { stage: "returned-sample-validation", browserOrdinal: index + 1 };
        if (!Number.isFinite(sample.rssKiB) || sample.rssKiB < 0 || sample.pids.length > 512)
          throw new Error("Owned browser returned an invalid or oversized RSS sample");
        for (const pid of sample.pids) owned.add(pid);
        rssKiB += sample.rssKiB;
      }
      return rssKiB;
    }
    let rss = 0;
    rssBoundary = { stage: "linux-profile-processes" };
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmd = await readFile(`/proc/${entry}/cmdline`, "utf8");
        if (!profiles.some(profile => cmd.includes(`--user-data-dir=${profile}`))) continue;
        owned.add(Number(entry));
        const status = await readFile(`/proc/${entry}/status`, "utf8");
        rss += Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
      } catch { /* A process may exit between directory and status reads. */ }
    }
    return rss;
  };
  const sampleOnce = async () => {
    const ordinal = ++sampleOrdinal;
    const phaseAtStart = currentPhase;
    try {
      const rssKiB = await processStats();
      if (samples.length < 1024) samples.push({ at: performance.now() - started, rssKiB });
      else monitorErrors++;
    } catch (error) { monitorErrors++; retainRssFailure(error, ordinal, phaseAtStart); }
    if (observer && focusMonitoring) {
      try {
        const value = await observer.read();
        if (focusSamples.length < 1024) focusSamples.push(value);
        else focusErrors++;
      } catch { focusErrors++; }
    }
  };
  let sampling: Promise<void> | undefined;
  const sample = () => {
    if (sampling) return sampling;
    sampling = sampleOnce().finally(() => { sampling = undefined; });
    return sampling;
  };
  await sample();
  const monitor = (async () => {
    while (monitoring) { await sample(); await Bun.sleep(100); }
  })();
  try {
    for (const profile of profiles) {
      await checkpoint(`launch-${profile.endsWith("/a") ? "a" : "b"}`);
      await mkdir(profile, { mode: 0o700 });
      const owned = await launchChrome(profile, { width: 1040, height: 760 });
      ownedBrowsers.push(owned);
      contexts.push(owned.context);
    }
    for (const context of contexts) { context.setDefaultTimeout(3000); context.setDefaultNavigationTimeout(10000); }
    const ready = performance.now();
    const [contextA, contextB] = contexts;
    if (!contextA || !contextB) throw new Error("Two browser contexts required");
    if (observerFactory) {
      const identity = Object.freeze({ root, profiles: Object.freeze([...profiles]),
        contexts: Object.freeze([...contexts]), backends: Object.freeze([...ownedBrowsers]) });
      observer = admitExperimentObserver(identity, observerFactory);
    }
    const a = contextA.pages()[0];
    const b = contextB.pages()[0];
    if (!a || !b) throw new Error("Each context must contain a page");
    const url = `http://127.0.0.1:${server.port}`;
    await checkpoint("navigate");
    await Promise.all([a.goto(url), b.goto(url)]);
    await checkpoint("actions");
    const act = async (page: typeof a, prefix: string) => {
      for (let i = 1; i <= 12; i++) {
        await page.getByLabel("Session message").fill(`${prefix} ${i}`);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        expect(await page.locator("output").textContent()).toBe(`Saved: ${prefix} ${i}`);
      }
    };
    await Promise.all([act(a, "Agent A"), act(b, "Agent B")]);
    await Promise.all([a.reload(), b.reload()]);
    expect(await a.getByLabel("Session message").inputValue()).toBe("Agent A 12");
    expect(await b.getByLabel("Session message").inputValue()).toBe("Agent B 12");
    await a.getByRole("button", { name: "Save", exact: true }).click();
    await a.screenshot({ path: join(output, "agent-a.png") });
    const stopping = performance.now();
    await checkpoint("stop-a");
    await ownedBrowsers[0]?.close();
    const stopMs = performance.now() - stopping;
    await b.getByLabel("Session message").fill("Agent B still working");
    await b.getByRole("button", { name: "Save", exact: true }).click();
    expect(await b.locator("output").textContent()).toBe("Saved: Agent B still working");
    await b.screenshot({ path: join(output, "agent-b.png") });
    monitoring = false;
    await monitor;
    await sample();
    focusMonitoring = false;
    observer?.close();
    expect(owned.size).toBeGreaterThan(0);
    expect(samples.length).toBeGreaterThan(2);
    expect(monitorErrors).toBe(0);
    let focus: Record<string, unknown> = { status: "not measured", reason: "No factory-owned compositor observer admitted" };
    if (observer) {
      expect(focusSamples.length).toBeGreaterThan(2);
      expect(focusErrors).toBe(0);
      const activeHits = focusSamples.filter(s => owned.has(s.activePid)).length;
      const visibleHits = focusSamples.filter(s => s.clientPids.some(pid => owned.has(pid))).length;
      expect(activeHits).toBe(0);
      expect(visibleHits).toBe(0);
      focus = { status: "measured in owned private fixture", samples: focusSamples.length,
        monitorErrors: focusErrors, sampledFocusHits: activeHits, sampledVisibleWindowHits: visibleHits,
        personalDesktop: "not measured" };
    }
    expect(stopMs).toBeLessThan(5000);
    report = { status: "functional passed", browser: contextB.browser()?.version() ?? "Chrome persistent context",
      concurrentSessions: 2, submissions: 26, startupMs: Math.round(ready - started), stopMs: Math.round(stopMs),
      compositorObservation: focus };
  } catch (error) {
    bodyFailed = true;
    report = { status: "failed", error: String(error) };
    throw error;
  } finally {
    await checkpoint("cleanup");
    monitoring = false;
    await monitor;
    focusMonitoring = false;
    observer?.close();
    await Promise.allSettled(ownedBrowsers.map(owned => owned.close()));
    await sample();
    server.stop(true);
    let residualMatchedProcessRssKiB: number | "not measured" = "not measured";
    const residualPhaseAtStart = currentPhase;
    try { residualMatchedProcessRssKiB = await processStats(); }
    catch (error) { monitorErrors++; retainRssFailure(error, sampleOrdinal, residualPhaseAtStart, "final-residual"); }
    let finalSamplingFailure: Error | undefined;
    if (monitorErrors !== 0 || (observer && focusErrors !== 0)) {
      finalSamplingFailure = new Error("Browser experiment sampling failed");
      report = { ...report, status: "failed", samplingError: finalSamplingFailure.message,
        ...(!bodyFailed ? { error: finalSamplingFailure.message } : {}) };
    }
    const gaps = samples.slice(1).map((s, i) => s.at - (samples[i]?.at ?? s.at));
    const final = { ...report, date: "2026-09-10", platform: process.platform,
      elapsedMs: Math.round(performance.now() - started), samples: samples.length, monitorErrors,
      rssSamplingDiagnostics: { failures: rssFailures.map(({ originalError, ...metadata }) => {
        try {
          const ownText = (field: string, bound: number) => {
            if (!originalError || (typeof originalError !== "object" && typeof originalError !== "function")) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(originalError, field);
            const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
            return typeof value === "string" ? value.slice(0, bound) : undefined;
          };
          const name = ownText("name", 128);
          const message = typeof originalError === "string" ? originalError.slice(0, 1024) : ownText("message", 1024);
          const code = ownText("code", 128);
          return { ...metadata, originalError: { ...(name ? { name } : {}),
            ...(message !== undefined ? { message } : { status: "unavailable" }), ...(code ? { code } : {}) } };
        } catch { return { ...metadata, originalError: { status: "unavailable" } }; }
      }), dropped: rssFailuresDropped, limit: "Caught RSS errors only; bounded metadata; causal sampler branch remains unmeasured until reported." },
      maxSampleGapMs: Math.round(Math.max(0, ...gaps)),
      rssObservationSource: process.platform === "linux" ? "owned profile command line matched processes" :
        process.platform === "win32" ? "owned Windows job working set" : "owned macOS process group resident memory",
      ...(process.platform === "linux" ? {
        peakMatchedProcessRssMiB: Math.round(Math.max(0, ...samples.map(s => s.rssKiB)) / 1024), residualMatchedProcessRssKiB,
      } : { peakOwnedBoundaryResidentMiB: Math.round(Math.max(0, ...samples.map(s => s.rssKiB)) / 1024),
        residualOwnedBoundaryResidentKiB: residualMatchedProcessRssKiB }),
      profileRoot: root,
      limitations: ["Polling can miss transient windows or focus changes.",
        ...(process.platform === "linux" ? ["RSS includes only processes whose command line contains an owned profile, not the full browser tree."] :
          process.platform === "win32" ? ["RSS is the sum of resident working sets of members of the launch-owned job; shared pages may be counted more than once.",
            "After handle closure, zero uses the retained kernel-empty membership observation from confirmed stop, not a new live job read."] :
          ["RSS sums resident bytes of the launch-owned process group, including its supervisor; shared pages may be counted more than once.",
            "Process-group containment is best effort; an escaped descendant is outside this RSS tier."]),
        "No personal desktop is queried; personal focus and visibility are not measured.",
        "Owned private compositor measurements require an admitted factory fixture; absent metrics are not a pass.",
        "No native desktop backend, live viewer, real account or agent-host connector tested.",
        "Temporary test profiles are never reused as personal profiles; sbar-orbit clean removes them after an hour."],
    };
    await Bun.write(join(output, process.env.ORBIT_BROWSER_EXPERIMENT_OUTPUT === "provider.json" ? "provider.json" : "latest.json"), JSON.stringify(final, null, 2) + "\n");
    console.log(JSON.stringify(final, null, 2));
    if (finalSamplingFailure && !bodyFailed) throw finalSamplingFailure;
  }
}

test("independent background browsers preserve their state and stop independently", () => runBrowserExperiment(), 60000);
