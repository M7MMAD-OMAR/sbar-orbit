#!/usr/bin/python3
"""Event-driven native view of supplied target frames. No capture or input."""
import base64
from dataclasses import dataclass
import json
import math
from pathlib import Path
import struct
import sys
import threading

MAX_IMAGE = 16 * 1024 * 1024
MAX_LINE = 24 * 1024 * 1024
MAX_PIXELS = 16 * 1024 * 1024


def number(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("Invalid " + name)
    return value


@dataclass(frozen=True)
class Frame:
    png: bytes
    width: int
    height: int
    surface_width: float
    surface_height: float
    pointer: tuple | None
    variant: int

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or value.get("mimeType") != "image/png":
            raise ValueError("Native view requires a PNG frame")
        encoded = value.get("image")
        if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE + 2) // 3 * 4:
            raise ValueError("Native frame exceeds the encoded image limit")
        png = base64.b64decode(encoded, validate=True)
        if len(png) > MAX_IMAGE or len(png) < 33 or png[:8] != b"\x89PNG\r\n\x1a\n" or png[12:16] != b"IHDR":
            raise ValueError("Invalid native PNG frame")
        width, height = struct.unpack(">II", png[16:24])
        if (not width or not height or width > 16384 or height > 16384
                or width * height > MAX_PIXELS or value.get("width") != width or value.get("height") != height):
            raise ValueError("Native image dimensions exceed the view limit or disagree with metadata")
        sw = number(value.get("surfaceWidth"), "logical surface width")
        sh = number(value.get("surfaceHeight"), "logical surface height")
        pointer = value.get("pointer")
        if pointer is not None:
            if not isinstance(pointer, dict) or set(pointer) != {"x", "y"}:
                raise ValueError("Invalid native cursor")
            x, y = pointer["x"], pointer["y"]
            if (type(x) not in (int, float) or type(y) not in (int, float)
                    or not math.isfinite(x) or not math.isfinite(y) or not 0 <= x < sw or not 0 <= y < sh):
                raise ValueError("Native cursor lies outside the logical surface")
            pointer = (x, y)
        variant = value.get("cursorVariant")
        if type(variant) is not int or variant not in (0, 1):
            raise ValueError("Invalid native cursor variant")
        return cls(png, width, height, sw, sh, pointer, variant)

    def decode(self):
        from gi.repository import GdkPixbuf
        loader = GdkPixbuf.PixbufLoader.new_with_type("png")
        loader.write(self.png)
        loader.close()
        pixbuf = loader.get_pixbuf()
        if pixbuf is None or pixbuf.get_width() != self.width or pixbuf.get_height() != self.height:
            raise ValueError("Decoded native frame dimensions disagree")
        return pixbuf


def draw_cursor(cr, frame):
    if frame.pointer is None:
        return
    x, y = frame.pointer
    cr.save()
    cr.scale(frame.width / frame.surface_width, frame.height / frame.surface_height)
    cr.translate(x - 4, y - 3)
    cr.set_line_join(1)
    cr.move_to(4, 3)
    for px, py in ((4, 25), (10, 20), (14.5, 30), (19, 28), (14.5, 18.5), (23, 18.5)):
        cr.line_to(px, py)
    cr.close_path()
    cr.set_source_rgb(.10, .14, .20)
    cr.fill_preserve()
    cr.set_source_rgb(.98, .99, 1)
    cr.set_line_width(1.6)
    cr.stroke()
    cr.arc(24, 28, 3.2, 0, math.tau)
    cr.set_source_rgb(*((.28, .55, .98) if frame.variant else (.08, .72, .62)))
    cr.fill_preserve()
    cr.set_source_rgb(.98, .99, 1)
    cr.set_line_width(1.2)
    cr.stroke()
    cr.restore()


def paint(cr, frame, pixbuf, width, height):
    from gi.repository import Gdk
    scale = min(width / frame.width, height / frame.height)
    cr.save()
    cr.translate((width - frame.width * scale) / 2, (height - frame.height * scale) / 2)
    cr.scale(scale, scale)
    cr.rectangle(0, 0, frame.width, frame.height)
    cr.clip()
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
    cr.paint()
    draw_cursor(cr, frame)
    cr.restore()


