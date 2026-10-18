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
  const checkpoint = (phase: string) => Bun.write(join(output, "latest.json"), JSON.stringify({ status: "running", pid: process.pid, profileRoot: root, phase }) + "\n");
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
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(Bun.file(join(import.meta.dir, "fixture.html"))),
  });
  const processStats = async () => {
    let rss = 0;
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
    try {
      const rssKiB = await processStats();
      if (samples.length < 1024) samples.push({ at: performance.now() - started, rssKiB });
      else monitorErrors++;
    } catch { monitorErrors++; }
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
    report = { status: "failed", error: String(error) };
    throw error;
  } finally {
    await checkpoint("cleanup");
    await Promise.allSettled(ownedBrowsers.map(owned => owned.close()));
    monitoring = false;
    await monitor;
    await sample();
    observer?.close();
    server.stop(true);
    const gaps = samples.slice(1).map((s, i) => s.at - (samples[i]?.at ?? s.at));
    const final = { ...report, date: "2026-09-10", platform: process.platform,
      elapsedMs: Math.round(performance.now() - started), samples: samples.length, monitorErrors,
      maxSampleGapMs: Math.round(Math.max(0, ...gaps)),
      peakMatchedProcessRssMiB: Math.round(Math.max(0, ...samples.map(s => s.rssKiB)) / 1024),
      residualMatchedProcessRssKiB: await processStats(),
      profileRoot: root,
      limitations: ["Polling can miss transient windows or focus changes.",
        "RSS includes only processes whose command line contains an owned profile, not the full browser tree.",
        "No personal desktop is queried; personal focus and visibility are not measured.",
        "Owned private compositor measurements require an admitted factory fixture; absent metrics are not a pass.",
        "No native desktop backend, live viewer, real account or agent-host connector tested.",
        "Temporary test profiles are never reused as personal profiles; sbar-orbit clean removes them after an hour."],
    };
    await Bun.write(join(output, "latest.json"), JSON.stringify(final, null, 2) + "\n");
    console.log(JSON.stringify(final, null, 2));
  }
}

test("independent background browsers preserve their state and stop independently", () => runBrowserExperiment(), 60000);

