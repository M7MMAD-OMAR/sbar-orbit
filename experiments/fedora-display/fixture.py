"""Disposable GTK application for native display round-trip verification."""
import json
import os
from pathlib import Path
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

target = Path(sys.argv[1])
window = Gtk.Window(title="Orbit native fixture")
window.set_default_size(1280, 800)
window.set_decorated(False)
layout = Gtk.Fixed()
window.add(layout)
title = Gtk.Label(label="Orbit native application")
layout.put(title, 80, 60)
entry = Gtk.Entry()
entry.set_size_request(400, 48)
layout.put(entry, 80, 160)
button = Gtk.Button(label="Save fixture")
button.set_size_request(180, 48)
layout.put(button, 500, 160)
result = Gtk.Label(label="Waiting for independent input")
layout.put(result, 80, 260)
paste_button = Gtk.Button(label="Paste selection")
paste_button.set_size_request(240, 48)
layout.put(paste_button, 80, 340)
style = Gtk.CssProvider()
style.load_from_data(b"window { background: #f1f4f8; } label, entry, button { font-size: 22px; color: #192842; } button { background-image: none; background-color: #d9e4f4; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

def write_state(saved=None):
    data = {"pid": os.getpid(), "display": Gdk.Display.get_default().get_name(),
            "backend": os.environ["GDK_BACKEND"], "text": entry.get_text(), "saved": saved}
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(target)

def save(_button):
    result.set_text("Saved: " + entry.get_text())
    write_state(entry.get_text())

button.connect("clicked", save)
def paste_selection(_button):
    entry.select_region(0, -1)
    entry.paste_clipboard()

paste_button.connect("clicked", paste_selection)
entry.connect("changed", lambda _entry: write_state())
window.connect("destroy", Gtk.main_quit)
window.show_all()
entry.grab_focus()
GLib.idle_add(write_state)
Gtk.main()
