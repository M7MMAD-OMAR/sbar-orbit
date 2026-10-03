#!/usr/bin/python3
"""Apply one color-scheme enum through installed private GSettings/portal services."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.lease import NativeLease, process_identity
from lab import guard

SCHEMES = {"default": 0, "prefer-dark": 1, "prefer-light": 2}


def validate_profile(work, environment):
    lab = Path(environment["XDG_RUNTIME_DIR"]).parent
    info = work.lstat()
    if work.resolve().parent != lab or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Color-scheme profile must be a private lab child")
    expected = {"HOME": str(work / "home"), "XDG_CONFIG_HOME": str(work / "config"),
                "XDG_DATA_HOME": str(work / "data"), "XDG_CACHE_HOME": str(work / "cache"),
                "XDG_STATE_HOME": str(work / "state"), "DBUS_SESSION_BUS_ADDRESS": f"unix:path={work / 'session'}",
                "AT_SPI_BUS_ADDRESS": f"unix:path={work / 'a11y'}", "GSETTINGS_BACKEND": "dconf"}
    if any(environment.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Refusing color-scheme writes outside the exact private profile")
    for name in ("home", "config", "data", "cache", "state"):
        info = (work / name).lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Color-scheme directories must be private and cannot be links")


def read_scheme(work):
    descriptor = os.open(work / "color-scheme.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as plan:
        info = os.fstat(plan.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 1024:
            raise RuntimeError("Color-scheme plan must be a bounded owned regular file")
        value = json.loads(plan.read(1025))
    if not isinstance(value, dict) or set(value) != {"color_scheme"} or not isinstance(value["color_scheme"], str) or value["color_scheme"] not in SCHEMES:
        raise RuntimeError("Invalid color-scheme enum")
    return value["color_scheme"]


def main():
    guard(os.environ)
    require_budget()
    if len(sys.argv) != 3:
        raise RuntimeError("Provide the private profile and its exact generated scope")
    work = Path(sys.argv[1])
    validate_profile(work, os.environ)
    scheme = read_scheme(work)
    lease = NativeLease(sys.argv[2])
    if not lease.contains(process_identity(os.getpid())):
        raise RuntimeError("Settings writer is outside its application scope")
    portals = work / "config" / "xdg-desktop-portal"
    portals.mkdir(mode=0o700)
    with open(portals / "portals.conf", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as config:
        config.write("[preferred]\ndefault=gtk\norg.freedesktop.impl.portal.Settings=gtk\n")
    settings = Gio.Settings.new("org.gnome.desktop.interface")
    if not settings.set_string("color-scheme", scheme):
        raise RuntimeError("Private GSettings color-scheme write failed")
    Gio.Settings.sync()
    readback = subprocess.run(["/usr/bin/gsettings", "get", "org.gnome.desktop.interface", "color-scheme"],
                              capture_output=True, text=True, timeout=3, check=True)
    if readback.stdout.strip() != repr(scheme):
        raise RuntimeError("Separate-process private GSettings readback differs")
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = connection.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                                 "org.freedesktop.portal.Settings", "ReadAll",
                                 GLib.Variant("(as)", (["org.freedesktop.appearance"],)),
                                 GLib.VariantType.new("(a{sa{sv}})"), Gio.DBusCallFlags.NONE, 5000, None)
    appearance = reply.unpack()[0].get("org.freedesktop.appearance", {})
    if appearance.get("color-scheme") != SCHEMES[scheme]:
        raise RuntimeError(f"Private Settings portal returned another scheme: {appearance}")
    identities = {}
    for name in ("ca.desrt.dconf", "org.freedesktop.portal.Desktop", "org.freedesktop.impl.portal.desktop.gtk"):
        result = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                      "GetConnectionUnixProcessID", GLib.Variant("(s)", (name,)),
                                      GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 1000, None)
        identity = process_identity(result.unpack()[0])
        if not lease.contains(identity):
            raise RuntimeError(f"Settings service outside application scope: {name}")
        identities[name] = identity
    report = {"color_scheme": scheme, "gsettings_readback": "pass", "portal_color_scheme": SCHEMES[scheme],
              "service_scope_membership": "pass", "services": identities}
    temporary = work / "color-scheme-report.pending"
    with open(temporary, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(report, output)
    temporary.replace(work / "color-scheme-report.json")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
