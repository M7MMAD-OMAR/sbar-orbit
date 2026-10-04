#!/usr/bin/python3
"""Native target cursor pixel placement and bounded frame validation."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cairo
import gi
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.view import Frame, NativeView, paint
from src.native.session import NativeSession
from src.native.lease import process_identity


def supplied(pointer):
    source = cairo.ImageSurface(cairo.FORMAT_ARGB32, 400, 200)
    context = cairo.Context(source)
    context.set_source_rgb(.5, .5, .5)
    context.paint()
    data = io.BytesIO()
    source.write_to_png(data)
    return {"mimeType": "image/png", "image": base64.b64encode(data.getvalue()).decode(),
            "width": 400, "height": 200, "surfaceWidth": 200, "surfaceHeight": 100,
            "pointer": pointer, "cursorVariant": 1}


def accent_centroid(frame):
    target = cairo.ImageSurface(cairo.FORMAT_ARGB32, 800, 600)
    paint(cairo.Context(target), frame, frame.decode(), 800, 600)
    target.flush()
    pixels = memoryview(target.get_data()).cast("B")
    positions = []
    for y in range(600):
        for x in range(800):
            index = y * target.get_stride() + x * 4
            blue, green, red = pixels[index:index + 3]
            if blue > 220 and 105 < green < 170 and red < 100:
                positions.append((x, y))
    if not positions:
        return None
    return tuple(sum(point[axis] for point in positions) / len(positions) for axis in (0, 1))


class NativeViewTests(unittest.TestCase):
    def test_session_resize_hides_cursor_outside_new_surface(self):
        session = NativeSession.__new__(NativeSession)
        session.closed = False
        session.windows = {}
        session.plan = {"runtime": "/tmp/native-view-fixture", "display": "wayland-fixture"}
        process = process_identity(os.getpid())
        app = SimpleNamespace(unit="orbit-native-" + "c" * 32 + ".scope", profile=Path("."),
                              lease=SimpleNamespace(members=lambda: {process}, _contains=lambda value: value == process,
                                                    verify=lambda: None))
        session._app = lambda _: app
        client = {"pid": os.getpid(), "workspace": {"name": "special:ghost"},
                  "address": "0x123", "stableId": "123", "size": [400, 100]}
        session.transport = SimpleNamespace(_exchange=lambda command: json.dumps([client]) if command == "j/clients" else "ok")
        session.control = SimpleNamespace(execute=lambda request, operation: operation())
        app_id = "a" * 32
        target = session._owned_windows(app_id)[0]
        session.windows[target["windowId"]]["pointer"] = {"x": 350, "y": 50}
        client["size"] = [300, 100]
        source = supplied(None)
        png = base64.b64decode(source["image"])
        with patch("src.native.session.verify_host"), patch("src.native.session.bounded_capture", return_value=(png, 400, 200)):
            frame = session.execute({"type": "observe", "appId": app_id, "windowId": target["windowId"]})
        self.assertEqual(frame["surfaceWidth"], 300)
        self.assertIsNone(frame["pointer"])
        self.assertIsNone(accent_centroid(Frame.parse(frame)))

    def test_eof_preserves_the_last_pending_frame(self):
        class Scheduler:
            def __init__(self):
                self.callbacks = []
            def idle_add(self, callback):
                self.callbacks.append(callback)
        view = NativeView.__new__(NativeView)
        view.lock = threading.Lock()
        view.closed = view.ending = view.scheduled = False
        view.failure = view.pending = None
        view.GLib = Scheduler()
        value = (Frame.parse(supplied(None)), object())
        view.post(value)
        view.post(None)
        if "--drop-last-frame" in sys.argv:
            # Negative control: reproduce replacing the single pending slot with EOF.
            view.pending = None
        self.assertTrue(view.pending is value, "EOF replaced the final pending frame")
        self.assertTrue(view.ending)
        self.assertEqual(len(view.GLib.callbacks), 1)

    def test_fractional_surface_transform_and_letterbox(self):
        frame = Frame.parse(supplied({"x": 50, "y": 25}))
        if "--wrong-dpi" in sys.argv:
            # Negative control: confuse image pixels with logical surface coordinates.
            frame = Frame(frame.png, frame.width, frame.height, frame.width, frame.height, frame.pointer, frame.variant)
        centroid = accent_centroid(frame)
        self.assertIsNotNone(centroid)
        # Scale 2 image-to-view, scale 2 logical-to-image, top letterbox 100.
        self.assertAlmostEqual(centroid[0], (50 + 24 - 4) * 4, delta=1)
        self.assertAlmostEqual(centroid[1], 100 + (25 + 28 - 3) * 4, delta=1)

    def test_cursor_moves_and_hidden_cursor_has_no_accent(self):
        first = accent_centroid(Frame.parse(supplied({"x": 50, "y": 25})))
        second = accent_centroid(Frame.parse(supplied({"x": 100, "y": 50})))
        self.assertAlmostEqual(second[0] - first[0], 200, delta=1)
        self.assertAlmostEqual(second[1] - first[1], 100, delta=1)
        self.assertIsNone(accent_centroid(Frame.parse(supplied(None))))

    def test_rejects_invalid_coordinates_dimensions_and_variants(self):
        valid = supplied({"x": 50, "y": 25})
        for change in ({"surfaceWidth": 0}, {"surfaceHeight": float("nan")}, {"width": 401},
                       {"pointer": {"x": 200, "y": 25}}, {"pointer": {"x": True, "y": 25}},
                       {"cursorVariant": True}, {"image": "!!!!"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                Frame.parse(valid | change)

    def test_truncated_png_is_rejected_by_decoder(self):
        valid = supplied(None)
        valid["image"] = base64.b64encode(base64.b64decode(valid["image"])[:33]).decode()
        with self.assertRaises(Exception):
            Frame.parse(valid).decode()


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
