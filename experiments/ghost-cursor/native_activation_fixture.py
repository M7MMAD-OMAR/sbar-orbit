#!/usr/bin/python3
"""D-Bus activation fixture reporting the daemon's inherited private profile."""
import json
import os
from pathlib import Path
import sys

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.lease import process_identity
from lab import guard


def main():
    guard(os.environ)
    require_budget()
    report = Path(sys.argv[1])
    keys = ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
            "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS")
    temporary = report.with_suffix(".pending")
    temporary.write_text(json.dumps({"environment": {key: os.environ.get(key) for key in keys},
                                     "process": process_identity(os.getpid())}))
    temporary.replace(report)
    loop = GLib.MainLoop()
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    owner = Gio.bus_own_name_on_connection(connection, "org.sbarorbit.ActivationFixture",
                                           Gio.BusNameOwnerFlags.NONE, None, None)
    GLib.timeout_add_seconds(30, lambda: (loop.quit(), False)[1])
    try:
        loop.run()
    finally:
        Gio.bus_unown_name(owner)


if __name__ == "__main__":
    main()
