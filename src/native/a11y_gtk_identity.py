"""Runtime qualification for the reviewed GTK per-realization UUID provider.

This assumes the ordinary same-user application uses its mapped GTK exporter,
not a malicious replacement exporter. Other providers remain read-only. Direct
managed-bus validation avoids treating a libatspi proxy as remote retention.
"""
import hashlib
import os
from pathlib import Path
import re

GTK_SHA256 = "d30ad305f7e77c2b284b6098d968734be5d4e617de6f94182ffc2c9ef4a542fe"
UUID = re.compile(r"[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}", re.ASCII)


def mapped_gtk(pid):
    mappings = Path("/proc", str(pid), "maps").read_text()
    if len(mappings) > 2_000_000:
        return False
    found = set()
    for line in mappings.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6 or not fields[5].endswith("/libgtk-4.so.1.2200.5"):
            continue
        path = Path("/proc", str(pid), "root") / fields[5].lstrip("/")
        info = path.stat()
        # Btrfs reports a subvolume device from stat, while /proc/maps uses the
        # superblock device. Corroborate the kernel-held mapping path and inode
        # instead of equating those different device namespaces.
        mapped = Path("/proc", str(pid), "map_files", fields[0])
        if str(info.st_ino) != fields[4] or os.readlink(mapped) != fields[5]:
            return False
        if not 0 < info.st_size <= 64 * 1024 * 1024:
            return False
        found.add(path)
    if len(found) != 1:
        return False
    source = next(iter(found))
    before = source.stat()
    with source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    after = source.stat()
    return (digest == GTK_SHA256 and mappings == Path("/proc", str(pid), "maps").read_text()
            and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))


class GtkIdentity:
    toolkit = "GTK"

    def __init__(self, app, frame, nodes, identity, pid):
        if app.get_toolkit_name() != "GTK" or app.get_toolkit_version() != "4.22.5" or not mapped_gtk(pid):
            raise ValueError("Unsupported provider")
        owner, root, root_pid = identity(frame)
        base, _, suffix = root.rpartition("/")
        if root_pid != pid or not base.endswith("/a11y") or UUID.fullmatch(suffix) is None:
            raise ValueError("Unsupported provider lifetime")
        for node in nodes:
            node_owner, path, node_pid = identity(node)
            if node_owner != owner or node_pid != pid or not path.startswith(base + "/") or UUID.fullmatch(path[len(base) + 1:]) is None:
                raise ValueError("Unsupported descendant lifetime")
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        address = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress",
            None, GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 500, None).unpack()[0]
        self.address = address
        self.bus = Gio.DBusConnection.new_for_address_sync(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        self.owner, self.pid, self.root, self.base = owner, pid, root, base
        self.bus_id = self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", None, "(s)")[0]
        try:
            exported = self._call(owner, "/org/a11y/atspi/accessible/root", "org.a11y.atspi.Application", "GetApplicationBusAddress", None, "(s)")[0]
        except GLib.Error as error:
            # GTK's introspection may omit this legacy method even when its
            # C handler retains a branch. libatspi 2.60.7 keeps the shared bus
            # on this exact refusal; it has no private address to follow.
            if Gio.DBusError.get_remote_error(error) != "org.freedesktop.DBus.Error.UnknownMethod":
                raise
            exported = address
        if exported != address or not self.current(root):
            raise ValueError("Unqualified provider route")

    def _call(self, owner, path, interface, method, args, result):
        return self.bus.call_sync(owner, path, interface, method, args,
            self.GLib.VariantType.new(result), self.Gio.DBusCallFlags.NONE, 500, None).unpack()

    def current(self, path):
        if self.bus.is_closed():
            return False
        try:
            if self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", None, "(s)")[0] != self.bus_id:
                return False
            pid = self._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                self.GLib.Variant("(s)", (self.owner,)), "(u)")[0]
            if pid != self.pid or not path.startswith(self.base + "/") or UUID.fullmatch(path[len(self.base) + 1:]) is None:
                return False
            # A removed UUID no longer exports GetState. Never substitute another path.
            self._call(self.owner, path, "org.a11y.atspi.Accessible", "GetState", None, "(au)")
            return True
        except Exception:
            return False

    def supports(self, path):
        return path.startswith(self.base + "/") and UUID.fullmatch(path[len(self.base) + 1:]) is not None

    def target(self, path):
        if not self.supports(path):
            raise ValueError("Unsupported provider route")
        return {"owner": self.owner, "path": path, "address": self.address,
                "busId": self.bus_id, "pid": self.pid}

    def close(self):
        if not self.bus.is_closed():
            self.bus.close_sync(None)
