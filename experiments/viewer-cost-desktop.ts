/**
 * Roadmap gate 1, read on the person's own desktop: the viewer's per-frame cost line, from the
 * viewer window Orbit opens there, on their compositor, their display and their GPU.
 *
 * The person asked for this to be done for them, so the window appears on their screen for the
 * length of the reading and is closed afterwards. It is the viewer's own window in Orbit's own
 * browser profile, opened with the command `preview open` builds plus one flag,
 * `--remote-debugging-port=0`, which is how the `#cost` element is read from outside rather than
 * by eye. The viewer shows one browser session created for the purpose and stopped at the end.
 *
 * The desktop environment comes from the user manager, `systemctl --user show-environment`, which
 * is where the broker service gets it too, and the browser runs in a transient scope of its own so
 * it is not charged to the agent's budget and does not outlive this file.
 *
 * Run: bun run experiments/viewer-cost-desktop.ts
 */
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { call } from "../src/ipc";
import { listHostBrowsers, pickBrowser, viewerCommand, viewerPreference, viewerProfileDirectory } from "../src/host-browsers";

const socket = process.env.ORBIT_SOCKET ?? join(process.env.XDG_RUNTIME_DIR ?? "/run/user/1000", "sbar-orbit", "broker.sock");
const DURATION_MS = Number(process.env.ORBIT_COST_DURATION_MS ?? 60_000);
const directory = join("output", `viewer-cost-desktop-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

const environment = Object.fromEntries((await new Response(Bun.spawn(["/usr/bin/systemctl", "--user", "show-environment"], { stdout: "pipe" }).stdout).text())
  .split("\n").filter(line => line.includes("=")).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
report.compositor = environment.XDG_CURRENT_DESKTOP ?? environment.DESKTOP_SESSION ?? "unknown";

const preference = await viewerPreference();
const browser = pickBrowser(await listHostBrowsers(), preference.browser, preference.appWindow);
if (!browser) throw new Error("No browser on this desktop can open the viewer");
const profile = viewerProfileDirectory(browser);
await mkdir(profile, { recursive: true, mode: 0o700 });
await rm(join(profile, "DevToolsActivePort"), { force: true });
report.browser = { id: browser.id, name: browser.name, appWindow: browser.appWindow && preference.appWindow, profile: profile.replace(process.env.HOME ?? "", "~") };

const watched = await call(socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Viewer cost on the desktop", conversationName: "Viewer cost reading" }) as { sessionId: string };
let unit: string | undefined;
try {
  const { url } = await call(socket, "preview.open") as { url: string };
  const command = viewerCommand(browser, url, preference.appWindow, profile);
  const argv = [command[0]!, "--remote-debugging-port=0", ...command.slice(1)];
  report.command = argv.map(part => part.replace(/#.*$/, "#<token>"));
  unit = `sbar-orbit-viewer-cost-${crypto.randomUUID().slice(0, 8)}.scope`;
  const opened = performance.now();
  Bun.spawn(["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--expand-environment=no", ...argv],
    { env: { ...process.env, ...environment }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 20_000;
  let port: string | undefined;
  while (!port && Date.now() < deadline) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n")[0]; } catch {}
    if (!port) await Bun.sleep(100);
  }
  if (!port) throw new Error("The viewer browser did not publish its endpoint");
  let page: { webSocketDebuggerUrl: string } | undefined;
  const find = Date.now() + 15_000;
  while (!page && Date.now() < find) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
    page = list.find(target => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
    if (!page) await Bun.sleep(200);
  }
  if (!page) throw new Error("The viewer page was not found in the viewer browser");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error("CDP connect failed")); });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  ws.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id !== undefined) pending.get(message.id)?.(message.result); };
  const evaluate = (expression: string) => new Promise<any>(resolve => {
    const n = ++id; pending.set(n, result => resolve(result?.result?.value));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  await evaluate(`new Promise(r => { const t = setInterval(() => { const f = document.querySelector('#frame'); if (f && !f.hidden && Number(f.dataset.capturedAt) > 0) { clearInterval(t); r(true); } }, 100); setTimeout(() => { clearInterval(t); r(false); }, 30000); })`);
  report.windowReadyMs = Math.round(performance.now() - opened);
  report.window = { standalone: await evaluate("matchMedia('(display-mode: standalone)').matches"), title: await evaluate("document.title"),
    innerSize: await evaluate("[innerWidth, innerHeight]"), devicePixelRatio: await evaluate("devicePixelRatio"), screen: await evaluate("[screen.width, screen.height]") };
  const samples: { atS: number; cost: string }[] = [];
  const started = Date.now();
  while (Date.now() - started < DURATION_MS) {
    samples.push({ atS: Math.round((Date.now() - started) / 1000), cost: String(await evaluate("document.querySelector('#cost')?.textContent?.trim() ?? ''")) });
    await Bun.sleep(5000);
  }
  ws.close();
  report.costSamples = samples;
  const ms = samples.map(s => Number(/cycle: (\d+) ms/.exec(s.cost)?.[1])).filter(n => Number.isFinite(n));
  report.costCycleMs = ms.length ? { min: Math.min(...ms), max: Math.max(...ms), last: ms.at(-1) } : null;
  report.status = "completed";
  report.limitations = [
    "Read by this file through DevTools from the same #cost element the person would read by eye; the window was on the person's desktop, on their compositor and display, for the duration.",
    "One browser session on a blank page; a native session or a busy page costs more per frame.",
    "The viewer's own report of its per-frame work, not the browser process outside the page nor the compositor.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  // The window is the person's screen; it is closed as soon as the reading is done.
  if (unit) await Bun.spawn(["/usr/bin/systemctl", "--user", "stop", unit], { stdout: "ignore", stderr: "ignore" }).exited;
  await call(socket, "session.stop", watched).catch(() => {});
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
