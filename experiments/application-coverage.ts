/**
 * Applications beyond the four in multi-application.ts, one at a time in one private display.
 *
 * Roadmap gate 2 leaves "applications beyond the four launched so far" open. This run launches a
 * wider set, chosen for being different toolkits and renderers rather than for being easy: GTK4
 * with libadwaita, GTK3, LibreOffice's own VCL, Qt 6, and an OpenGL terminal on a software rendered
 * display. Each application is launched through the broker exactly as an agent would launch it,
 * the window the compositor mapped is recorded with its title and launch time, one frame is kept,
 * and the window is closed through the session's own window command before the next starts, so
 * the count that matters is the number of distinct applications and not how many fit in the budget
 * at once.
 *
 * A failure is recorded with its code and kept in the report; it is not retried and not excused.
 * The report says what mapped, what did not, and what each cost, nothing more.
 *
 * Run: ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/application-coverage.ts
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

await requireResourceBudget();
const directory = join("output", `application-coverage-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp("/tmp/orbit-application-coverage-");
const document = join(workspace, "coverage.txt");
await writeFile(document, "Created for the Orbit application coverage run.\n");

type Toolkit = "wayland" | "x11";
const applications: { name: string; family: string; argv: string[]; toolkit: Toolkit; selectedFiles?: string[] }[] = [
  { name: "Ptyxis", family: "GTK4 libadwaita terminal", argv: ["/usr/bin/ptyxis", "--new-window"], toolkit: "wayland" },
  { name: "Characters", family: "GTK4 libadwaita", argv: ["/usr/bin/gnome-characters"], toolkit: "wayland" },
  { name: "Clocks", family: "GTK4 libadwaita", argv: ["/usr/bin/gnome-clocks"], toolkit: "wayland" },
  { name: "Weather", family: "GTK4 libadwaita, network backed", argv: ["/usr/bin/gnome-weather"], toolkit: "wayland" },
  { name: "Loupe", family: "GTK4, GPU image viewer", argv: ["/usr/bin/loupe"], toolkit: "wayland" },
  { name: "Papers", family: "GTK4 document viewer", argv: ["/usr/bin/papers"], toolkit: "wayland" },
  { name: "Showtime", family: "GTK4 video player", argv: ["/usr/bin/showtime"], toolkit: "wayland" },
  { name: "Snapshot", family: "GTK4 camera, no camera on this host", argv: ["/usr/bin/snapshot"], toolkit: "wayland" },
  { name: "Font Viewer", family: "GTK4", argv: ["/usr/bin/gnome-font-viewer"], toolkit: "wayland" },
  { name: "Inkscape", family: "GTK3", argv: ["/usr/bin/inkscape"], toolkit: "wayland" },
  // Writer's window belongs to soffice.bin, a grandchild of the launched script; matching a mapped
  // window by session id rather than by pid is what made this entry pass. See src/fedora.ts.
  { name: "LibreOffice Writer", family: "VCL with the gtk3 plugin", argv: ["/usr/bin/libreoffice", "--writer", "--norestore", "--nologo", document], toolkit: "wayland", selectedFiles: [document] },
  // Not KFontView: 6.7.4 exits 1 with nothing on stderr when handed a font file here, while its
  // --version runs, so it is its own refusal rather than a Qt one. The two below are the same
  // Qt 6 and KDE Frameworks stack and map.
  { name: "Konsole", family: "Qt 6, KDE Frameworks terminal", argv: ["/usr/bin/konsole"], toolkit: "wayland" },
  { name: "Dolphin", family: "Qt 6, KDE Frameworks file manager", argv: ["/usr/bin/dolphin", workspace], toolkit: "wayland" },
  { name: "kitty", family: "GLFW, OpenGL terminal", argv: ["/usr/bin/kitty"], toolkit: "wayland" },
  { name: "Calculator under Xwayland", family: "GTK4 forced to X11", argv: ["/usr/bin/gnome-calculator"], toolkit: "x11" },
];

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), workspace, applications: [] as unknown[] };
try {
  const session = await call(broker.socket, "session.create",
    { backend: "fedora", agentName: "SbarOrbit", taskName: "Application coverage" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  const presence = async () => (await call(broker.socket, "session.presence", session)) as { title: string; pageCount: number; tabs: { tab: number; label: string; active: boolean }[] };
  const results: unknown[] = [];
  for (const application of applications) {
    const entry: Record<string, unknown> = { name: application.name, family: application.family, toolkit: application.toolkit };
    const before = await readCpuSample();
    const started = performance.now();
    try {
      const launched = await act({ type: "launch", argv: application.argv, toolkit: application.toolkit,
        ...(application.selectedFiles ? { selectedFiles: application.selectedFiles } : {}) }) as { pid: number };
      entry.launchMs = Math.round(performance.now() - started);
      entry.pid = launched.pid;
      // Two seconds for the first frame to settle; a window that mapped is already counted.
      await Bun.sleep(2000);
      const seen = await presence();
      entry.windowsOpen = seen.pageCount;
      entry.focusedTitle = seen.title;
      const frame = await call(broker.socket, "session.observe", session) as { image: string };
      const file = `${application.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`;
      await writeFile(join(directory, file), Buffer.from(frame.image, "base64"), { mode: 0o600 });
      entry.frame = file;
      entry.cpuLaunchToFrame = cpuInterval(before, await readCpuSample());
      // Close every window this application mapped, newest first, through the session's own
      // command, and wait for the compositor to report the display empty again.
      for (let round = 0; round < 8 && (await presence()).pageCount > 0; round++) {
        await act({ type: "window", command: "close", tab: (await presence()).pageCount });
        await Bun.sleep(700);
      }
      const remaining = (await presence()).pageCount;
      entry.closed = remaining === 0;
      if (remaining) entry.windowsLeftOpen = remaining;
      entry.status = "mapped";
    } catch (error) {
      entry.status = "failed";
      entry.code = (error as { code?: string }).code;
      entry.message = error instanceof Error ? error.message : String(error);
      entry.afterMs = Math.round(performance.now() - started);
      // A failure can leave a window behind; clear it so the next application starts on an empty display.
      for (let round = 0; round < 8 && (await presence()).pageCount > 0; round++) {
        await act({ type: "window", command: "close", tab: (await presence()).pageCount }).catch(() => {});
        await Bun.sleep(700);
      }
    }
    results.push(entry);
    console.error(JSON.stringify(entry));
  }
  report.applications = results;
  const mapped = results.filter(r => (r as { status: string }).status === "mapped");
  report.summary = { attempted: results.length, mapped: mapped.length, failed: results.length - mapped.length,
    launchMsRange: mapped.length ? [Math.min(...mapped.map(r => (r as { launchMs: number }).launchMs)), Math.max(...mapped.map(r => (r as { launchMs: number }).launchMs))] : null };
  await call(broker.socket, "session.stop", session);
  report.status = "completed";
  report.limitations = [
    "One private display at 1280 by 800 with software rendering; a GPU application here renders through llvmpipe.",
    "Each application is launched alone and closed before the next, so this says nothing about how many run together within the budget; multi-application.ts measures that.",
    "Mapping a window and drawing a first frame is what is checked; no application was driven further than its first window.",
    "Applications run with private XDG base directories, which stops session restore and is not a security boundary.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
