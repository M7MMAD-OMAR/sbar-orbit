import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Do applications in a private display look the way they look on the person's desktop? Opens a GTK 4
 * application, a GTK 3 one and a Qt one, then an Electron one if it is installed, and saves a frame
 * for inspection. Dark or light, icon set and cursor are what a person notices first, so the frame
 * is the evidence and the report lists what the session actually received.
 */
await requireResourceBudget();
const directory = join("output", `appearance-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const candidates = [
  { name: "Files", argv: ["/usr/bin/nautilus"], toolkit: "wayland" as const },
  { name: "Text Editor", argv: ["/usr/bin/gnome-text-editor"], toolkit: "wayland" as const },
  { name: "Dolphin", argv: ["/usr/bin/dolphin"], toolkit: "wayland" as const },
  { name: "Docker Desktop", argv: ["/opt/docker-desktop/bin/docker-desktop"], toolkit: "x11" as const },
];
const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
try {
  const session = await call(broker.socket, "session.create", { backend: "fedora", taskName: "Appearance check", viewport: { width: 1600, height: 1000 } }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  const launched: unknown[] = [];
  for (const app of candidates) {
    if (!await Bun.file(app.argv[0]!).exists()) { launched.push({ name: app.name, status: "not installed" }); continue; }
    const started = performance.now();
    try {
      await act({ type: "launch", argv: app.argv, toolkit: app.toolkit });
      launched.push({ name: app.name, status: "launched", ms: Math.round(performance.now() - started) });
    } catch (error) { launched.push({ name: app.name, status: "failed", message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code }); }
    await Bun.sleep(2500);
  }
  report.applications = launched;
  const frame = await call(broker.socket, "session.observe", session) as { image: string; presence: unknown };
  await writeFile(join(directory, "applications.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
  report.presence = frame.presence;
  const directories = (await call(broker.socket, "session.list") as { sessionId: string }[]).length;
  report.sessions = directories;
  report.status = "captured";
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
