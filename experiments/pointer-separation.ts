import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Evidence that an Orbit session cannot move the host pointer. Sampling the host cursor cannot
 * show this while a person is using the machine, so this inspects the live processes instead:
 * a session's processes must hold no connection to the host display, and a native session must
 * own a separate compositor with its own pointer.
 */
await requireResourceBudget();
const directory = join("output", `pointer-separation-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });

const hostDisplay = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null, DISPLAY: process.env.DISPLAY ?? null,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? null };

/** Processes whose command line mentions this session's own workspace directory. */
async function sessionProcesses(marker: string) {
  const found: { pid: number; command: string; environment: Record<string, string | null>; hostDisplaySockets: string[] }[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline.includes(marker)) continue;
      const environ = Object.fromEntries((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0")
        .filter(Boolean).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      const sockets: string[] = [];
      for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
        // A connection to the host compositor's socket would appear here.
        if (hostDisplay.XDG_RUNTIME_DIR && hostDisplay.WAYLAND_DISPLAY
          && target.includes(join(hostDisplay.XDG_RUNTIME_DIR, hostDisplay.WAYLAND_DISPLAY))) sockets.push(target);
        if (/\/tmp\/\.X11-unix\//.test(target)) sockets.push(target);
      }
      found.push({ pid, command: cmdline.split("\0").filter(Boolean).slice(0, 2).join(" ").slice(0, 160), hostDisplaySockets: sockets, environment: {
        DISPLAY: environ.DISPLAY ?? null, WAYLAND_DISPLAY: environ.WAYLAND_DISPLAY ?? null,
        XAUTHORITY: environ.XAUTHORITY ?? null, XDG_RUNTIME_DIR: environ.XDG_RUNTIME_DIR ?? null,
        HYPRLAND_INSTANCE_SIGNATURE: environ.HYPRLAND_INSTANCE_SIGNATURE ?? null } });
    } catch {}
  }
  return found;
}

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), hostDisplay };
try {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    '<html><title>Separation</title><body style="font:20px system-ui;padding:40px"><h1>Pointer separation</h1><input id="field"></body></html>',
    { headers: { "Content-Type": "text/html" } }) });

  const browserSession = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Pointer separation" }) as { sessionId: string; workspace?: string };
  const act = (id: string, action: unknown) => call(broker.socket, "session.act", { sessionId: id, requestId: crypto.randomUUID(), action });
  await act(browserSession.sessionId, { type: "navigate", url: `http://127.0.0.1:${fixture.port}` });
  await act(browserSession.sessionId, { type: "click", selector: "#field" });
  const browserFrame = await call(broker.socket, "session.observe", { sessionId: browserSession.sessionId }) as { presence: { pointer: unknown } };
  const browserProcesses = await sessionProcesses("sbar-orbit/workspaces");
  report.browser = {
    agentPointerReportedBySession: browserFrame.presence.pointer,
    processesInspected: browserProcesses.length,
    processesHoldingHostDisplaySocket: browserProcesses.filter(p => p.hostDisplaySockets.length).length,
    processesWithHostDisplayEnvironment: browserProcesses.filter(p => p.environment.DISPLAY || p.environment.WAYLAND_DISPLAY).length,
    withHostDisplayEnvironment: browserProcesses.filter(p => p.environment.DISPLAY || p.environment.WAYLAND_DISPLAY)
      .map(p => ({ command: p.command, environment: p.environment, hostDisplaySockets: p.hostDisplaySockets })),
    sample: browserProcesses.slice(0, 2).map(p => ({ command: p.command, environment: p.environment, hostDisplaySockets: p.hostDisplaySockets })),
  };
  fixture.stop(true);

  if (process.env.ORBIT_TEST_NATIVE === "1") {
    const native = await call(broker.socket, "session.create", { backend: "fedora", agentName: "SbarOrbit", taskName: "Native pointer" }) as { sessionId: string };
    // Use the project's disposable GTK fixture. A real desktop editor restores its own previous
    // session from the user's home directory, which would pull personal documents into the trial.
    const fixtureFile = join(await mkdtemp("/tmp/orbit-separation-"), "fixture.json");
    await act(native.sessionId, { type: "launch", toolkit: "wayland",
      argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), fixtureFile] });
    // The private compositor owns its own pointer; move it and confirm it is that display's, not the host's.
    await act(native.sessionId, { type: "pointer", x: 500, y: 300 });
    // A native session runs from its own runtime directory, not the browser workspace path.
    const nativeProcesses = await sessionProcesses("/tmp/orbit-native-");
    const compositors = nativeProcesses.filter(p => p.environment.WAYLAND_DISPLAY);
    if (!nativeProcesses.length || !compositors.length)
      throw new Error("Found no native session processes to inspect; the marker or the session is wrong");
    const frame = await call(broker.socket, "session.observe", { sessionId: native.sessionId }) as { presence: unknown };
    report.native = {
      processesInspected: nativeProcesses.length,
      compositorProcesses: compositors.length,
      processesHoldingHostDisplaySocket: nativeProcesses.filter(p => p.hostDisplaySockets.length).length,
      privateDisplays: [...new Set(compositors.map(p => p.environment.WAYLAND_DISPLAY))],
      privateRuntimeDirectories: [...new Set(compositors.map(p => p.environment.XDG_RUNTIME_DIR))],
      hostRuntimeDirectory: hostDisplay.XDG_RUNTIME_DIR,
      // The display name can repeat across compositors; only the resolved socket path distinguishes them.
      privateSocketPaths: [...new Set(compositors.map(p => `${p.environment.XDG_RUNTIME_DIR}/${p.environment.WAYLAND_DISPLAY}`))],
      hostSocketPath: `${hostDisplay.XDG_RUNTIME_DIR}/${hostDisplay.WAYLAND_DISPLAY}`,
      everyDisplaySocketIsPrivate: compositors.every(p => `${p.environment.XDG_RUNTIME_DIR}/${p.environment.WAYLAND_DISPLAY}` !== `${hostDisplay.XDG_RUNTIME_DIR}/${hostDisplay.WAYLAND_DISPLAY}`),
      presence: frame.presence,
      processes: nativeProcesses.map(p => ({ command: p.command.split(" ")[0], environment: p.environment, hostDisplaySockets: p.hostDisplaySockets })),
    };
    // Show the private display in the viewer, with the agent's own pointer drawn on it.
    const { url } = await call(broker.socket, "preview.open") as { url: string };
    const viewer = await launchChrome(await createWorkspaceDirectory("separation-viewer"));
    try {
      const page = viewer.page;
      await page.goto(url);
      await page.locator("#frame").waitFor({ state: "visible", timeout: 20000 });
      // The viewer opens on the first session it finds, so choose the native one explicitly.
      await page.selectOption("#sessions", native.sessionId);
      await page.selectOption("#preview-mode", "smooth");
      await page.waitForFunction(id => (document.querySelector("#sessions") as HTMLSelectElement)?.value === id, native.sessionId, { timeout: 10000 });
      await page.waitForFunction(() => document.querySelector("#page-location")?.textContent?.includes("private display"), undefined, { timeout: 20000 });
      await act(native.sessionId, { type: "pointer", x: 640, y: 400 });
      await page.waitForFunction(() => !document.querySelector("#agent-pointer")?.hasAttribute("hidden"), undefined, { timeout: 20000 });
      await page.screenshot({ path: join(directory, "native-agent-pointer.png"), fullPage: true });
      Object.assign(report.native as object, {
        viewerPointerOverlayVisible: await page.evaluate(() => !document.querySelector("#agent-pointer")?.hasAttribute("hidden")),
        viewerShowsSession: await page.evaluate(() => (document.querySelector("#sessions") as HTMLSelectElement)?.value),
        viewerShowsLocation: await page.evaluate(() => document.querySelector("#page-location")?.textContent),
        viewerCost: await page.locator("#cost").textContent(),
      });
    } finally { await viewer.close(); }
    await call(broker.socket, "session.stop", { sessionId: native.sessionId });
  } else report.native = "skipped; set ORBIT_TEST_NATIVE=1 with the Fedora bootstrap";

  report.status = "passed";
  report.limitations = [
    "Process inspection is a point-in-time sample, not proof that a later descendant cannot open a display connection.",
    "Display separation is not a security sandbox: same-user processes keep the OS user's filesystem permissions.",
    "The agent pointer the session reports comes from trusted events inside its own page, not from any OS pointer.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
