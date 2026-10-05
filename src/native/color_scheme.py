"""Initialize one admitted application's private color preference before exec."""
import json
import os
from pathlib import Path
import sys
import subprocess
import gi

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from gi.repository import Gio, GLib
from src.native.application import private_directory
from src.native.budget import require_budget
from src.native.lease import NativeLease, process_identity

SCHEMES = {"default": 0, "prefer-dark": 1, "prefer-light": 2}


def validate_environment(profile, environment, scheme):
    if not isinstance(scheme, str) or scheme not in SCHEMES:
        raise RuntimeError("Invalid native color preference")
    profile = private_directory(profile)
    expected = {"HOME": str(profile / "home"), "XDG_CONFIG_HOME": str(profile / "config"),
                "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
                "XDG_STATE_HOME": str(profile / "state"), "XDG_RUNTIME_DIR": str(profile / "run"),
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path={profile / 'session'}",
                "AT_SPI_BUS_ADDRESS": f"unix:path={profile / 'run' / 'at-spi' / 'bus'}",
                "GSETTINGS_BACKEND": "dconf"}
    if any(environment.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Color preference requires the exact private application environment")
    for name in ("home", "config", "data", "cache", "state", "run"):
        private_directory(profile / name)
    return profile


def main(profile, unit, scheme):
    require_budget()
    profile = validate_environment(profile, os.environ, scheme)
    lease = NativeLease(unit)
    if not lease.contains(process_identity(os.getpid())):
        raise RuntimeError("Color preference writer escaped the application scope")
    portal = profile / "config" / "xdg-desktop-portal"
    portal.mkdir(mode=0o700)
    with open(portal / "portals.conf", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        output.write("[preferred]\ndefault=gtk\norg.freedesktop.impl.portal.Settings=gtk\n")
    settings = Gio.Settings.new("org.gnome.desktop.interface")
    if not settings.set_string("color-scheme", scheme):
        raise RuntimeError("Private color preference write failed")
    Gio.Settings.sync()
    readback = subprocess.run(["/usr/bin/gsettings", "get", "org.gnome.desktop.interface", "color-scheme"],
                              capture_output=True, text=True, timeout=1, check=True)
    if len(readback.stdout) > 1024 or readback.stdout.strip() != repr(scheme):
        raise RuntimeError("Independent private color preference readback differs")
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = connection.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                                 "org.freedesktop.portal.Settings", "ReadAll",
                                 GLib.Variant("(as)", (["org.freedesktop.appearance"],)),
                                 GLib.VariantType("(a{sa{sv}})"), Gio.DBusCallFlags.NONE, 2000, None)
    if reply.get_size() > 32768 or reply.unpack()[0].get("org.freedesktop.appearance", {}).get("color-scheme") != SCHEMES[scheme]:
        raise RuntimeError("Private Settings portal color preference differs")
    services = {}
    for name in ("ca.desrt.dconf", "org.freedesktop.portal.Desktop", "org.freedesktop.impl.portal.desktop.gtk"):
        reply = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                     "GetConnectionUnixProcessID", GLib.Variant("(s)", (name,)),
                                     GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 500, None)
        identity = process_identity(reply.unpack()[0])
        if not lease.contains(identity):
            raise RuntimeError("Private settings service escaped the application scope: " + name)
        services[name] = identity
    lease.verify()
    with open(profile / "color-scheme.json", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump({"scheme": scheme, "portalScheme": SCHEMES[scheme], "services": services}, output)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise RuntimeError("Provide private application profile, unit and color preference")
    main(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
