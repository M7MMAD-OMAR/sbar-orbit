import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("systemd user units and XDG autostart entries");
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applicationEntry, autostartPaths, autostartStatus, disableAutostart, enableAutostart, orbitOwnedUnits, panelAutostartEntry, panelUnit } from "../src/autostart";

/**
 * The units and entries are written into a directory of their own, and systemd is deliberately not told.
 * systemctl reads the real unit directory whatever paths it was handed, so a test that writes elsewhere
 * and still calls enable changes what the person's own machine starts at login. This test did exactly
 * that once, and disabled both of their units on the way past.
 */
function elsewhere(root: string) {
  return { units: join(root, "systemd/user"), xdgAutostart: join(root, "autostart"), applications: join(root, "applications"), icons: join(root, "icons") };
}

test("the panel unit is not the broker unit, and the difference is deliberate", () => {
  const unit = panelUnit("/opt/orbit/bin/sbar-orbit");
  // A layer shell surface needs a compositor, so the panel hangs off the graphical session rather than
  // the user manager. Starting one without a compositor is a process that exits immediately.
  expect(unit).toContain("WantedBy=graphical-session.target");
  expect(unit).toContain("PartOf=graphical-session.target");
  // The panel is the person's own desktop surface and runs outside Orbit's shared budget on purpose.
  expect(unit).not.toContain("Slice=sbarorbit.slice");
  // Safe only because a second panel exits zero rather than failing, which is what stops this retrying
  // the loser of a race forever.
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("ExecStart=/opt/orbit/bin/sbar-orbit panel");
});

test("both desktop entries name an icon and a command that exists", async () => {
  const launcher = resolve("bin/sbar-orbit");
  expect((await stat(launcher)).isFile()).toBe(true);
  const autostart = panelAutostartEntry(launcher);
  expect(autostart).toContain("X-GNOME-Autostart-enabled=true");
  expect(autostart).toContain(`Exec=${launcher} panel`);
  const application = applicationEntry(launcher);
  // The launcher entry opens the settings window, because a person who found Orbit in their applications
  // menu wants to see something rather than start a background process.
  expect(application).toContain(`Exec=${launcher} settings`);
  expect(application).toContain("Icon=sbar-orbit");
  // Searchable in the desktop's own launcher by the words someone would type there.
  expect(application).toContain("Keywords=");
});

test("enabling writes both paths and the launcher entry, and disabling removes the autostart one", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-autostart-"));
  const paths = elsewhere(root);
  try {
    const enabled = await enableAutostart(resolve("bin/sbar-orbit"), paths, false);
    // Both paths, because a desktop honours one or the other and Orbit cannot tell which from here.
    expect(enabled.wrote).toContain(join(paths.units, "sbar-orbit-panel.service"));
    expect(enabled.wrote).toContain(join(paths.xdgAutostart, "sbar-orbit-panel.desktop"));
    expect(enabled.wrote).toContain(join(paths.applications, "sbar-orbit.desktop"));
    // An entry naming an icon no theme resolves is a launcher row with a blank square in it.
    expect(enabled.wrote).toContain(join(paths.icons, "sbar-orbit.svg"));
    expect((await readFile(join(paths.icons, "sbar-orbit.svg"), "utf8")).slice(0, 200)).toContain("<svg");

    // Run twice, changes nothing: this is called by `service install` and by a switch a person can
    // click repeatedly.
    const again = await enableAutostart(resolve("bin/sbar-orbit"), paths, false);
    expect(again.wrote).toEqual(enabled.wrote);

    expect(await orbitOwnedUnits(paths)).toEqual([join(paths.units, "sbar-orbit-panel.service")]);

    const disabled = await disableAutostart(paths, false);
    expect(disabled.removed).toEqual([join(paths.xdgAutostart, "sbar-orbit-panel.desktop")]);
    // The launcher entry stays. It is how a person finds Orbit, not how it starts, and removing it
    // would answer a question nobody asked.
    expect((await stat(join(paths.applications, "sbar-orbit.desktop"))).isFile()).toBe(true);
    // Disabling twice is not an error either.
    expect((await disableAutostart(paths, false)).removed).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the status answers the only question that matters, and says what it cannot see", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-autostart-status-"));
  try {
    const status = await autostartStatus(elsewhere(root));
    // Nothing was installed into this directory, so whatever the real machine has enabled, this
    // combination cannot claim the mark comes back.
    expect(status.xdgAutostartEntry).toBe(false);
    expect(status.applicationEntry).toBe(false);
    // A compositor that starts the panel from its own configuration is invisible to this, and saying so
    // is the difference between a status and a claim.
    expect(status.notes.join(" ")).toContain("invisible here");
    expect(typeof status.startsWithTheDesktop).toBe("boolean");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the real paths are the ones the desktop specifications name", () => {
  // A fake root that is not shaped like anybody's home directory: the public audit refuses a path that
  // looks like one, and it is right to, since a test fixture is how a real one gets committed.
  const root = "/fixture/person";
  const paths = autostartPaths(root, `${root}/.config`, `${root}/.local/share`);
  expect(paths.xdgAutostart).toBe(`${root}/.config/autostart`);
  expect(paths.applications).toBe(`${root}/.local/share/applications`);
  expect(paths.icons).toBe(`${root}/.local/share/icons/hicolor/scalable/apps`);
});
