import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OrbitError } from "./errors";

/**
 * Starting with the desktop, by default.
 *
 * Orbit used to write its units and stop, on the reasoning that enabling a service changes the person's
 * session and should therefore be their own command. That is a defensible position and it was the wrong
 * one: a person who installs a thing that is supposed to be waiting for their agents has to discover,
 * from documentation, that it is not. So this is what `service install` now does unless told otherwise,
 * and what the Startup switch in the settings window calls.
 *
 * Two paths, because one is not enough and neither is sufficient alone:
 *
 *   The systemd user units. The broker wants `default.target` so it comes up with the user manager, and
 *   survives a full logout when the person has enabled lingering. The panel wants
 *   `graphical-session.target`, because a layer shell surface needs a compositor and starting it without
 *   one is a process that exits immediately.
 *
 *   An XDG autostart entry for the panel. GNOME, KDE, XFCE and LXQt honour it whether or not they reach
 *   `graphical-session.target` in a way a user unit can hang off, and some compositors reach that target
 *   only under a session manager the person may not be using.
 *
 * Both at once is the point rather than a mistake: whichever the desktop honours, the panel starts once,
 * because the panel takes a lock and a second copy exits quietly. That is what makes belt and braces
 * safe here, and it is the property to keep if either path is ever changed.
 */

export type AutostartPaths = { units: string; xdgAutostart: string; applications: string; icons: string };

export function autostartPaths(home = homedir(), config = process.env.XDG_CONFIG_HOME, data = process.env.XDG_DATA_HOME): AutostartPaths {
  const configRoot = config || join(home, ".config");
  const dataRoot = data || join(home, ".local/share");
  return {
    units: process.env.ORBIT_UNIT_DIR ?? join(configRoot, "systemd/user"),
    xdgAutostart: join(configRoot, "autostart"),
    applications: join(dataRoot, "applications"),
    // Both entries name Icon=sbar-orbit, and a name no theme resolves is a launcher entry with a blank
    // square where the mark should be.
    icons: join(dataRoot, "icons/hicolor/scalable/apps"),
  };
}

/**
 * The panel is the person's own desktop surface and runs outside Orbit's shared budget on purpose, so
 * this unit names no slice. `Restart=on-failure` is safe only because a second panel exits zero.
 */
export function panelUnit(launcher: string) {
  return ["[Unit]", "Description=Sbar Orbit desktop mark", "PartOf=graphical-session.target",
    "After=graphical-session.target", "", "[Service]", "Type=simple",
    `ExecStart=${launcher} panel`, "Restart=on-failure", "RestartSec=3",
    "", "[Install]", "WantedBy=graphical-session.target", ""].join("\n");
}

/** Started by the desktop's own autostart, for the desktops that do not reach a target a unit can want. */
export function panelAutostartEntry(launcher: string) {
  return ["[Desktop Entry]", "Type=Application", "Name=Sbar Orbit mark",
    "Comment=Shows what agents are doing, on a screen edge",
    `Exec=${launcher} panel`, "Icon=sbar-orbit", "Terminal=false",
    "Categories=Utility;", "X-GNOME-Autostart-enabled=true", "Hidden=false",
    // Started twice is harmless, and this says why in the place someone will read it.
    "X-Orbit-Note=A second panel exits quietly, so this and the systemd unit can both be enabled", ""].join("\n");
}

/**
 * The launcher entry, which is not autostart but is the other half of the same complaint: a person who
 * has never opened a terminal has no way to find this at all.
 */
export function applicationEntry(launcher: string) {
  return ["[Desktop Entry]", "Type=Application", "Name=Sbar Orbit",
    "Comment=Private browser and desktop workspaces for AI agents",
    `Exec=${launcher} settings`, "Icon=sbar-orbit", "Terminal=false",
    "Categories=Utility;Development;", "Keywords=agent;browser;session;orbit;automation;",
    "StartupNotify=false", "", "[Desktop Action Viewer]", "Name=Open the viewer",
    `Exec=${launcher} preview --open`, ""].join("\n");
}

async function present(path: string) {
  try { await stat(path); return true; } catch { return false; }
}

async function writeAtomic(path: string, contents: string, mode = 0o644) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

