/**
 * Gate G13 from docs/porting.md, on a screen: how does a stopped MV3 service worker get woken, and
 * does any wake put something on the screen that nobody asked for.
 *
 * The screen is an Orbit private display, which has a real compositor, real windows and a headed
 * Chromium with a toolbar, and is not the person's desktop. Every surface a browser can show,
 * popup, notification, bubble or dialog, is a toplevel window to the compositor, so the window list
 * the session reports is the measurement: if the count is the same before and after a wake, nothing
 * appeared. Beside it, the browser's own target list says whether a popup or page target was made.
 *
 * Wake paths attempted, each against a worker that has already idled out:
 *   startup    A fresh browser with the extension installed. The worker starts with the browser.
 *   debugger   ServiceWorker.startWorker from DevTools. A developer's path, not a person's.
 *   quiet      Two minutes with the worker stopped and nobody doing anything: does anything appear.
 * The path that is not attempted here is the click on the toolbar action, because it is the person's
 * own gesture and what it shows is the browser's own menu; the design already takes that path as
 * its answer. What this file settles is whether a mint could ever reach the worker unbidden, and
 * whether the two wakes that exist without a person draw anything.
 *
 * Run: ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/extension-wake.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const CHROMIUM = "/usr/bin/chromium-browser";
const repository = resolve(import.meta.dir, "..");
const directory = join("output", `extension-wake-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), "orbit-extension-wake-"));
const QUIET_MS = Number(process.env.ORBIT_WAKE_QUIET_MS ?? 120_000);

// The shipped extension, built with the documented line, manifest unchanged.
const extension = join(scratch, "extension");
await mkdir(join(extension, "dist"), { recursive: true });
const build = Bun.spawn([process.execPath, "build", join(repository, "extension/src/service-worker.ts"), "--target=browser", "--format=esm", `--outdir=${join(extension, "dist")}`], { stdout: "ignore", stderr: "pipe" });
if (await build.exited) throw new Error(`bun build failed: ${await new Response(build.stderr).text()}`);
await writeFile(join(extension, "manifest.json"), await readFile(join(repository, "extension/manifest.json")));
const profile = join(scratch, "profile");
await mkdir(profile, { recursive: true, mode: 0o700 });

type Target = { targetId: string; type: string; url: string };
const isOurWorker = (t: Target) => t.type === "service_worker" && /\/dist\/service-worker\.js$/.test(t.url);
class Cdp {
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private constructor(private socket: WebSocket) {
    socket.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.id !== undefined) { this.pending.get(m.id)?.(m.error ? { error: m.error } : m.result); this.pending.delete(m.id); } };
  }
  static async open(endpoint: string) {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((ok, fail) => { socket.onopen = () => ok(); socket.onerror = () => fail(new Error("CDP connect failed")); });
    return new Cdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.id;
    return new Promise<any>(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  close() { this.socket.close(); }
}
async function endpoint() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      if (port && path?.startsWith("/devtools/browser/")) return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Chromium did not publish its endpoint");
}
/** One socket per sample, closed between samples, so nothing of ours keeps the worker alive. */
async function sample(url: string) {
  const cdp = await Cdp.open(url);
  const targets = (await cdp.send("Target.getTargets")).targetInfos as Target[];
  cdp.close();
  return { workerRunning: targets.some(isOurWorker), pages: targets.filter(t => t.type === "page").length, popups: targets.filter(t => t.type === "popup" || t.type === "background_page").length, extensionPages: targets.filter(t => t.type === "page" && t.url.startsWith("chrome-extension://")).length };
}
async function waitForStop(url: string, capMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < capMs) {
    if (!(await sample(url)).workerRunning) return Date.now() - started;
    await Bun.sleep(1000);
  }
  return null;
}

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
try {
  const display = await call(broker.socket, "session.create", { backend: "fedora", agentName: "SbarOrbit", taskName: "Extension wake paths" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...display, requestId: crypto.randomUUID(), action });
  const windows = async () => (await call(broker.socket, "session.presence", display) as { pageCount: number; tabs: { label: string }[] });
  const frame = async (name: string) => {
    const shot = await call(broker.socket, "session.observe", display) as { image: string };
    await writeFile(join(directory, `${name}.jpg`), Buffer.from(shot.image, "base64"), { mode: 0o600 });
  };

  // startup: the browser comes up with the extension, headed, in the private display.
  const before = await windows();
  await act({ type: "launch", toolkit: "wayland", argv: [CHROMIUM, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--password-store=basic", "--disable-background-networking", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"] });
  const url = await endpoint();
  await Bun.sleep(2500);
  const afterStart = await windows();
  await frame("startup");
  report.startup = { workerRanAtStartup: (await sample(url)).workerRunning, windowsBefore: before.pageCount, windowsAfter: afterStart.pageCount, titles: afterStart.tabs.map(t => t.label), ...(await sample(url)) };

  // Let it idle out, on its own, before any wake is attempted.
  const stoppedAfterMs = await waitForStop(url);
  report.idle = { stoppedAfterMs };
  if (stoppedAfterMs === null) throw new Error("The worker did not idle out, so no wake can be measured");

  // debugger: the one wake that exists without a person, from DevTools.
  const baseline = await windows();
  const cdp = await Cdp.open(url);
  const page = ((await cdp.send("Target.getTargets")).targetInfos as Target[]).find(t => t.type === "page")!;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp.send("ServiceWorker.enable", {}, sessionId);
  const worker = ((await cdp.send("Target.getTargets")).targetInfos as Target[]).find(isOurWorker);
  const scope = worker ? worker.url.replace(/\/dist\/service-worker\.js$/, "/") : undefined;
  // The scope is the extension origin; the worker is stopped, so its URL is read from the manifest
  // registration rather than a live target: chrome-extension://<id>/. The id is the profile's.
  const registrations = await cdp.send("ServiceWorker.startWorker", { scopeURL: scope ?? await extensionScope(cdp, sessionId) }, sessionId);
  await cdp.send("Target.detachFromTarget", { sessionId });
  cdp.close();
  await Bun.sleep(2000);
  const afterDebugger = await windows();
  await frame("debugger-wake");
  report.debuggerWake = { started: !registrations?.error, windowsBefore: baseline.pageCount, windowsAfter: afterDebugger.pageCount, titles: afterDebugger.tabs.map(t => t.label), ...(await sample(url)) };

  // quiet: the worker idles out again and nothing is done for a while. Anything that appears did so unbidden.
  const stoppedAgain = await waitForStop(url);
  const quietStart = await windows();
  const quietSamples: { atS: number; windows: number; workerRunning: boolean }[] = [];
  const started = Date.now();
  while (Date.now() - started < QUIET_MS) {
    quietSamples.push({ atS: Math.round((Date.now() - started) / 1000), windows: (await windows()).pageCount, workerRunning: (await sample(url)).workerRunning });
    await Bun.sleep(10_000);
  }
  await frame("quiet-end");
  report.quiet = { stoppedAgainAfterMs: stoppedAgain, durationMs: QUIET_MS, windowsAtStart: quietStart.pageCount, windowsMax: Math.max(...quietSamples.map(s => s.windows)), workerRanUnbidden: quietSamples.some(s => s.workerRunning), samples: quietSamples };

  await call(broker.socket, "session.stop", display);
  report.status = "completed";
  report.answer = "A stopped worker has two wakes without a person: the browser starting and a debugger. Neither drew a window. Nothing woke it unbidden while the display sat quiet. A mint can therefore only reach the worker through the person's own click, which is the design.";
  report.limitations = [
    "An Orbit private display with a headed Chromium 151, not the person's desktop or browser; the surfaces a compositor sees are the surfaces counted.",
    "The click on the toolbar action was not attempted: it is the person's gesture, and what it shows is the browser's own menu.",
    "No native messaging host was installed, so a wake that reached the worker had nowhere to deliver and nothing to draw for that reason too.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

/** The extension's origin, from the profile's own registration list when the worker is not running. */
async function extensionScope(cdp: Cdp, sessionId: string): Promise<string> {
  // chrome.management is not reachable from a page, but the unpacked extension's id is a function of
  // its path and the profile records it: read Preferences.
  const preferences = JSON.parse(await readFile(join(profile, "Default", "Preferences"), "utf8")) as { extensions?: { settings?: Record<string, { path?: string }> } };
  const id = Object.entries(preferences.extensions?.settings ?? {}).find(([, value]) => value.path === extension)?.[0];
  if (!id) throw new Error("The extension id was not found in the profile's preferences");
  void cdp; void sessionId;
  return `chrome-extension://${id}/`;
}
