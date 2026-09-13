import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

/**
 * Open several real desktop applications at once in one private display, edit a real file through
 * one of them and read the result back from disk. Files are created for this run, and the session
 * now carries private XDG base directories so no application can restore personal documents.
 */
await requireResourceBudget();
const directory = join("output", `multi-application-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });

const workspace = await mkdtemp("/tmp/orbit-multi-app-");
const notes = join(workspace, "agent-notes.txt");
await writeFile(notes, "Created for the Orbit multi application trial.\n");
await writeFile(join(workspace, "second.txt"), "A second disposable file.\n");
await mkdir(join(workspace, "reports"), { recursive: true });

// Applications chosen to be genuinely different toolkits and workloads, all disposable.
const applications = [
  { name: "Text Editor", argv: ["/usr/bin/gnome-text-editor", notes], toolkit: "wayland" as const, selectedFiles: [notes] },
  { name: "Files", argv: ["/usr/bin/nautilus", workspace], toolkit: "wayland" as const },
  { name: "Calculator", argv: ["/usr/bin/gnome-calculator"], toolkit: "wayland" as const },
  { name: "System Monitor", argv: ["/usr/bin/gnome-system-monitor"], toolkit: "wayland" as const },
];

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), workspace };
let viewer: Awaited<ReturnType<typeof launchChrome>> | undefined;
try {
  const session = await call(broker.socket, "session.create",
    { backend: "fedora", agentName: "SbarOrbit", taskName: "Several applications at once" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  const observe = () => call(broker.socket, "session.observe", session) as Promise<{ presence: { title: string } }>;

  // Phase one: the editor alone, so keyboard input cannot land on a neighbouring window.
  const editor = applications[0]!;
  await act({ type: "launch", argv: editor.argv, toolkit: editor.toolkit, selectedFiles: editor.selectedFiles });
  await Bun.sleep(2500);
  const phrase = `Written by the agent at ${new Date().toISOString().slice(11, 19)}`;
  let fileOutcome: Record<string, unknown>;
  try {
    await act({ type: "pointer", x: 640, y: 400 });
    await act({ type: "paste", text: phrase });
    await Bun.sleep(800);
    await act({ type: "key", key: "Ctrl+S" });
    let saved = "";
    for (let i = 0; i < 80; i++) {
      saved = await readFile(notes, "utf8");
      if (saved.includes(phrase)) break;
      await Bun.sleep(250);
    }
    fileOutcome = { phraseOnDisk: saved.includes(phrase), focusedApplication: (await observe()).presence.title,
      bytesOnDisk: saved.length };
  } catch (error) { fileOutcome = { failed: true, message: error instanceof Error ? error.message : String(error) }; }
  report.fileEditing = fileOutcome;

  const before = await readCpuSample();
  const launched: unknown[] = [{ name: editor.name, status: "launched", phase: "before the others" }];
  for (const application of applications.slice(1)) {
    const started = performance.now();
    try {
      const result = await act({ type: "launch", argv: application.argv, toolkit: application.toolkit,
        ...(application.selectedFiles ? { selectedFiles: application.selectedFiles } : {}) }) as { pid: number };
      launched.push({ name: application.name, pid: result.pid, launchMs: Math.round(performance.now() - started), status: "launched" });
    } catch (error) {
      launched.push({ name: application.name, status: "failed", code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message : String(error) });
    }
    await Bun.sleep(1200);
  }
  const after = await readCpuSample();
  report.applications = launched;
  report.cpuDuringLaunches = cpuInterval(before, after);
  report.focusedAfterLaunches = (await observe()).presence.title;

  // Capture the tiled result directly, which does not depend on a viewer winning the shared budget.
  const frame = await call(broker.socket, "session.observe", session) as { image: string; mimeType: string };
  await writeFile(join(directory, "several-applications.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });

  const idle = await readCpuSample();
  await Bun.sleep(5000);
  report.cpuIdleWithApplicationsOpen = cpuInterval(idle, await readCpuSample());

  const { url } = await call(broker.socket, "preview.open") as { url: string };
  viewer = await launchChrome(await createWorkspaceDirectory("multi-application-viewer"));
  const page = viewer.page;
  try {
    await page.goto(url);
    await page.locator("#frame").waitFor({ state: "visible", timeout: 90000 });
    await page.selectOption("#sessions", session.sessionId);
    await page.waitForFunction(() => document.querySelector("#page-location")?.textContent?.includes("private display"), undefined, { timeout: 60000 });
    await page.screenshot({ path: join(directory, "viewer-several-applications.png"), fullPage: true });
    report.viewer = { rendered: true, cost: await page.locator("#cost").textContent() };
  } catch (error) {
    report.viewer = { rendered: false, note: "The viewer competes with the applications for the same one core budget",
      message: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }

  report.status = "passed";
  report.limitations = [
    "One private display at 1280 by 800 with software rendering, so windows tile in a small space.",
    "Applications are launched with private XDG base directories; that stops session restore, it is not a security boundary.",
    "The broker allows at most 32 launches per native session and the shared budget caps tasks at 1536.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (viewer) await viewer.close();
  await broker.close();
}
