"""Private desktop accessibility service and bounded, read-only inspection."""
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import sys
import time


def identity(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    return [pid, fields[19]]


def private_bus(directory, address):
    expected = f"unix:path={directory / 'at-spi' / 'bus'}"
    if address != expected:
        raise RuntimeError("Accessibility address is not the private socket")
    path = directory / "at-spi" / "bus"
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("Accessibility socket has invalid ownership")
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(1)
        peer.connect(str(path))
        pid, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != os.getuid():
        raise RuntimeError("Accessibility bus has a foreign peer")
    return (info.st_dev, info.st_ino, identity(pid))


def connection(address):
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
    bus = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)

    def call(name, path, interface, method, signature=None, args=()):
        params = GLib.Variant(signature, args) if signature else None
        return bus.call_sync(name, path, interface, method, params, None,
                             Gio.DBusCallFlags.NO_AUTO_START, 350, None).unpack()
    return call


def serve(directory):
    if os.environ.get("DBUS_SESSION_BUS_ADDRESS") != f"unix:path={directory / 'bus'}":
        raise RuntimeError("Accessibility service requires the private session bus")
    environment = {**os.environ, "ATSPI_DBUS_IMPLEMENTATION": "dbus-daemon"}
    # X11 DISPLAY otherwise changes the launcher socket suffix. Apps use the explicit address.
    environment.pop("DISPLAY", None)
    launcher = subprocess.Popen(["/usr/libexec/at-spi-bus-launcher", "--launch-immediately", "--a11y=1"], env=environment)
    address = os.environ["AT_SPI_BUS_ADDRESS"]
    deadline = time.monotonic() + 5
    while not (directory / "at-spi" / "bus").exists():
        if launcher.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError("Private accessibility bus did not start")
        time.sleep(.02)
    initial = private_bus(directory, address)
    if os.getsid(initial[2][0]) != os.getsid(0):
        raise RuntimeError("Accessibility peer escaped service session")
    session = connection(environment["DBUS_SESSION_BUS_ADDRESS"])
    returned = session("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress")[0]
    if returned.split(",guid=")[0] != address:
        raise RuntimeError("Accessibility service returned a foreign address")
    registry = subprocess.Popen(["/usr/libexec/at-spi2-registryd"], env={**environment, "DBUS_SESSION_BUS_ADDRESS": address})
    call = connection(address)
    while True:
        try:
            call("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", "org.a11y.atspi.Accessible", "GetChildren")
            break
        except Exception:
            if registry.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Private accessibility registry did not start")
            time.sleep(.03)
    (directory / "accessibility-ready.json").write_text(json.dumps({"socket": initial, "service": identity(os.getpid()), "launcher": identity(launcher.pid), "registry": identity(registry.pid)}))
    while launcher.poll() is None and registry.poll() is None:
        time.sleep(.2)
    raise RuntimeError("Private accessibility service exited")


def inspect_tree(call, pid, title, check):
    """Only traverse the authenticated application sender and one exact top-level window."""
    deadline = time.monotonic() + 4
    def bounded(name, path, interface, method, signature=None, args=()):
        if time.monotonic() > deadline:
            raise RuntimeError("Accessibility inspection timed out")
        check()
        return call(name, path, interface, method, signature, args)
    accessible = "org.a11y.atspi.Accessible"
    roots = bounded("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", accessible, "GetChildren")[0]
    if len(roots) > 128:
        raise RuntimeError("Accessibility application count exceeds bound")
    matched = []
    for sender, path in roots:
        if not sender.startswith(":"):
            continue
        owner = bounded("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", "(s)", (sender,))[0]
        if owner == pid:
            matched.append((sender, path))
    if len(matched) != 1:
        raise RuntimeError("Private application accessibility is unavailable or ambiguous")
    sender, root = matched[0]
    children = bounded(sender, root, accessible, "GetChildren")[0]
    if len(children) > 128:
        raise RuntimeError("Accessibility window count exceeds bound")
    windows = []
    for child_sender, path in children:
        if child_sender != sender:
            raise RuntimeError("Accessibility tree changed application sender")
        name = bounded(sender, path, "org.freedesktop.DBus.Properties", "Get", "(ss)", (accessible, "Name"))[0]
        if name == title:
            windows.append(path)
    if len(windows) != 1:
        raise RuntimeError("Accessibility window identity is unavailable or ambiguous")
    nodes, stack, seen = [], [(windows[0], None, 0)], set()
    truncated = False
    while stack:
        path, parent, depth = stack.pop()
        if path in seen:
            raise RuntimeError("Accessibility tree contains a cycle")
        seen.add(path)
        if len(nodes) >= 256 or depth > 32:
            truncated = True
            break
        properties = bounded(sender, path, "org.freedesktop.DBus.Properties", "GetAll", "(s)", (accessible,))[0]
        role = bounded(sender, path, accessible, "GetRoleName")[0]
        states = bounded(sender, path, accessible, "GetState")[0]
        # Opaque per-snapshot IDs intentionally cannot be used for mutations.
        node_id = str(len(nodes) + 1)
        if len(states) != 2 or any(type(state) is not int or not 0 <= state <= 0xffffffff for state in states):
            raise RuntimeError("Invalid accessibility states")
        nodes.append({"elementId": node_id, "parent": parent, "role": str(role)[:100],
                      "name": str(properties.get("Name", ""))[:512], "states": list(states), "actions": []})
        children = bounded(sender, path, accessible, "GetChildren")[0]
        if len(children) > 256:
            truncated = True
            children = children[:256]
        for child_sender, child_path in reversed(children):
            if child_sender != sender:
                raise RuntimeError("Accessibility tree changed application sender")
            stack.append((child_path, node_id, depth + 1))
    check()
    return {"nodes": nodes, "truncated": truncated}


def inspect(directory, pid, start, title):
    address = os.environ.get("AT_SPI_BUS_ADDRESS", "")
    expected = private_bus(directory, address)
    ready = json.loads((directory / "accessibility-ready.json").read_text())
    if list(expected[:2]) != ready["socket"][:2] or expected[2] != ready["socket"][2]:
        raise RuntimeError("Private accessibility bus identity changed")
    def check():
        if identity(pid) != [pid, start]:
            raise RuntimeError("Accessibility target process changed")
    result = inspect_tree(connection(address), pid, title, check)
    if private_bus(directory, address) != expected:
        raise RuntimeError("Accessibility bus changed during inspection")
    encoded = json.dumps(result)
    if len(encoded.encode()) > 262144:
        raise RuntimeError("Accessibility output exceeds bound")
    print(encoded)


if __name__ == "__main__":
    from budget import require_budget
    require_budget()
    directory = Path(sys.argv[2])
    if not directory.is_absolute() or directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise RuntimeError("Invalid private accessibility directory")
    if sys.argv[1] == "serve":
        serve(directory)
    elif sys.argv[1] == "inspect":
        signal.alarm(6)
        inspect(directory, int(sys.argv[3]), sys.argv[4], sys.argv[5])
    else:
        raise RuntimeError("Unsupported accessibility operation")
