#!/usr/bin/python3
"""Real supervised descendants must exit on caller failure or guardian stall."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.application import NativeApplication
from src.native.control import ActionControl
from src.native.lease import process_identity


if "--unfixed-close" in sys.argv:
    sys.argv.remove("--unfixed-close")
    # Preserve the reviewed pre-fix close behavior as a negative control.
    def unfixed_close(self):
        def stop_owned():
            import src.native.application as application
            application.require_budget()
            self.supervisor.stdin.close()
            self.supervisor.wait(timeout=5)
            if self.supervisor.returncode != 0:
                raise RuntimeError("Native supervisor exited with a cleanup failure")
            if any(process_identity(identity[0]) == identity for identity in self.members):
                raise RuntimeError("Native cleanup left a recorded process alive")
            self.closed = True
        return self.control.cleanup("native-close " + self.unit, stop_owned)
    NativeApplication.close = unfixed_close

class ApplicationCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-application-cleanup-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.control = ActionControl(self.directory / "control")
        self.addCleanup(self.control.close)
        self.app = NativeApplication(self.directory, "orbit-native-" + "a" * 32 + ".scope", self.control)
        report = self.directory / "supervisor.json"
        fixture = self.directory / "fixture.json"
        code = ("import json,os,subprocess,time; from pathlib import Path; "
                "child=subprocess.Popen(['/usr/bin/sleep','60'],start_new_session=True); "
                f"Path({str(fixture)!r}).write_text(json.dumps([os.getpid(),child.pid])); time.sleep(60)")
        self.app.supervisor = subprocess.Popen([
            "/usr/bin/python3", str(Path(__file__).resolve().parents[2] / "src/native/supervise.py"),
            str(report), "--native-lifecycle", str(self.control.directory), self.app.unit,
            "/usr/bin/python3", "-c", code], stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.recover)
        deadline = time.monotonic() + 3
        while not fixture.exists():
            if self.app.supervisor.poll() is not None or time.monotonic() >= deadline:
                self.fail("Supervised fixture did not start")
            time.sleep(0.01)
        self.app.members = {process_identity(pid) for pid in json.loads(fixture.read_text())}
        self.assertNotIn(None, self.app.members)

    def recover(self):
        if self.app.supervisor.poll() is None:
            self.app.supervisor.send_signal(signal.SIGCONT)
            if not self.app.supervisor.stdin.closed:
                self.app.supervisor.stdin.close()
            self.app.supervisor.wait(timeout=5)

    def assert_reaped(self):
        self.assertIsNotNone(self.app.supervisor.poll())
        self.assertTrue(all(process_identity(pid) != identity for identity in self.app.members for pid in [identity[0]]))

    def test_budget_failure_still_reaps_tree(self):
        with patch("src.native.application.require_budget", side_effect=RuntimeError("budget lost")):
            with self.assertRaises(BaseExceptionGroup):
                self.app.close()
        self.assert_reaped()
        self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")

    def test_stopped_guardian_is_resumed_and_timeout_reported(self):
        self.app.supervisor.send_signal(signal.SIGSTOP)
        with self.assertRaises(BaseExceptionGroup) as failure:
            self.app.close()
        pending = list(failure.exception.exceptions)
        timed_out = False
        while pending:
            error = pending.pop()
            if isinstance(error, BaseExceptionGroup):
                pending.extend(error.exceptions)
            elif isinstance(error, subprocess.TimeoutExpired):
                timed_out = True
        self.assertTrue(timed_out)
        self.assert_reaped()
        self.assertEqual(self.control.inspect()["events"][-1]["outcome"], "error")

    def test_guardian_journal_failure_still_reaps_tree(self):
        journal = self.control.directory / "actions.jsonl"
        # A symlink is rejected by the controller in both processes.
        if journal.exists():
            journal.unlink()
        journal.symlink_to(self.directory / "unowned-journal")
        with self.assertRaises(BaseExceptionGroup):
            self.app.close()
        self.assert_reaped()


if __name__ == "__main__":
    unittest.main()
