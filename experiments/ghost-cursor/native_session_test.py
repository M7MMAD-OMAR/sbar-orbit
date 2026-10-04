#!/usr/bin/python3
"""Session parsing and bounded real capture process failure checks."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.session import NativeSession, SessionError, bounded_capture


if "--context-reap" in sys.argv:
    sys.argv.remove("--context-reap")
    # Deliberately reproduce the reviewed automatic-context cleanup policy.
    def context_reap(argv, environment, diagnostics):
        with subprocess.Popen(argv, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
            try:
                raise RuntimeError("capture fixture failure")
            finally:
                child.kill()
                child.wait(timeout=3)
    bounded_capture = context_reap


class NativeSessionTests(unittest.TestCase):
    def test_rejects_mode_changes_and_raw_addresses(self):
        app, window = "a" * 32, "b" * 32
        for value in ({"type": "configure", "mode": "full"},
                      {"type": "key", "appId": app, "windowId": window, "key": "Return\nghost-click"},
                      {"type": "cursor", "appId": app, "windowId": "0x123", "x": 0, "y": 0},
                      {"type": "cursor", "appId": app, "windowId": window, "x": float("nan"), "y": 0},
                      {"type": "scroll", "appId": app, "windowId": window, "x": 0, "y": 0, "dy": 0},
                      {"type": "text", "appId": app, "windowId": window, "text": "hello", "unit": "foreign"}):
            with self.subTest(value=value), self.assertRaises(SessionError):
                NativeSession.parse(value)

    def test_capture_preserves_failed_command_and_private_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "capture.log"
            with self.assertRaises(BaseExceptionGroup) as failure:
                bounded_capture(["/usr/bin/python3", "-c", "import sys; sys.stderr.write('fixture capture error'); sys.exit(9)"], {}, log)
            self.assertIn("capture failed", str(failure.exception.exceptions[0]))
            self.assertEqual(log.read_text(), "fixture capture error")
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_capture_final_reap_timeout_has_no_unbounded_context_exit(self):
        class FixtureChild:
            def __init__(self):
                self.stdout = open(os.devnull, "rb")
                self.stderr = open(os.devnull, "rb")
                self.waits = []
                self.killed = False
            def __enter__(self):
                return self
            def __exit__(self, *_):
                self.wait()
            def poll(self):
                return None
            def kill(self):
                self.killed = True
            def wait(self, timeout=None):
                self.waits.append(timeout)
                if timeout is None:
                    raise AssertionError("Unbounded wait attempted")
                raise subprocess.TimeoutExpired("capture fixture", timeout)
        child = FixtureChild()
        with tempfile.TemporaryDirectory() as directory:
            with patch("src.native.session.subprocess.Popen", return_value=child):
                with self.assertRaises(BaseExceptionGroup) as failure:
                    bounded_capture(["fixture"], {}, Path(directory) / "capture.log")
        self.assertTrue(child.killed)
        self.assertEqual(child.waits, [3])
        self.assertTrue(any(isinstance(error, subprocess.TimeoutExpired) for error in failure.exception.exceptions))
        self.assertTrue(child.stdout.closed and child.stderr.closed)


if __name__ == "__main__":
    unittest.main()
