#!/usr/bin/python3
"""Two native windows sharing a client, for mixed-ownership refusal checks."""
import os
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
from lab import guard

guard(os.environ)
windows = []
for title in ("Agent mixed target", "Person mixed window"):
    window = Gtk.Window(title=title)
    window.set_default_size(600, 150)
    entry = Gtk.Entry()
    entry.set_text(title)
    window.add(entry)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    windows.append(window)
Gtk.main()