class NativeView:
    def __init__(self, stream, acknowledgements=False):
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import GLib, Gtk
        self.GLib, self.Gtk, self.stream = GLib, Gtk, stream
        self.acknowledgements = acknowledgements
        self.lock = threading.Lock()
        self.pending = None
        self.scheduled = False
        self.closed = False
        self.ending = False
        self.failure = None
        self.result = 0
        self.frame = None
        self.acknowledge = False
        self.window = Gtk.Window(title="Orbit native target")
        self.window.set_default_size(960, 640)
        header = Gtk.HeaderBar(title="Orbit native target", subtitle="Waiting for a supplied frame")
        header.set_show_close_button(True)
        self.window.set_titlebar(header)
        self.header = header
        self.area = Gtk.DrawingArea()
        self.area.get_accessible().set_name("Agent target image preview")
        self.area.get_accessible().set_description("Visual preview only. No pointer or keyboard input is forwarded.")
        self.area.connect("draw", self.draw)
        self.window.add(self.area)
        self.window.connect("destroy", self.close)

    def draw(self, area, cr):
        self.Gtk.render_background(area.get_style_context(), cr, 0, 0,
                                   area.get_allocated_width(), area.get_allocated_height())
        if self.frame is not None:
            frame, pixbuf = self.frame
            paint(cr, frame, pixbuf, area.get_allocated_width(), area.get_allocated_height())
            if self.acknowledge and self.acknowledgements:
                print(json.dumps({"rendered": True, "pointer": frame.pointer,
                                  "width": frame.width, "height": frame.height}), flush=True)
            self.acknowledge = False
            with self.lock:
                finished = self.ending and self.pending is None
            if finished:
                self.GLib.idle_add(self.window.destroy)
        return False

    def close(self, *_):
        with self.lock:
            self.closed = True
            self.pending = None
        self.Gtk.main_quit()

    def post(self, value):
        with self.lock:
            if self.closed:
                return
            if value is None or isinstance(value, Exception):
                self.ending = True
                self.failure = value
            else:
                self.pending = value
            if not self.scheduled:
                self.scheduled = True
                self.GLib.idle_add(self.consume)

    def consume(self):
        with self.lock:
            value, self.pending = self.pending, None
            self.scheduled = False
            if self.closed:
                return False
            failure = self.failure
            self.failure = None
        if failure is not None:
            print("Native view failed: " + str(failure), file=sys.stderr, flush=True)
            self.result = 1
        if value is None:
            if self.acknowledge:
                self.area.queue_draw()
            elif self.ending:
                self.window.destroy()
            return False
        self.frame = value
        self.acknowledge = True
        frame, _ = value
        self.header.set_subtitle(f"{frame.width} × {frame.height} pixels | Agent cursor "
                                 + ("visible" if frame.pointer else "hidden"))
        self.area.queue_draw()
        return False

    def read(self):
        try:
            while True:
                line = self.stream.readline(MAX_LINE + 1)
                if not line:
                    self.post(None)
                    return
                if len(line) > MAX_LINE or not line.endswith(b"\n"):
                    raise ValueError("Native frame stream line is too large or incomplete")
                frame = Frame.parse(json.loads(line))
                pixbuf = frame.decode()
                self.post((frame, pixbuf))
                with self.lock:
                    if self.closed:
                        return
        except Exception as error:
            self.post(error)

    def run(self):
        self.window.show_all()
        threading.Thread(target=self.read, name="native-frame-reader", daemon=True).start()
        self.Gtk.main()
        return self.result


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from src.native.budget import require_budget
    require_budget()
    if sys.argv[1:] not in ([], ["--acknowledgements"]):
        raise SystemExit("Usage: view.py [--acknowledgements]")
    raise SystemExit(NativeView(sys.stdin.buffer, bool(sys.argv[1:])).run())
