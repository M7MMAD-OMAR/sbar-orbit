#!/usr/bin/python3
"""Raw-input fixture. DrawingArea has no editable accessibility interface.

Events are streamed to stdout for an external observer. Clicking the drawing
area sets widget focus without asking the compositor for seat focus.
"""
import json
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

state = {"text": "", "clicks": 0, "scrolls": 0, "x": 0, "y": 0}


def report():
    print(json.dumps(state, ensure_ascii=False), flush=True)


def draw(area, cr):
    cr.set_source_rgb(0.06, 0.09, 0.15)
    cr.paint()
    cr.set_source_rgb(0.95, 0.96, 1)
    cr.select_font_face("Sans")
    cr.set_font_size(24)
    for i, text in enumerate(["Agent background canvas", state["text"],
                              f'Clicks: {state["clicks"]}   Scrolls: {state["scrolls"]}']):
        cr.move_to(28, 55 + i * 45)
        cr.show_text(text)
    return False


def click(area, event):
    area.grab_focus()
    state.update(clicks=state["clicks"] + 1, x=event.x, y=event.y)
    report()
    area.queue_draw()
    return True


def key(area, event):
    if event.keyval == Gdk.KEY_BackSpace:
        state["text"] = state["text"][:-1]
    else:
        cp = Gdk.keyval_to_unicode(event.keyval)
        if cp:
            state["text"] += chr(cp)
    report()
    area.queue_draw()
    return True


def scroll(area, event):
    state["scrolls"] += 1
    report()
    area.queue_draw()
    return True


win = Gtk.Window(title="Agent raw canvas")
win.set_default_size(720, 420)
area = Gtk.DrawingArea()
area.set_can_focus(True)
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.KEY_PRESS_MASK |
                Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
for event, handler in [("draw", draw), ("button-press-event", click),
                       ("key-press-event", key), ("scroll-event", scroll)]:
    area.connect(event, handler)
win.add(area)
win.connect("destroy", Gtk.main_quit)
win.show_all()
report()
Gtk.main()
