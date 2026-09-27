import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FedoraBackend } from "../src/fedora";

const nativeTest = process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip;

nativeTest("a native application writes to its private dconf database through its own bus", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-private-bus-"));
  const sourceConfig = join(root, "source-config");
  const emptyConfig = join(root, "empty-config");
  const script = join(root, "write-preference.py");
  const result = join(root, "result.json");
  await mkdir(sourceConfig, { mode: 0o700 });
  await mkdir(emptyConfig, { mode: 0o700 });

  const setting = (configHome: string, operation: "get" | "set", value?: number) => {
    const command = ["/usr/bin/dbus-run-session", "--", "/usr/bin/gsettings", operation,
      "org.gnome.desktop.interface", "cursor-size", ...(value === undefined ? [] : [String(value)])];
    const { exitCode, stdout, stderr } = Bun.spawnSync(command, {
      env: { ...process.env, XDG_CONFIG_HOME: configHome, GSETTINGS_BACKEND: "dconf" },
    });
    if (exitCode !== 0) throw new Error(`GSettings fixture failed: ${stderr.toString()}`);
    return Number(stdout.toString().trim());
  };

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousBackend = process.env.GSETTINGS_BACKEND;
  let backend: FedoraBackend | undefined;
  try {
    const defaultValue = setting(emptyConfig, "get");
    expect(Number.isInteger(defaultValue)).toBe(true);
    const sourceValue = defaultValue === 47 ? 48 : 47;
    const changedValue = defaultValue === 51 ? 52 : 51;
    setting(sourceConfig, "set", sourceValue);
    expect(setting(sourceConfig, "get")).toBe(sourceValue);
    const sourceDatabase = join(sourceConfig, "dconf", "user");
    const originalBytes = await readFile(sourceDatabase);

    await writeFile(script, `import json
import os
from pathlib import Path
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, Gtk, GLib

window = Gtk.Window(title="Orbit private bus fixture")
window.set_default_size(320, 160)
window.add(Gtk.Label(label="Private GSettings write"))
window.connect("destroy", Gtk.main_quit)
window.show_all()

def write_setting():
    settings = Gio.Settings.new("org.gnome.desktop.interface")
    before = settings.get_int("cursor-size")
    accepted = settings.set_int("cursor-size", int(sys.argv[2]))
    Gio.Settings.sync()
    Path(sys.argv[1]).write_text(json.dumps({
        "before": before,
        "accepted": accepted,
        "configHome": os.environ.get("XDG_CONFIG_HOME"),
        "runtimeDir": os.environ.get("XDG_RUNTIME_DIR"),
        "busAddress": os.environ.get("DBUS_SESSION_BUS_ADDRESS"),
        "waylandDisplay": os.environ.get("WAYLAND_DISPLAY"),
    }))
    return False

GLib.idle_add(write_setting)
Gtk.main()
`);

    process.env.XDG_CONFIG_HOME = sourceConfig;
    process.env.GSETTINGS_BACKEND = "dconf";
    backend = await FedoraBackend.create();
    await backend.act({ type: "launch", toolkit: "wayland",
      argv: ["/usr/bin/python3", script, result, String(changedValue)] });

    let observed: {
      before: number; accepted: boolean; configHome: string; runtimeDir: string;
      busAddress: string; waylandDisplay: string;
    } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { observed = JSON.parse(await readFile(result, "utf8")); break; }
      catch { await Bun.sleep(30); }
    }
    if (!observed) throw new Error("Native GSettings fixture did not report its result");
    expect(observed.before).toBe(sourceValue);
    expect(observed.accepted).toBe(true);
    expect(observed.configHome).not.toBe(sourceConfig);
    expect(observed.waylandDisplay).toBeTruthy();
    expect(observed.busAddress).toBeTruthy();
    expect(observed.busAddress).not.toContain("no-session-bus");
    expect(observed.busAddress).not.toBe(process.env.DBUS_SESSION_BUS_ADDRESS);

    const privateConfig = observed.configHome;
    const privateDatabase = join(privateConfig, "dconf", "user");
    let persisted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { persisted = !(await readFile(privateDatabase)).equals(originalBytes); }
      catch { persisted = false; }
      if (persisted) break;
      await Bun.sleep(30);
    }
    expect(persisted).toBe(true);
    expect(setting(privateConfig, "get")).toBe(changedValue);
    expect(await readFile(privateDatabase)).not.toEqual(originalBytes);
    expect(await readFile(sourceDatabase)).toEqual(originalBytes);
    expect(setting(sourceConfig, "get")).toBe(sourceValue);

    const runtimeDir = observed.runtimeDir;
    expect(dirname(privateConfig)).toBe(runtimeDir);
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    const gvfsMounts = mountInfo.split("\n").filter(line => {
      const [location, filesystem] = line.split(" - ");
      const mountPoint = location?.split(" ")[4]?.replaceAll("\\040", " ");
      return mountPoint?.startsWith(`${runtimeDir}/`) && filesystem?.includes("gvfs");
    });
    expect(gvfsMounts).toEqual([]);
  } finally {
    await backend?.close();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousBackend === undefined) delete process.env.GSETTINGS_BACKEND;
    else process.env.GSETTINGS_BACKEND = previousBackend;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
