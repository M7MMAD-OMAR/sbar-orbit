import { expect, test } from "bun:test";
import { parseNativeAction } from "../src/fedora";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";
import { nativeRuntimeName } from "../src/runtime-paths";

test("private desktop accepts useful keyboard chords and navigation", () => {
  for (const key of ["Ctrl+Shift+P", "Ctrl+Alt+T", "Alt+F4", "Shift+Tab", "F5",
    "ArrowLeft", "Home", "End", "PageDown", "Backspace", "Delete", "Space",
    "Ctrl+1", "Ctrl+Minus", "Ctrl+Equal"]) {
    expect(parseNativeAction({ type: "key", key })).toEqual({ type: "key", key });
  }
});

test("private desktop rejects malformed or unbounded keyboard commands", () => {
  for (const key of ["", "P+Ctrl", "Ctrl+Ctrl+A", "Ctrl+", "A+B", "F13",
    "Ctrl+Shift+Alt+Super+A", "Enter\ntext hello", "Esc", "Meta+L", 42]) {
    expect(() => parseNativeAction({ type: "key", key })).toThrow();
  }
});

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("keyboard chords reach only the private GTK window", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-keyboard-"));
  const previousData = process.env.XDG_DATA_HOME;
  const xdgData = join(root, "xdg");
  const runtime = join(xdgData, "sbar-orbit", "runtime", nativeRuntimeName());
  const projectRuntime = resolve(".runtime/sway");
  let sessions: Sessions | undefined;
  try {
    await mkdir(runtime, { recursive: true });
    await symlink(join(projectRuntime, "root"), join(runtime, "root"), "dir");
    const packages = Bun.spawnSync(["pkg-config", "--cflags", "--libs", "wayland-client", "xkbcommon"]);
    expect(packages.exitCode).toBe(0);
    const compile = Bun.spawnSync(["cc", "-Wall", "-Wextra", "-Werror",
      resolve("experiments/fedora-display/pointer.c"), join(projectRuntime, "virtual-pointer.c"),
      join(projectRuntime, "virtual-keyboard.c"), "-I", projectRuntime,
      "-o", join(runtime, "pointer"), ...packages.stdout.toString().trim().split(/\s+/u)]);
    expect(compile.exitCode).toBe(0);
    process.env.XDG_DATA_HOME = xdgData;
    const fixture = join(root, "keyboard.py");
    const result = join(root, "keyboard.json");
    await writeFile(fixture, `import json,sys,gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,Gdk,GLib
target=sys.argv[1]
window=Gtk.Window(title='Orbit private keyboard fixture')
entry=Gtk.Entry()
window.add(entry)
def write(event=None):
 data={'text':entry.get_text()}
 if event is not None:
  data['key']=Gdk.keyval_name(event.keyval)
  data['ctrl']=bool(event.state & Gdk.ModifierType.CONTROL_MASK)
  data['shift']=bool(event.state & Gdk.ModifierType.SHIFT_MASK)
 with open(target+'.tmp','w') as file: json.dump(data,file)
 import os;os.replace(target+'.tmp',target)
window.connect('key-press-event',lambda widget,event:write(event))
entry.connect('changed',lambda widget:write())
window.connect('destroy',Gtk.main_quit)
window.show_all();entry.grab_focus();GLib.idle_add(write);Gtk.main()
`);
    sessions = new Sessions(join(root, "sessions"));
    const run = (method: string, params: unknown = {}) => sessions!.dispatch({ method, params });
    const session = await run("session.create", { backend: "fedora" }) as { sessionId: string };
    const act = (action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
    await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", fixture, result] });
    await act({ type: "text", text: "abc" });
    await act({ type: "key", key: "Home" });
    await act({ type: "text", text: "X" });
    let state: { text?: string; key?: string; ctrl?: boolean; shift?: boolean } = {};
    for (let attempt = 0; attempt < 80; attempt++) {
      try { state = JSON.parse(await readFile(result, "utf8")); } catch {}
      if (state.text === "Xabc") break;
      await Bun.sleep(50);
    }
    expect(state.text).toBe("Xabc");
    await act({ type: "key", key: "Ctrl+Shift+P" });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { state = JSON.parse(await readFile(result, "utf8")); } catch {}
      if (state.key === "P" && state.ctrl && state.shift) break;
      await Bun.sleep(50);
    }
    expect(state).toMatchObject({ key: "P", ctrl: true, shift: true });
    await act({ type: "key", key: "Enter" });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { state = JSON.parse(await readFile(result, "utf8")); } catch {}
      if (state.key === "Return") break;
      await Bun.sleep(50);
    }
    expect(state.key).toBe("Return");
    await run("session.stop", session);
  } finally {
    await sessions?.close();
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