async function systemctl(...args: string[]) {
  const child = Bun.spawn(["/usr/bin/systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, output: `${out}${err}`.trim() };
}

export type AutostartStatus = {
  brokerEnabled: boolean; brokerActive: boolean;
  panelEnabled: boolean; panelActive: boolean;
  xdgAutostartEntry: boolean; applicationEntry: boolean;
  lingering: boolean; graphicalTarget: boolean;
  /** The only claim that matters, and it is not the same as any single row above. */
  startsWithTheDesktop: boolean;
  notes: string[];
};

export async function autostartStatus(paths = autostartPaths()): Promise<AutostartStatus> {
  const [broker, brokerActive, panel, panelActive, graphical, linger] = await Promise.all([
    systemctl("is-enabled", "sbar-orbit.service"), systemctl("is-active", "sbar-orbit.service"),
    systemctl("is-enabled", "sbar-orbit-panel.service"), systemctl("is-active", "sbar-orbit-panel.service"),
    systemctl("is-active", "graphical-session.target"),
    (async () => {
      const child = Bun.spawn(["/usr/bin/loginctl", "show-user", String(process.getuid?.() ?? 0), "-p", "Linger"], { stdout: "pipe", stderr: "ignore" });
      return { ok: await child.exited === 0, output: (await new Response(child.stdout).text()).trim() };
    })(),
  ]);
  const xdg = await present(join(paths.xdgAutostart, "sbar-orbit-panel.desktop"));
  const application = await present(join(paths.applications, "sbar-orbit.desktop"));
  const notes: string[] = [];
  if (!graphical.ok)
    notes.push("This desktop does not report an active graphical-session.target, so the panel's user unit may never be started by it. The autostart entry is the path that will work here.");
  if (!linger.output.includes("yes"))
    notes.push("Lingering is off, so the broker starts when you log in rather than at boot. Turning it on needs elevation: loginctl enable-linger $USER.");
  if (!xdg && !panel.ok)
    notes.push("Neither the panel's unit nor an autostart entry is in place, so nothing Orbit installed will bring the mark back.");
  notes.push("A compositor that starts the panel from its own configuration is invisible here. This reports what Orbit set up, not everything on this machine that might start it.");
  return {
    brokerEnabled: broker.ok, brokerActive: brokerActive.ok,
    panelEnabled: panel.ok, panelActive: panelActive.ok,
    xdgAutostartEntry: xdg, applicationEntry: application,
    lingering: linger.output.includes("yes"), graphicalTarget: graphical.ok,
    startsWithTheDesktop: broker.ok && (panel.ok || xdg),
    notes,
  };
}

/** Both paths, and the launcher entry. Idempotent: run it twice and the second run changes nothing. */
export async function enableAutostart(launcher: string, paths = autostartPaths()) {
  try { if (!(await stat(launcher)).isFile()) throw new Error("not a file"); }
  catch { throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file"); }
  const wrote: string[] = [];
  const panelPath = join(paths.units, "sbar-orbit-panel.service");
  await writeAtomic(panelPath, panelUnit(launcher));
  wrote.push(panelPath);
  const entry = join(paths.xdgAutostart, "sbar-orbit-panel.desktop");
  await writeAtomic(entry, panelAutostartEntry(launcher));
  wrote.push(entry);
  const application = join(paths.applications, "sbar-orbit.desktop");
  await writeAtomic(application, applicationEntry(launcher));
  wrote.push(application);
  const icon = join(paths.icons, "sbar-orbit.svg");
  const mark = join(launcher, "../../brand/orbit-mark.svg");
  if (await present(mark)) { await writeAtomic(icon, await readFile(mark, "utf8")); wrote.push(icon); }
  await systemctl("daemon-reload");
  const enabled = {
    broker: (await systemctl("enable", "--now", "sbar-orbit.service")).ok,
    // Not --now for the panel: it is started by the graphical session, and starting one from a context
    // with no compositor is a process that exits before the command returns.
    panel: (await systemctl("enable", "sbar-orbit-panel.service")).ok,
  };
  return { wrote, enabled, status: await autostartStatus(paths) };
}

/** Off means off on every path, including the one this desktop happens to ignore. */
export async function disableAutostart(paths = autostartPaths()) {
  const removed: string[] = [];
  for (const path of [join(paths.xdgAutostart, "sbar-orbit-panel.desktop")]) {
    if (await present(path)) { await rm(path, { force: true }); removed.push(path); }
  }
  const disabled = {
    broker: (await systemctl("disable", "sbar-orbit.service")).ok,
    panel: (await systemctl("disable", "sbar-orbit-panel.service")).ok,
  };
  await systemctl("daemon-reload");
  // The launcher entry stays. It is how a person finds Orbit, not how it starts, and removing it would
  // answer a question nobody asked.
  return { removed, disabled, status: await autostartStatus(paths) };
}

/** Which units Orbit wrote here, for `service uninstall` to remove and for a report to name. */
export async function orbitOwnedUnits(paths = autostartPaths()) {
  const owned: string[] = [];
  for (const name of ["sbarorbit.slice", "sbar-orbit.service", "sbar-orbit-panel.service"]) {
    const path = join(paths.units, name);
    try { if ((await readFile(path, "utf8")).includes("Description=Sbar Orbit")) owned.push(path); } catch {}
  }
  return owned;
}
