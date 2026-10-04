#!/usr/bin/python3
"""GTK broker fixture accepting its owned disk runtime on a private lab display."""
import os
import hashlib
import json
from pathlib import Path
import sys

from native_application_probe import fixture
from src.native.application import private_directory
from src.native.budget import require_budget
from src.native.lease import NativeLease, process_identity
from lab import lab_socket

display = Path(os.environ.get("WAYLAND_DISPLAY", ""))
if not display.is_absolute() or "DISPLAY" in os.environ or "WAYLAND_SOCKET" in os.environ:
    raise SystemExit("Native broker fixture requires a private lab display")
lab_socket(display)
runtime = private_directory(Path(os.environ["XDG_RUNTIME_DIR"]))
if os.environ.get("DBUS_SESSION_BUS_ADDRESS") != f"unix:path={runtime.parent / 'session'}":
    raise SystemExit("Native broker fixture requires its owned application bus")
require_budget()
if not NativeLease(os.environ["ORBIT_NATIVE_UNIT"]).contains(process_identity(os.getpid())):
    raise SystemExit("Native broker fixture is outside its owned lease")
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
settings = Gtk.Settings.get_default()
configuration = Path(os.environ["XDG_CONFIG_HOME"])
hashes = {name: hashlib.sha256((configuration / name).read_bytes()).hexdigest()
          for name in ("gtk-3.0/settings.ini", "gtk-4.0/settings.ini", "kdeglobals")
          if (configuration / name).is_file()}
report = Path(sys.argv[1])
report.with_name("appearance-" + report.name).write_text(json.dumps({
    "configuration_sha256": hashes,
    "gtk_theme": settings.get_property("gtk-theme-name"),
    "gtk_dark": settings.get_property("gtk-application-prefer-dark-theme"),
}))
fixture(Path(sys.argv[1]))
