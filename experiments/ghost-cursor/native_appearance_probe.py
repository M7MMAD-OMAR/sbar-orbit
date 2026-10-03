#!/usr/bin/python3
"""Read GTK4 settings from a prepared private configuration, without a window."""
import configparser
import json
import os
from pathlib import Path
import gi
from lab import guard

guard(os.environ)
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk

Gtk.init()
settings = Gtk.Settings.get_default()
if settings is None:
    raise RuntimeError("No GTK4 display settings")
config = configparser.ConfigParser(interpolation=None, strict=False)
config.read(Path(os.environ["XDG_CONFIG_HOME"]) / "gtk-4.0/settings.ini")
keys = ("gtk-theme-name", "gtk-icon-theme-name", "gtk-font-name", "gtk-cursor-theme-name", "gtk-cursor-theme-size", "gtk-application-prefer-dark-theme")
expected, actual = {}, {}
for key in keys:
    actual[key] = settings.get_property(key)
    if config.has_option("Settings", key):
        value = config.get("Settings", key)
        if key == "gtk-cursor-theme-size":
            value = int(value)
        elif key == "gtk-application-prefer-dark-theme":
            value = config.getboolean("Settings", key)
        expected[key] = value
        if actual[key] != value:
            raise RuntimeError(f"GTK4 did not read the staged property: {key}")
print(json.dumps({"expected": expected, "actual": actual, "gtk4_settings_readback": "pass" if expected else "not measured", "visual_match": "not measured", "qt_readback": "not measured"}, indent=2))
