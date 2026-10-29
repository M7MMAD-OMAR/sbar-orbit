"""Settled capture: a new frame must differ from the baseline, then hold still."""
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import struct
import zlib

from src.native.session import NativeSession, SessionError, cropped_png, raster_header, visible_crop

APP, WINDOW = "a" * 32, "b" * 32


def digest(frame):
    return hashlib.sha256(frame).hexdigest()


def feed(frames):
    """A capture that walks a list of frames and then repeats the last one."""
    state = {"n": 0}

    def capture():
        frame = frames[min(state["n"], len(frames) - 1)]
        state["n"] += 1
        return frame, 1, 1, 0, (1, 1)
    return capture, state


def options(**extra):
    return NativeSession.parse({"type": "observe", "appId": APP, "windowId": WINDOW, "timeoutMs": 600,
                                "quietMs": 60, "graceMs": 100, **extra})


class SettleTests(unittest.TestCase):
    def test_stale_frames_are_not_taken_for_settled(self):
        capture, state = feed([b"old", b"old", b"new", b"new"])
        action = options(since=digest(b"old"))
        image, *_, settle = NativeSession._settle(capture, capture(), action)
        self.assertEqual(image, b"new")
        self.assertEqual((settle["settled"], settle["changed"]), (True, True))
        self.assertGreaterEqual(settle["captures"], 3)

    def test_unchanged_window_reports_changed_false_after_grace(self):
        capture, _ = feed([b"same"])
        *_, settle = NativeSession._settle(capture, capture(), options(since=digest(b"same")))
        self.assertEqual((settle["settled"], settle["changed"]), (True, False))
        self.assertLess(settle["waitedMs"], 400)

    def test_a_frame_that_keeps_changing_stops_at_the_bound(self):
        capture, _ = feed([bytes([n]) for n in range(200)])
        *_, settle = NativeSession._settle(capture, capture(), options(since=digest(b"x")))
        self.assertEqual((settle["settled"], settle["changed"]), (False, True))
        self.assertLess(settle["waitedMs"], 900)

    def test_without_a_baseline_stability_alone_decides_and_changed_is_unknown(self):
        capture, _ = feed([b"a", b"b", b"b"])
        image, *_, settle = NativeSession._settle(capture, capture(), options())
        self.assertEqual((image, settle["settled"], settle["changed"]), (b"b", True, None))

    def test_options_are_validated(self):
        base = {"type": "observe", "appId": APP, "windowId": WINDOW}
        for bad in ({"timeoutMs": 50}, {"timeoutMs": 99999}, {"timeoutMs": True}, {"since": "xyz", "timeoutMs": 500},
                    {"quietMs": 100}, {"digestOnly": False}):
            with self.subTest(bad=bad), self.assertRaises(SessionError):
                NativeSession.parse({**base, **bad})
        self.assertEqual(NativeSession.parse({**base, "digestOnly": True})["digestOnly"], True)
        self.assertEqual(NativeSession.parse(base).get("timeoutMs"), None)


def raster(width, height):
    """A PPM whose pixel (x, y) is (x, y, 7), so a crop is checked by value."""
    body = bytes(value for y in range(height) for x in range(width) for value in (x, y, 7))
    return b"P6\n%d %d\n255\n" % (width, height) + body


def decode(png):
    """Pixels of a PNG this module wrote: 8 bit RGB, filter 0 on every row."""
    width, height = struct.unpack(">II", png[16:24])
    data, at = b"", 8
    while at < len(png):
        size = struct.unpack(">I", png[at:at + 4])[0]
        if png[at + 4:at + 8] == b"IDAT":
            data += png[at + 8:at + 8 + size]
        at += 12 + size
    flat = zlib.decompress(data)
    rows = [flat[y * (width * 3 + 1) + 1:(y + 1) * (width * 3 + 1)] for y in range(height)]
    return width, height, rows


class CropTests(unittest.TestCase):
    def test_a_window_without_a_margin_is_not_cropped(self):
        self.assertIsNone(visible_crop((960, 640), (960, 640), (0, 0, 960, 640)))

    def test_firefox_margin_moves_the_image_origin_to_the_geometry(self):
        # The measured Firefox window: 960x640 window, surface 1008x688, geometry at 24, 21.
        self.assertEqual(visible_crop((960, 640), (960, 640), (24, 21, 960, 640)), (24, 21, 936, 619))

    def test_a_fractional_scale_cuts_at_scaled_pixels(self):
        # 1280x853 pixels for a 960x640 window is a scale of 1.3333.
        self.assertEqual(visible_crop((1280, 853), (960, 640), (24, 21, 960, 640)), (32, 28, 1248, 825))

    def test_geometry_inside_the_window_is_kept_whole(self):
        self.assertEqual(visible_crop((960, 640), (960, 640), (10, 10, 500, 300)), (10, 10, 500, 300))

    def test_a_geometry_outside_the_frame_is_refused(self):
        for geometry in ((-4, 0, 10, 10), (960, 0, 10, 10)):
            with self.subTest(geometry=geometry), self.assertRaises(SessionError):
                visible_crop((960, 640), (960, 640), geometry)

    def test_a_window_without_readable_state_is_not_cropped(self):
        from src.native.host import HostError

        class Transport:
            def _perform(self, request):
                raise HostError("state unavailable: target is not an XDG toplevel")
        session = NativeSession.__new__(NativeSession)
        session.transport = Transport()
        self.assertIsNone(session._geometry("0x1@ab@lease"))

    def test_the_cropped_png_starts_at_the_geometry_origin(self):
        width, height, rows = decode(cropped_png(raster(40, 30), 5, 3, 20, 10))
        self.assertEqual((width, height), (20, 10))
        # Pixel (0, 0) of the crop is pixel (5, 3) of the frame, the last one is (24, 12).
        self.assertEqual(tuple(rows[0][:3]), (5, 3, 7))
        self.assertEqual(tuple(rows[-1][-3:]), (24, 12, 7))

    def test_a_malformed_raster_or_crop_is_refused(self):
        for bad in (b"P6\n4 4\n255\n" + b"x" * 10, b"P5\n1 1\n255\nx", b"P6\n0 1\n255\n"):
            with self.subTest(bad=bad[:12]), self.assertRaises(SessionError):
                raster_header(bad)
        with self.assertRaises(SessionError):
            cropped_png(raster(8, 8), 4, 4, 8, 8)


if __name__ == "__main__":
    unittest.main()
