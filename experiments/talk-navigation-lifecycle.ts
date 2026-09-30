import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Page, Request } from "playwright";
import { Sessions } from "../src/session";
import { BrowserBackend } from "../src/browser";
import { OrbitError } from "../src/errors";
import { requireResourceBudget } from "../src/resource-budget";

// Opt-in account diagnostic. It navigates only in an Orbit-owned profile copy,
// with the normal session policy and network lease. It records no URL paths,
// query strings, headers, request bodies, console text or account content.
if (process.env.ORBIT_REAL_PROFILE !== "1") throw new Error("Set ORBIT_REAL_PROFILE=1 for this account diagnostic");
await requireResourceBudget();
const root = await mkdtemp(join(homedir(), ".cache", "orbit-talk-lifecycle-"));
const sessions = new Sessions(root);
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
type RequestRecord = { id: number; origin: string; type: string; startMs: number; endMs?: number; status?: number; failure?: string };
const requests = new Map<Request, RequestRecord>();
const events: { event: string; atMs: number }[] = [];
let pageErrors = 0;
let consoleErrors = 0;
let start = Date.now();
let polling = false;
let poll: Promise<void> | undefined;
let frames = 0;
let frameErrors = 0;
const frameFailureCodes: Record<string, number> = {};
try {
  const created = await sessions.dispatch({ method: "session.create", params: {
    backend: "browser", agentName: "Codex", taskName: "Talk navigation lifecycle diagnostic", projectName: "sbar-orbit",
    cloneOf: join(homedir(), ".config", "chromium"), cloneExtensions: false,
    policy: { mode: "autonomous", origins: ["https://nxcloud.masaar.com", "https://gitlab.masaar.com"], allow: ["read", "navigate"] },
  } }) as { sessionId: string };
  // Instrument this experiment's owned backend only. No new public authority
  // or API is added to reach a browser outside this session.
  const registry = sessions as unknown as { sessions: Map<string, { backend: unknown }> };
  const backend = registry.sessions.get(created.sessionId)?.backend;
  if (!(backend instanceof BrowserBackend)) throw new Error("Missing owned browser backend");
  const page = (backend as unknown as { page: Page }).page;
  start = Date.now();
  const mark = (event: string) => events.push({ event, atMs: Date.now() - start });
  page.on("domcontentloaded", () => mark("domcontentloaded"));
  page.on("load", () => mark("load"));
  page.on("pageerror", () => { pageErrors++; });
  page.on("console", message => { if (message.type() === "error") consoleErrors++; });
  page.on("request", request => {
    let origin: string;
    try { origin = new URL(request.url()).origin; } catch { origin = "unparseable"; }
    requests.set(request, { id: requests.size + 1, origin, type: request.resourceType(), startMs: Date.now() - start });
  });
  page.on("response", response => { const item = requests.get(response.request()); if (item) item.status = response.status(); });
  page.on("requestfinished", request => { const item = requests.get(request); if (item) item.endMs = Date.now() - start; });
  page.on("requestfailed", request => {
    const item = requests.get(request);
    if (item) { item.endMs = Date.now() - start; item.failure = request.failure()?.errorText.match(/net::[A-Z_]+/)?.[0] ?? "failed"; }
  });
  if (process.env.ORBIT_DIAGNOSTIC_VIEWER === "1") {
    polling = true;
    poll = (async () => {
      while (polling) {
        try { await sessions.dispatch({ method: "session.observe", params: { sessionId: created.sessionId } }); frames++; }
        catch (error) {
          frameErrors++;
          const code = error instanceof OrbitError ? error.code : "unexpected-error";
          frameFailureCodes[code] = (frameFailureCodes[code] ?? 0) + 1;
        }
        if (polling) await Bun.sleep(1000);
      }
    })();
  }
  try {
    await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
      action: { type: "navigate", url: "https://nxcloud.masaar.com/index.php/apps/spreed/" } } });
    report.navigation = "success";
  } catch (error) { report.navigation = error instanceof OrbitError ? error.code : "unexpected-error"; }
  report.actionSettledMs = Date.now() - start;
  report.stateAtActionSettle = await page.evaluate(() => document.readyState).catch(() => "unavailable");
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  report.stateAfterWait = await page.evaluate(() => document.readyState).catch(() => "unavailable");
  report.navigationTiming = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry ? { responseStart: entry.responseStart, responseEnd: entry.responseEnd, domInteractive: entry.domInteractive,
      domContentLoadedEventStart: entry.domContentLoadedEventStart, loadEventStart: entry.loadEventStart } : null;
  }).catch(() => null);
  const values = [...requests.values()];
  report.events = events;
  report.requests = values.length;
  report.failedRequests = values.filter(item => item.failure !== undefined).length;
  report.pending = Object.fromEntries([...new Set(values.map(item => item.type))]
    .map(type => [type, values.filter(item => item.type === type && item.endMs === undefined).length]));
  report.slowest = values.filter(item => item.endMs !== undefined)
    .sort((a, b) => ((b.endMs ?? 0) - b.startMs) - ((a.endMs ?? 0) - a.startMs)).slice(0, 15);
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  report.journal = await sessions.dispatch({ method: "session.journal", params: { sessionId: created.sessionId } })
    .then(value => (value as { blockedOrigins?: string[] }).blockedOrigins ?? []);
  polling = false;
  await poll;
  report.framePolling = { enabled: process.env.ORBIT_DIAGNOSTIC_VIEWER === "1", frames, errors: frameErrors, failureCodes: frameFailureCodes };
} finally {
  polling = false;
  await sessions.close();
  await poll;
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
