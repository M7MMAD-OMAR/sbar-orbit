#!/usr/bin/python3
"""GTK broker fixture accepting its owned disk runtime on a private lab display."""
import os
from pathlib import Path
import sys

from native_application_probe import fixture
from src.native.application import private_directory
from src.native.budget import require_budget
from src.native.lease import NativeLease, process_identity

display = Path(os.environ.get("WAYLAND_DISPLAY", ""))
if not display.is_absolute() or not str(display).startswith("/tmp/gl-") or not display.is_socket() or "DISPLAY" in os.environ:
    raise SystemExit("Native broker fixture requires a private lab display")
runtime = private_directory(Path(os.environ["XDG_RUNTIME_DIR"]))
if os.environ.get("DBUS_SESSION_BUS_ADDRESS") != f"unix:path={runtime.parent / 'session'}":
    raise SystemExit("Native broker fixture requires its owned application bus")
require_budget()
if not NativeLease(os.environ["ORBIT_NATIVE_UNIT"]).contains(process_identity(os.getpid())):
    raise SystemExit("Native broker fixture is outside its owned lease")
fixture(Path(sys.argv[1]))
