import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * The settings window, its search, and a setting changed from a terminal while the window is open,
 * captured where none of it touches the person's screen: inside a private display, which is a
 * layer shell compositor like the desktop the panel is built for.
 *
 * The panel under test is given a config directory of its own. Without that it would read and write the
 * person's real settings, and a test that proves the reload works by changing the colour of the mark on
 * their desktop has proved something nobody asked for.
 *
 * What is being measured, in order:
 *   the window opens at all, with the search focused, so it can be used by typing;
 *   typing a word hides the groups it does not match, including a word that appears in no label;
 *   a word in Arabic finds the same setting, because the terms are indexed and not only the labels;
 *   `sbar-orbit config set` from outside reaches the running panel, which is the property that makes
 *   the command line and the window the same settings rather than two copies of them.
 */
await requireResourceBudget();
const directory = join("output", `settings-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const config = await mkdtemp(join(tmpdir(), "orbit-settings-config-"));
// A command socket of its own, so the panel under test does not answer for the person's own panel. The
// runtime directory itself is left alone: it is where libwayland looks for the compositor, and a panel
// pointed at a different one finds no display.
const runtime = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "orbit-settings-run-"));
const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
const launcher = resolve("bin/sbar-orbit");

/** The settings CLI, pointed at the test panel's own config directory rather than the person's. */
async function config_(...args: string[]) {
  const child = Bun.spawn([launcher, "config", ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: config }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, out, err };
}

try {
  const display = await call(broker.socket, "session.create", {
    backend: "fedora", agentName: "settings-check", taskName: "The settings window",
    viewport: { width: 1280, height: 800 },
  }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { sessionId: display.sessionId, requestId: crypto.randomUUID(), action });
  const shot = async (name: string) => {
    const frame = await call(broker.socket, "session.observe", { sessionId: display.sessionId }) as { image: string };
    await writeFile(join(directory, `${name}.jpg`), Buffer.from(frame.image, "base64"), { mode: 0o600 });
    return join(directory, `${name}.jpg`);
  };

  // The panel, and its settings window with it. A layer shell surface is not a window in the compositor
  // tree, so it is started beside a plain one; the supervisor is a subreaper, so both end with the session.
  const log = join(directory, "panel.log");
  // Started WITHOUT --settings, so the window has to be asked for the way the applications menu asks for
  // it: a datagram to the socket the running panel bound. That is the path the launcher entry uses, and
  // testing it by passing a flag at startup would test something else.
  await act({ type: "launch", toolkit: "wayland", argv: ["/bin/sh", "-c",
    `ORBIT_SOCKET=${JSON.stringify(broker.socket)} XDG_CONFIG_HOME=${JSON.stringify(config)} ORBIT_PANEL_SOCKET=${JSON.stringify(join(runtime, "panel.sock"))} ` +
    `/usr/bin/python3 ${JSON.stringify(resolve("desktop/panel.py"))} >${JSON.stringify(log)} 2>&1 & ` +
    "exec /usr/bin/gnome-calculator"] });
  await Bun.sleep(4000);
  report.windowsBeforeAsking = (await call(broker.socket, "session.observe", { sessionId: display.sessionId }) as { presence: { tabs: { label: string }[] } }).presence.tabs.map(w => w.label);
  // A unix socket is not a regular file, so this asks the filesystem rather than Bun.file().exists().
  report.commandSocketBound = await stat(join(runtime, "panel.sock")).then(entry => entry.isSocket(), () => false);
  // The panel bound its socket under the runtime directory it was given, so this reaches that panel and
  // not the person's. WAYLAND_DISPLAY and DISPLAY are cleared as well: if the socket were missing, the
  // fallback is to start a panel, and a panel started from here must not be able to find their screen.
  const asked = Bun.spawn([resolve("bin/sbar-orbit"), "settings"], {
    env: { ...process.env, ORBIT_PANEL_SOCKET: join(runtime, "panel.sock"), WAYLAND_DISPLAY: "", DISPLAY: "" },
    stdout: "pipe", stderr: "pipe",
  });
  report.askedForSettings = { exit: await asked.exited, said: (await new Response(asked.stderr).text()).trim().slice(0, 120) };
  await Bun.sleep(1500);
  // The window that the compositor happens to have focused is the one typing reaches, and here that is
  // the plain window the panel was started beside. On the person's own desktop the settings window is
  // opened by their click and arrives focused; inside a private display it has to be asked for.
  const windows = (await call(broker.socket, "session.observe", { sessionId: display.sessionId }) as { presence: { tabs: { tab: number; label: string }[] } }).presence.tabs;
  report.windows = windows.map(w => w.label);
  const settingsWindow = windows.find(w => /orbit/i.test(w.label));
  if (settingsWindow) await act({ type: "window", command: "focus", tab: settingsWindow.tab });
  await Bun.sleep(800);
  report.opened = await shot("open");

  // Typed, not clicked: the search takes focus when the window opens, which is what lets a person use it
  // by typing the word they came in with.
  const search = async (word: string, name: string) => {
    await act({ type: "text", text: word });
    await Bun.sleep(900);
    const path = await shot(name);
    // Select all, then the next word replaces it. A private display offers no BackSpace, which is a
    // deliberately small key set rather than an omission.
    await act({ type: "key", key: "Ctrl+A" });
    await Bun.sleep(300);
    return path;
  };
  report.searchedGlow = await search("glow", "search-glow");
  // A word that appears in no label on the window. It matches through the schema's description and terms,
  // which is the difference between a search box and a search.
  report.searchedBoot = await search("boot", "search-boot");

  // Arabic goes through the private display's own clipboard, because typed input there is ASCII.
  await act({ type: "paste", text: "توهج" });
  await Bun.sleep(900);
  report.searchedArabic = await shot("search-arabic");
  await act({ type: "key", key: "Ctrl+A" });
  await act({ type: "text", text: " " });
  await Bun.sleep(600);

  // And the reload. The window is open, the panel is drawing, and the change arrives from a terminal.
  const before = await config_("get", "style");
  const changed = await config_("set", "style", "dot");
  await Bun.sleep(1200);
  report.changedFromTheTerminal = { before: before.out.trim(), applied: changed.ok, after: (await config_("get", "style")).out.trim() };
  report.afterTheChange = await shot("after-config-set");

  // The button that answers "I have never seen this work": a browser of the person's own, from the
  // window rather than a terminal. Clicked for real, because the handler is the thing being measured.
  // The button is on screen and reachable, which is what the frame shows. What it does is measured
  // underneath it rather than through it: a private display moves the pointer and never clicks, by
  // design, and a Tab into a filtered list is not a stable way to press a particular button. So this
  // runs the three calls the handler runs, in the order it runs them, and checks what they leave behind.
  await act({ type: "text", text: "printer" });
  await Bun.sleep(700);
  report.buttonOnScreen = await shot("own-session");
  const own = await call(broker.socket, "session.create", { backend: "browser", agentName: "You", taskName: "Opened from the panel" }) as { sessionId: string };
  await call(broker.socket, "session.pause", { sessionId: own.sessionId });
  const link = await call(broker.socket, "preview.open") as { url: string };
  const listed = (await call(broker.socket, "session.list") as { sessionId: string; agentName: string; state: string }[])
    .find(open => open.sessionId === own.sessionId);
  report.aBrowserOfTheirOwn = {
    // Paused, because manual control in the viewer is what a paused session allows, and a person who
    // opened a browser expects to be able to type in it.
    state: listed?.state,
    // Named for them, because the whole premise of the mark is telling whose work you are watching.
    agentName: listed?.agentName,
    viewerIsLocalAndTokened: /^http:\/\/127\.0\.0\.1:\d+\/#.{32,}$/.test(link.url),
  };
  await call(broker.socket, "session.stop", { sessionId: own.sessionId });
  await act({ type: "key", key: "Ctrl+A" });
  await act({ type: "text", text: " " });
  await Bun.sleep(600);

  // Every shape the mark can take, on the edge it would sit on, captured rather than described. The
  // person asking what this looks like should not have to read four adjectives and imagine it.
  const shapes: Record<string, string> = {};
  for (const style of ["mark", "bar", "dot", "count"]) {
    await config_("set", "style", style);
    await Bun.sleep(1200);
    shapes[style] = await shot(`mark-${style}`);
  }
  report.shapes = shapes;
  // And on another edge, because placement is the setting people change first.
  await config_("set", "style", "mark");
  await config_("set", "edge", "left");
  await Bun.sleep(1200);
  report.onTheLeftEdge = await shot("mark-left-edge");
  await config_("set", "edge", "top");
  await Bun.sleep(1200);
  report.onTheTopEdge = await shot("mark-top-edge");

  // What the panel said about itself while all of that happened.
  report.panelOutput = (await Bun.file(log).text().catch(() => "")).split("\n").filter(Boolean).slice(-8);
  report.sessionTabs = (await call(broker.socket, "session.observe", { sessionId: display.sessionId }) as { presence: { tabs: unknown[] } }).presence.tabs.length;
  await call(broker.socket, "session.stop", { sessionId: display.sessionId });
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  await broker.close();
  await rm(config, { recursive: true, force: true }).catch(() => {});
  await rm(runtime, { recursive: true, force: true }).catch(() => {});
}

await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
