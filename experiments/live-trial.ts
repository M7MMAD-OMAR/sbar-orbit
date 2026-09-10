import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

/**
 * A scripted live trial that measures what an Orbit session actually costs, and records whether
 * the host pointer moves while the agent works. It never drives a personal browser or the host
 * mouse: the owned browser is headless and its input is injected over CDP into that page alone.
 */
await requireResourceBudget();
const directory = join("output", `live-trial-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });

/** The host cursor, read only. Window titles are never requested or retained. */
async function hostCursor(): Promise<{ x: number; y: number } | null> {
  try {
    const child = Bun.spawn(["hyprctl", "cursorpos"], { stdout: "pipe", stderr: "ignore" });
    const [x, y] = (await new Response(child.stdout).text()).trim().split(",").map(value => Number(value.trim()));
    return Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null;
  } catch { return null; }
}

const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  `<html><title>Orbit live trial</title><style>body{font:20px system-ui;padding:32px;background:#f6f7f9;color:#182d45}
   input,button{font:20px system-ui;padding:10px;margin:6px}section{margin:20px 0;padding:16px;border:1px solid #ccd}</style>
   <h1>Orbit live trial</h1>
   <section><h2>Agent work</h2><input id="field"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#field').value">Save</button>
   <output id="result">Waiting</output></section>
   <section style="height:1200px"><h2>Scrollable area</h2><p>The agent scrolls this region while the sampler runs.</p></section></html>`,
  { headers: { "Content-Type": "text/html" } }) });

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), backend: "browser" };
let viewer: Awaited<ReturnType<typeof launchChrome>> | undefined;
try {
  const session = await call(broker.socket, "session.create",
    { backend: "browser", agentName: "SbarOrbit", taskName: "Live cost trial" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  const observe = () => call(broker.socket, "session.observe", session) as Promise<{ presence: { pointer: { x: number; y: number } | null } }>;
  await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` });

  /** Drive the agent for the given seconds, sampling the Orbit cgroup and the host pointer. */
  /** Cost of an open session doing nothing, which is what "always available" actually costs. */
  async function idlePhase(name: string, seconds: number) {
    const before = await readCpuSample();
    await Bun.sleep(seconds * 1000);
    const after = await readCpuSample();
    return { name, seconds, agentSteps: 0, ...cpuInterval(before, after) };
  }

  async function phase(name: string, seconds: number) {
    const hostBefore = await hostCursor();
    const cursorSamples: string[] = [];
    const before = await readCpuSample();
    const deadline = performance.now() + seconds * 1000;
    let steps = 0;
    while (performance.now() < deadline) {
      const value = `Agent step ${++steps}`;
      await act({ type: "fill", selector: "#field", text: value });
      await act({ type: "click", selector: "#save" });
      await act({ type: "scroll", x: 400, y: 300, deltaY: steps % 2 ? 3 : -3 });
      const at = await hostCursor();
      if (at) cursorSamples.push(`${at.x},${at.y}`);
    }
    const after = await readCpuSample();
    const hostAfter = await hostCursor();
    const distinct = [...new Set(cursorSamples)];
    return { name, seconds, agentSteps: steps, ...cpuInterval(before, after),
      hostCursorBefore: hostBefore, hostCursorAfter: hostAfter,
      hostCursorSamples: cursorSamples.length, hostCursorDistinctPositions: distinct.length };
  }

  const idleNoViewer = await idlePhase("idle-session-no-viewer", 20);
  const agentOnly = await phase("agent-working-no-viewer", 20);

  // Attach the viewer in an owned headless browser, at the shipped 1 FPS default.
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  viewer = await launchChrome(await createWorkspaceDirectory("live-trial-viewer"));
  const page = viewer.page;
  const viewerErrors: string[] = [];
  page.on("pageerror", error => viewerErrors.push(String(error)));
  await page.goto(url);
  await page.locator("#frame").waitFor({ state: "visible", timeout: 20000 });
  const idleWithViewer = await idlePhase("idle-session-viewer-attached-1fps", 20);
  const withViewer = await phase("agent-working-viewer-attached-1fps", 20);
  const costLine = await page.locator("#cost").textContent();

  // The pointer overlay hides once a frame goes stale, so capture it under Smooth on demand.
  await page.selectOption("#preview-mode", "smooth");
  await act({ type: "click", selector: "#field" });
  let pointer: { x: number; y: number } | null = null;
  for (let i = 0; i < 60 && !pointer; i++) { pointer = (await observe()).presence.pointer; await Bun.sleep(150); }
  await page.waitForFunction(() => !document.querySelector("#agent-pointer")?.hasAttribute("hidden"), undefined, { timeout: 20000 }).catch(() => {});
  const overlayVisible = await page.evaluate(() => !document.querySelector("#agent-pointer")?.hasAttribute("hidden"));
  const smoothCost = await page.locator("#cost").textContent();
  await page.screenshot({ path: join(directory, "viewer-agent-pointer.png"), fullPage: true });

  Object.assign(report, { status: "passed", phases: [idleNoViewer, agentOnly, idleWithViewer, withViewer],
    note: "The working phases drive actions as fast as the broker accepts them, far faster than a real agent. Treat them as an upper bound, not a typical rate.",
    viewerCostAtDefault: costLine, viewerCostAtSmooth: smoothCost,
    agentPointerReported: pointer, agentPointerOverlayVisible: overlayVisible, viewerPageErrors: viewerErrors,
    hostPointerMoved: agentOnly.hostCursorDistinctPositions > 1 || withViewer.hostCursorDistinctPositions > 1,
    limitations: [
      "The viewer here is owned headless Chrome inside the Orbit cgroup, so the with-viewer figure includes it. The reported participant case had a desktop viewer outside that cgroup.",
      "Desktop compositing on this workstation's mixed 4K and 240 Hz fractional-scaling displays is not measured here.",
      "Host pointer sampling is read only and coarse; it shows the pointer did not move, not that movement is impossible.",
      "One host, one fixture page, scripted agent work, no human participant.",
    ] });
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (viewer) await viewer.close();
  await broker.close();
  fixture.stop(true);
}
