"""Settled capture: a new frame must differ from the baseline, then hold still."""
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native.session import NativeSession, SessionError

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


if __name__ == "__main__":
    unittest.main()
