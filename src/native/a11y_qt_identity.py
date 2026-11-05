"""Explicit in-process lifetime routes for opted-in original Qt QWidget apps.

Ordinary Qt numeric AT-SPI paths are not strong retention. The reviewed helper
binds each supported widget to a fresh UUID and QPointer inside the application.
Its UI-thread method validates that exact widget immediately before mutation.
Virtual subelements and applications without the exact helper stay unsupported.
"""
import hashlib
import json
import os
from pathlib import Path
import re

BRIDGE = Path(__file__).resolve().parent / "qt" / "liborbit-qt-widget.so"
SOURCE = BRIDGE.with_name("widget_bridge.cpp")
BASE = "/org/sbar/Orbit/QtWidget"
INTERFACE = "org.sbar.Orbit.QtWidget1"
ROUTE = re.compile(re.escape(BASE) + r"/[0-9a-f]{32}", re.ASCII)
ORIGINAL = re.compile(r"/org/a11y/atspi/accessible/[0-9]{1,10}", re.ASCII)


def _digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def mapped_bridge(pid):
    """Corroborate exact mapped inode, current reviewed source and build receipt."""
    before = BRIDGE.stat()
    if not 0 < before.st_size <= 4 * 1024 * 1024:
        return False
    receipt_path = Path(str(BRIDGE) + ".source.json")
    if receipt_path.stat().st_size > 1024:
        return False
    receipt = json.loads(receipt_path.read_text())
    if (type(receipt) is not dict or set(receipt) != {"schema", "sourceSha256", "librarySha256"}
            or type(receipt["schema"]) is not int or receipt["schema"] != 1 or receipt["sourceSha256"] != _digest(SOURCE)):
        return False
    mappings = Path("/proc", str(pid), "maps").read_text()
    if len(mappings) > 2_000_000:
        return False
    found = False
    for line in mappings.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6 or fields[5] != str(BRIDGE):
            continue
        if str(before.st_ino) != fields[4] or os.readlink(Path("/proc", str(pid), "map_files", fields[0])) != str(BRIDGE):
            return False
        found = True
    digest = _digest(BRIDGE)
    after = BRIDGE.stat()
    return (found and digest == receipt["librarySha256"]
            and mappings == Path("/proc", str(pid), "maps").read_text()
            and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))


class QtIdentity:
    def __init__(self, app, frame, nodes, identity, pid):
        self.bus = None
        self.routes = {}
        if app.get_toolkit_name() != "Qt" or app.get_toolkit_version() != "6.11.2" or not mapped_bridge(pid):
            raise ValueError("Unsupported Qt provider")
        original_owner, root, root_pid = identity(frame)
        if root_pid != pid or ORIGINAL.fullmatch(root) is None:
            raise ValueError("Unsupported Qt root")
        # Binding after traversal could attest a replacement at a reused numeric
        # path. The host must construct this proof before any node field read.
        if nodes is not None:
            raise ValueError("Qt lifetime requires pre-read binding")
        self.root = root
        self.unsupported = set()
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.address = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress",
            None, GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 500, None).unpack()[0]
        self.bus = Gio.DBusConnection.new_for_address_sync(self.address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        try:
            self.pid = pid
            self.original_owner = original_owner
            self.owner = self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
                GLib.Variant("(s)", ("org.sbar.Orbit.QtWidget.p" + str(pid),)), "(s)")[0]
            if re.fullmatch(r":[0-9]+\.[0-9]+", self.owner) is None:
                raise ValueError("Invalid Qt bridge owner")
            self.bus_id = self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", None, "(s)")[0]
            if self._pid(self.owner) != pid or self._pid(original_owner) != pid:
                raise ValueError("Qt provider process changed")
            if self._call(self.owner, BASE, INTERFACE, "Version", None, "(ss)") != ("orbit-qt-widget-1", "6.11.2"):
                raise ValueError("Unsupported Qt bridge ABI")
            if not self.bind(root) or not self.current(root):
                raise ValueError("Qt root is unavailable")
        except BaseException:
            self.close()
            raise

    def _call(self, owner, path, interface, method, args, result):
        return self.bus.call_sync(owner, path, interface, method, args,
            self.GLib.VariantType.new(result), self.Gio.DBusCallFlags.NONE, 500, None).unpack()

    def _pid(self, owner):
        return self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
            self.GLib.Variant("(s)", (owner,)), "(u)")[0]

    def bind(self, path):
        """Called before the host reads this node's role, name, state or bounds."""
        if ORIGINAL.fullmatch(path) is None:
            return False
        if path in self.unsupported:
            return False
        if path in self.routes:
            if not self.current(path):
                raise ValueError("Qt node lifetime changed during traversal")
            return True
        routes = self._call(self.owner, BASE, INTERFACE, "Bind",
            self.GLib.Variant("(sas)", (self.root, [path])), "(a{ss})")[0]
        if (type(routes) is not dict or len(routes) > 1
                or any(original != path or ROUTE.fullmatch(route) is None or route in self.routes.values()
                       for original, route in routes.items())):
            raise ValueError("Invalid Qt widget binding")
        if not routes:
            self.unsupported.add(path)
            return False
        self.routes.update(routes)
        return True

    def retain(self, nodes, identity):
        """Validate original-ID/UUID pairs after traversal, then release extras."""
        paths = {self.root}
        for node in nodes:
            owner, path, pid = identity(node)
            if owner != self.original_owner or pid != self.pid:
                raise ValueError("Qt provider identity changed")
            paths.add(path)
        wanted = {path: route for path, route in self.routes.items() if path in paths}
        if not wanted or len(wanted) > 302:
            raise ValueError("Qt snapshot binding limit exceeded")
        if self._call(self.owner, BASE, INTERFACE, "Verify", self.GLib.Variant("(a{ss})", (wanted,)), "(b)") != (True,):
            raise ValueError("Qt node lifetime changed during traversal")
        unused = [route for path, route in self.routes.items() if path not in wanted]
        for offset in range(0, len(unused), 301):
            self._call(self.owner, BASE, INTERFACE, "Release", self.GLib.Variant("(as)", (unused[offset:offset + 301],)), "()")
        self.routes = wanted
        self.unsupported.clear()
        return self

    def supports(self, path):
        return path in self.routes

    def target(self, path):
        if not self.supports(path):
            raise ValueError("Unsupported virtual Qt target")
        return {"owner": self.owner, "path": self.routes[path], "address": self.address, "busId": self.bus_id, "pid": self.pid}

    def current(self, path):
        if self.bus is None or self.bus.is_closed() or path not in self.routes:
            return False
        try:
            if (self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", None, "(s)")[0] != self.bus_id
                    or self._pid(self.owner) != self.pid):
                return False
            self._call(self.owner, self.routes[path], "org.a11y.atspi.Accessible", "GetState", None, "(au)")
            return True
        except Exception:
            return False

    def close(self):
        if self.bus is not None and not self.bus.is_closed():
            if self.routes:
                try:
                    routes = list(self.routes.values())
                    for offset in range(0, len(routes), 301):
                        self._call(self.owner, BASE, INTERFACE, "Release", self.GLib.Variant("(as)", (routes[offset:offset + 301],)), "()")
                except Exception:
                    pass
            self.routes = {}
            self.bus.close_sync(None)
