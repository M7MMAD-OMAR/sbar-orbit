import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";

const nativeTest = process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip;

nativeTest("a private Fedora application reads the person's GSettings preference without changing its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-preferences-"));
  const source = join(root, "source");
  const control = join(root, "control");
  const script = join(root, "preference.py");
  const result = join(root, "result.json");
  await mkdir(source);
  await mkdir(control);

  const setting = (configHome: string, operation: "get" | "set", value?: number) => {
    const command = ["/usr/bin/dbus-run-session", "--", "/usr/bin/gsettings", operation,
      "org.gnome.desktop.interface", "cursor-size", ...(value === undefined ? [] : [String(value)])];
    const { exitCode, stdout, stderr } = Bun.spawnSync(command, {
      env: { ...process.env, XDG_CONFIG_HOME: configHome, GSETTINGS_BACKEND: "dconf" },
    });
    if (exitCode !== 0) throw new Error(`GSettings fixture failed: ${stderr.toString()}`);
    return stdout.toString().trim();
  };

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousBackend = process.env.GSETTINGS_BACKEND;
  let backend: FedoraBackend | undefined;
  try {
    const defaultValue = Number(setting(control, "get"));
    expect(Number.isInteger(defaultValue)).toBe(true);
    const sourceValue = defaultValue === 47 ? 51 : 47;
    setting(source, "set", sourceValue);
    expect(Number(setting(source, "get"))).toBe(sourceValue);
    expect(Number(setting(control, "get"))).toBe(defaultValue);
    const originalDatabase = await readFile(join(source, "dconf", "user"));

    await writeFile(script, `import json
import os
from pathlib import Path
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, Gtk, GLib

window = Gtk.Window(title="Orbit GSettings fixture")
window.set_default_size(320, 160)
value = Gio.Settings.new("org.gnome.desktop.interface").get_int("cursor-size")
window.add(Gtk.Label(label=str(value)))
window.connect("destroy", Gtk.main_quit)
window.show_all()

def record():
    Path(sys.argv[1]).write_text(json.dumps({
        "value": value,
        "configHome": os.environ.get("XDG_CONFIG_HOME"),
        "waylandDisplay": os.environ.get("WAYLAND_DISPLAY"),
    }))
    return False

GLib.idle_add(record)
Gtk.main()
`);

    process.env.XDG_CONFIG_HOME = source;
    process.env.GSETTINGS_BACKEND = "dconf";
    backend = await FedoraBackend.create();
    await backend.act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", script, result] });

    let observed: { value: number; configHome: string; waylandDisplay: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { observed = JSON.parse(await readFile(result, "utf8")); break; } catch { await Bun.sleep(30); }
    }
    expect(observed).toBeDefined();
    expect(observed?.value).toBe(sourceValue);
    expect(observed?.value).not.toBe(defaultValue);
    expect(observed?.configHome).not.toBe(source);
    expect(observed?.waylandDisplay).toBeTruthy();
    expect(await readFile(join(source, "dconf", "user"))).toEqual(originalDatabase);
    expect(Number(setting(source, "get"))).toBe(sourceValue);
    expect(Number(setting(control, "get"))).toBe(defaultValue);
  } finally {
    await backend?.close();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousBackend === undefined) delete process.env.GSETTINGS_BACKEND;
    else process.env.GSETTINGS_BACKEND = previousBackend;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
