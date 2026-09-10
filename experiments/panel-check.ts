import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Renders the desktop panel where it can be captured without touching the person's screen: inside a
 * private display, which is a wlr-layer-shell compositor like the desktop the panel is meant for.
 * The panel is pointed at this broker, which owns the private display itself with two windows, so
 * the strip has real counts to show. Collapsed and expanded frames are both saved. A browser session
 * is deliberately not added: Chrome starting beside a compositor on one core starves the compositor
 * IPC the panel polls, which is contention, not the panel.
 */
await requireResourceBudget();
const directory = join("output", `panel-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
try {
  let step = "create private display";
  (globalThis as { step?: string }).step = step;
  // The private display first, so its compositor is not starting while Chrome is.
  const display = await call(broker.socket, "session.create", { backend: "fedora", agentName: "Hermes", taskName: "Editing a document", viewport: { width: 1280, height: 800 } }) as { sessionId: string };
  const act = (session: { sessionId: string }, action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  step = "launch text editor"; (globalThis as { step?: string }).step = step;
  await act(display, { type: "launch", toolkit: "wayland", argv: ["/usr/bin/gnome-text-editor"] });
  // A layer-shell surface is not a window in the compositor tree, so launch cannot see it map. It is
  // started beside a plain window instead; the supervisor is a subreaper, so both end with the session.
  step = "launch panel"; (globalThis as { step?: string }).step = step;
  const panelLog = join(directory, "panel.log");
  try {
    await act(display, { type: "launch", toolkit: "wayland", argv: ["/bin/sh", "-c",
      `ORBIT_SOCKET=${JSON.stringify(broker.socket)} /usr/bin/python3 ${JSON.stringify(resolve("desktop/panel.py"))} --edge right >${JSON.stringify(panelLog)} 2>&1 & exec /usr/bin/gnome-calculator`] });
  } catch (error) {
    // Keep going: the frame and the panel's own output are the evidence either way.
    report.panelLaunch = { failed: true, message: error instanceof Error ? error.message : String(error) };
  }
  step = "capture"; (globalThis as { step?: string }).step = step;
  await Bun.sleep(2500);
  const collapsed = await call(broker.socket, "session.observe", display) as { image: string; presence: { tabs: unknown[] } };
  await writeFile(join(directory, "collapsed.jpg"), Buffer.from(collapsed.image, "base64"), { mode: 0o600 });
  report.collapsedPresence = collapsed.presence;

  // Hover the strip: it sits against the right edge, vertically centred by the layer shell.
  await act(display, { type: "pointer", x: 1265, y: 400 });
  await Bun.sleep(1500);
  const expanded = await call(broker.socket, "session.observe", display) as { image: string; presence: unknown };
  await writeFile(join(directory, "expanded.jpg"), Buffer.from(expanded.image, "base64"), { mode: 0o600 });
  report.expandedPresence = expanded.presence;
  report.panelOutput = (await Bun.file(panelLog).text().catch(() => "")).slice(-2000);
  report.status = "captured";
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error), step: (globalThis as { step?: string }).step });
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
