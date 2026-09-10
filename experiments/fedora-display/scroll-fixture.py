"""Disposable scrollable content with observable adjustment state."""
import json
from pathlib import Path
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk

target = Path(sys.argv[1])
window = Gtk.Window(title="Orbit scroll fixture")
window.set_default_size(1280, 800)
window.set_decorated(False)
scroll = Gtk.ScrolledWindow()
content = Gtk.TextView()
content.get_buffer().set_text("\n".join("Orbit row " + str(i) for i in range(300)))
scroll.add(content)
window.add(scroll)

def record(*_args):
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"vertical": scroll.get_vadjustment().get_value(),
                                     "horizontal": scroll.get_hadjustment().get_value(),
                                     "deviceManager": Gdk.Display.get_default().get_device_manager().__gtype__.name}))
    temporary.replace(target)
    return False

scroll.get_vadjustment().connect("value-changed", record)
scroll.get_hadjustment().connect("value-changed", record)
window.connect("destroy", Gtk.main_quit)
window.show_all()
GLib.idle_add(record)
Gtk.main()
