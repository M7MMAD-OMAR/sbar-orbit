#!/usr/bin/python3
"""Native GTK3 entry for measured background copy/paste."""
import json
import os
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
from lab import guard

guard(os.environ)
output = Path(sys.argv[1])
entry = Gtk.Entry()
entry.set_text(sys.argv[2] if len(sys.argv) > 2 else "Agent clipboard 0123")


def report(*args):
    with output.open("a") as stream:
        stream.write(json.dumps({"text": entry.get_text()}, ensure_ascii=True) + "\n")


window = Gtk.Window(title="Agent clipboard fixture")
window.set_default_size(600, 150)
window.add(entry)
entry.connect("changed", report)
window.connect("destroy", Gtk.main_quit)
window.show_all()
report()
Gtk.main()
