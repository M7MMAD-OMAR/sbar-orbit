#!/usr/bin/python3
"""Lifecycle cleanup must run despite protected mode or unavailable journals."""
import fcntl
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl

if "--input-cleanup" in sys.argv:
    sys.argv.remove("--input-cleanup")
    # Deliberately wrong lifecycle policy, to prove these checks catch withheld cleanup.
    ActionControl.cleanup = ActionControl.execute


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-cleanup-control-")
        self.addCleanup(self.temp.cleanup)
        self.control = ActionControl(Path(self.temp.name) / "control")
        self.addCleanup(self.control.close)

    def test_protected_cleanup_releases_without_changing_mode(self):
        calls = []
        self.control.cleanup("native-close fixture", lambda: calls.append("released"))
        self.assertEqual(calls, ["released"])
        snapshot = self.control.inspect()
        self.assertEqual(snapshot["settings"]["mode"], "protected")
        self.assertEqual(snapshot["events"][-2]["lifecycle"], "cleanup")
        self.assertEqual(snapshot["events"][-1]["outcome"], "success")
        self.assertEqual(snapshot["unresolved"], [])

    def test_storage_and_release_errors_both_survive(self):
        calls = []
        storage = OSError("journal unavailable")
        release = RuntimeError("release failed")
        def operation():
            calls.append("attempted")
            raise release
        with patch.object(self.control, "_record", side_effect=storage):
            with self.assertRaises(BaseExceptionGroup) as failure:
                self.control.cleanup("native-close fixture", operation)
        self.assertEqual(calls, ["attempted"])
        self.assertEqual(failure.exception.exceptions, (storage, release))

    def test_locked_storage_has_bounded_wait_and_still_releases(self):
        fd = self.control._open("lock", os.O_RDWR | os.O_CREAT)
        calls = []
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            started = time.monotonic()
            with self.assertRaises(BaseExceptionGroup):
                self.control.cleanup("native-close fixture", lambda: calls.append("released"))
            self.assertLess(time.monotonic() - started, 1)
        finally:
            os.close(fd)
        self.assertEqual(calls, ["released"])


if __name__ == "__main__":
    unittest.main()
