#!/usr/bin/python3
"""The person's stand-in: a GTK4 text window that reports its own state.

Every change to its buffer, caret or selection is written as one JSON line to stdout, which the
harness reads through a pipe. Nothing goes through a file, so an agent cannot rewrite the evidence
(it could with the earlier file mirror: the adversarial review of 3 October 2026 forged B3 that way).
Run it under WAYLAND_DEBUG=client with stderr piped to the harness, which counts every wl_keyboard,
wl_pointer and zwp_text_input_v3 enter or leave, every modifier group change and every clipboard
offer it receives.
"""
import json, sys
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk


def report(buffer, *_):
    text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)
    caret = buffer.get_iter_at_mark(buffer.get_insert()).get_offset()
    bound = buffer.get_iter_at_mark(buffer.get_selection_bound()).get_offset()
    sys.stdout.write(json.dumps({"text": text, "caret": caret, "selection": [min(caret, bound), max(caret, bound)]}) + "\n")
    sys.stdout.flush()


def activate(app):
    win = Gtk.ApplicationWindow(application=app, title="person-standin")
    win.set_default_size(900, 700)
    view = Gtk.TextView()
    buf = view.get_buffer()
    buf.connect("changed", report)
    buf.connect("mark-set", report)
    report(buf)
    win.set_child(view)
    win.present()
    view.grab_focus()


app = Gtk.Application(application_id="lab.person.standin")
app.connect("activate", activate)
app.run([])
