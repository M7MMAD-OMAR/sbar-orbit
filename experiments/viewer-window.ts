/**
 * The viewer in a browser of its own, opened the way the broker opens it, on a screen.
 *
 * Two questions, one run. First, does the command `openViewer` builds give the viewer a window of its
 * own on a profile that is Orbit's: no tab strip, no address bar, a fresh profile directory that fills
 * in, and a title that names the conversation. Second, what does the viewer say its own per-frame
 * cost is, read from its `#cost` element over a minute at the default cadence, which is the figure
 * roadmap gate 1 wants a person to read. The person reads it on their desktop; this file reads the
 * same element in the same window in an Orbit private display, so the number here is the viewer's
 * own report on this host, not the participant's.
 *
 * The command is the real one plus `--remote-debugging-port=0`, so the element can be read; nothing
 * else about it differs. The browser is the system Chromium, the profile is a scratch state
 * directory rather than `~/.local/state`, so the person's own viewer profile is untouched.
 *
 * Run: ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/viewer-window.ts
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { viewerCommand, viewerProfileDirectory, type HostBrowser } from "../src/host-browsers";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const directory = join("output", `viewer-window-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const state = await mkdtemp("/tmp/orbit-viewer-window-");
const chromium: HostBrowser = { id: "chromium-browser", name: "Chromium", command: ["/usr/bin/chromium-browser"], appWindow: true, isDefault: false };
const profile = viewerProfileDirectory(chromium, { HOME: state, XDG_STATE_HOME: join(state, "state") });
await mkdir(profile, { recursive: true, mode: 0o700 });

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), browser: chromium.command[0] };
try {
  // Something for the viewer to show: one browser session on a local page, then the display.
  const watched = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Viewer window", conversationName: "Viewer window trial" }) as { sessionId: string };
  const display = await call(broker.socket, "session.create", { backend: "fedora", agentName: "SbarOrbit", taskName: "Viewer window" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...display, requestId: crypto.randomUUID(), action });
  const presence = () => call(broker.socket, "session.presence", display) as Promise<{ title: string; pageCount: number }>;
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  const command = viewerCommand(chromium, url, true, profile);
  report.command = command.map(part => part.replace(/#.*$/, "#<token>"));
  const argv = [command[0]!, "--remote-debugging-port=0", ...command.slice(1)];
  const started = performance.now();
  const launched = await act({ type: "launch", argv, toolkit: "wayland" }) as { pid: number };
  report.launchMs = Math.round(performance.now() - started);
  await Bun.sleep(3000);
  const seen = await presence();
  report.window = { title: seen.title, windows: seen.pageCount };
  const frame = await call(broker.socket, "session.observe", display) as { image: string };
  await writeFile(join(directory, "viewer-window.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });

  // Inside the window: is it app mode, and what does the viewer say each frame costs.
  const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = list.find(target => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
  if (!page) throw new Error("The viewer page was not found in the viewer browser");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((ok, fail) => { socket.onopen = () => ok(); socket.onerror = () => fail(new Error("CDP connect failed")); });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id !== undefined) pending.get(message.id)?.(message.result); };
  const evaluate = (expression: string) => new Promise<any>(resolve => {
    const n = ++id; pending.set(n, result => resolve(result?.result?.value));
    socket.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  report.appMode = { standalone: await evaluate("matchMedia('(display-mode: standalone)').matches"), title: await evaluate("document.title"), innerSize: await evaluate("[innerWidth, innerHeight]") };
  await evaluate(`new Promise(r => { const t = setInterval(() => { const f = document.querySelector('#frame'); if (f && !f.hidden && Number(f.dataset.capturedAt) > 0) { clearInterval(t); r(true); } }, 100); setTimeout(() => { clearInterval(t); r(false); }, 30000); })`);
  const samples: { atS: number; cost: string }[] = [];
  const watch = Date.now();
  while (Date.now() - watch < 60_000) {
    samples.push({ atS: Math.round((Date.now() - watch) / 1000), cost: String(await evaluate("document.querySelector('#cost')?.textContent?.trim() ?? ''")) });
    await Bun.sleep(5000);
  }
  report.costSamples = samples;
  report.costLast = samples.at(-1)?.cost;
  socket.close();
  const after = await call(broker.socket, "session.observe", display) as { image: string };
  await writeFile(join(directory, "viewer-window-after.jpg"), Buffer.from(after.image, "base64"), { mode: 0o600 });
  report.profileFilled = (await readdir(profile)).length;
  report.viewerPid = launched.pid;
  await call(broker.socket, "session.stop", display);
  await call(broker.socket, "session.stop", watched);
  report.status = "completed";
  report.limitations = [
    "An Orbit private display at 1280 by 800 with software rendering, not the person's desktop; the participant's own reading of the same element is still theirs to take.",
    "System Chromium rather than the desktop's default browser, and a scratch state directory rather than ~/.local/state.",
    "One watched browser session on a local page, so the frames are cheap to capture; a native session or a busy page costs more per frame.",
    "The cost figure is the viewer's own report of its per-frame work; it does not include the compositor or the browser process outside the page.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
