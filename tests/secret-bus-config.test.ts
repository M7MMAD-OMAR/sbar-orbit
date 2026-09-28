import { expect, test } from "bun:test";
import { join } from "node:path";

test("the one-item secret bus refuses host service activation", async () => {
  const python = `
import json, os, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from one_secret import private_bus_config
from gi.repository import Gio, GLib

with tempfile.TemporaryDirectory(prefix="orbit-secret-bus-test-") as temporary:
    root = Path(temporary)
    bus = root / "bus"
    bus.mkdir(mode=0o700)
    config = private_bus_config(bus)
    marker = root / "activated"
    standard = root / "data" / "dbus-1" / "services"
    standard.mkdir(parents=True)
    (standard / "org.example.OrbitMarker.service").write_text(
        "[D-BUS Service]\\nName=org.example.OrbitMarker\\nExec=/usr/bin/touch " + str(marker) + "\\n"
    )
    env = dict(os.environ, XDG_DATA_HOME=str(root / "data"))
    daemon = subprocess.Popen(
        ["/usr/bin/dbus-daemon", f"--config-file={config}", "--nofork", "--print-address=1", "--nopidfile"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    try:
        address = daemon.stdout.readline().strip()
        if not address:
            raise RuntimeError("The private bus did not open")
        connection = Gio.DBusConnection.new_for_address_sync(
            address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None
        )
        blocked = False
        try:
            connection.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "StartServiceByName",
                GLib.Variant("(su)", ("org.example.OrbitMarker", 0)), GLib.VariantType("(u)"),
                Gio.DBusCallFlags.NONE, 3000, None
            )
        except GLib.Error:
            blocked = True
        print(json.dumps({"blocked": blocked, "marker": marker.exists(), "services": list((bus / "services").iterdir()) == []}))
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait(timeout=3)
`;
  const child = Bun.spawn(["/usr/bin/python3", "-c", python, join(import.meta.dir, "..", "src", "native")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(0);
  expect(error).toBe("");
  expect(JSON.parse(output)).toEqual({ blocked: true, marker: false, services: true });
}, 15000);
