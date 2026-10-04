"""Process ownership checks without opening a display or invoking lab down."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cleanup_lab", os.environ.get("ORBIT_LAB_TEST_SOURCE", str(Path(__file__).with_name("lab.py"))))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class LabCleanupTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="gl-cleanup-test-")
        self.directory = Path(self.work.name)
        self.sentinel = subprocess.Popen(["/usr/bin/python3", "-c", "import time;time.sleep(30)"],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def tearDown(self):
        if self.sentinel.poll() is None:
            self.sentinel.terminate()
        self.sentinel.wait(timeout=3)
        self.work.cleanup()

    def record(self, value):
        (self.directory / "pids").write_text(json.dumps(value) + "\n")

    def test_bare_stale_pid_is_not_owned(self):
        (self.directory / "pids").write_text(str(self.sentinel.pid) + "\n")
        self.assertNotIn(self.sentinel.pid, lab.members(self.directory))
        self.assertIsNone(self.sentinel.poll())

    def test_current_record_is_owned(self):
        self.record(lab.process_record(self.sentinel.pid))
        self.assertIn(self.sentinel.pid, lab.members(self.directory))

    def test_previous_boot_is_not_owned(self):
        record = lab.process_record(self.sentinel.pid)
        record["boot"] = "previous-boot"
        self.record(record)
        self.assertNotIn(self.sentinel.pid, lab.members(self.directory))

    def test_reused_pid_is_not_owned(self):
        record = lab.process_record(self.sentinel.pid)
        record["start"] += 1
        self.record(record)
        self.assertNotIn(self.sentinel.pid, lab.members(self.directory))

    def test_unrelated_signal_is_refused(self):
        (self.directory / "pids").write_text(str(self.sentinel.pid) + "\n")
        self.assertFalse(lab.signal_member(self.directory, self.sentinel.pid, signal.SIGTERM))
        self.assertIsNone(self.sentinel.poll())

    def test_ownership_change_before_signal_is_refused(self):
        self.record(lab.process_record(self.sentinel.pid))
        with patch.object(lab, "owns", return_value=False):
            self.assertFalse(lab.signal_member(self.directory, self.sentinel.pid, signal.SIGTERM))
        self.assertIsNone(self.sentinel.poll())

    def test_owned_signal_uses_retained_pidfd(self):
        self.record(lab.process_record(self.sentinel.pid))
        with patch.object(lab.os, "kill", side_effect=AssertionError("Numeric PID signal must never be used")):
            self.assertTrue(lab.signal_member(self.directory, self.sentinel.pid, signal.SIGTERM))
        self.assertEqual(self.sentinel.wait(timeout=3), -signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
