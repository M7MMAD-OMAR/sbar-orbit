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

test("libsecret still reads the one synthetic item on the private bus", async () => {
  const python = String.raw`
import json, os, subprocess, sys
service = '''
import shutil, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, "src/native")
from one_secret import private_bus_config, serve_one_secret
root = Path(tempfile.mkdtemp(prefix="orbit-secret-fixture-"))
config = private_bus_config(root)
daemon = subprocess.Popen(
    ["/usr/bin/dbus-daemon", f"--config-file={config}", "--nofork", "--print-address=1", "--nopidfile"],
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
)
try:
    address = daemon.stdout.readline().strip()
    serve_one_secret(address, "fixture-secret", {"application": "chrome"}, "Fixture")
finally:
    daemon.terminate()
    daemon.wait(timeout=3)
    shutil.rmtree(root)
'''
server = subprocess.Popen(
    ["/usr/bin/python3", "-u", "-c", service],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
)
try:
    announcement = json.loads(server.stdout.readline())
    client = '''
import gi
gi.require_version("Secret", "1")
from gi.repository import Secret
schema = Secret.Schema.new(
    "chrome_libsecret_os_crypt_password_v2", Secret.SchemaFlags.DONT_MATCH_NAME,
    {"application": Secret.SchemaAttributeType.STRING}
)
value = Secret.password_lookup_sync(schema, {"application": "chrome"}, None)
print("MATCH" if value == "fixture-secret" else "MISMATCH")
'''
    environment = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=announcement["address"])
    result = subprocess.run(
        ["/usr/bin/python3", "-c", client], env=environment,
        capture_output=True, text=True, timeout=6
    )
    print(json.dumps({"clientExit": result.returncode, "result": result.stdout.strip()}))
finally:
    server.stdin.close()
    server.wait(timeout=3)
`;
  const child = Bun.spawn(["/usr/bin/python3", "-c", python], { stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(0);
  expect(error).toBe("");
  expect(JSON.parse(output)).toEqual({ clientExit: 0, result: "MATCH" });
}, 15000);
