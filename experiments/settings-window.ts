import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await act({ type: "launch", toolkit: "wayland", argv: ["/bin/sh", "-c",
    `ORBIT_SOCKET=${JSON.stringify(broker.socket)} XDG_CONFIG_HOME=${JSON.stringify(config)} ` +
    `/usr/bin/python3 ${JSON.stringify(resolve("desktop/panel.py"))} --settings >${JSON.stringify(log)} 2>&1 & ` +
    "exec /usr/bin/gnome-calculator"] });
  await Bun.sleep(4000);
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

  // What the panel said about itself while all of that happened.
  report.panelOutput = (await Bun.file(log).text().catch(() => "")).split("\n").filter(Boolean).slice(-8);
  report.sessionTabs = (await call(broker.socket, "session.observe", { sessionId: display.sessionId }) as { presence: { tabs: unknown[] } }).presence.tabs.length;
  await call(broker.socket, "session.stop", { sessionId: display.sessionId });
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  await broker.close();
  await rm(config, { recursive: true, force: true }).catch(() => {});
}

await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
