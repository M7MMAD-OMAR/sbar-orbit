"""Capture refusal and pure guard checks only; no mocked executable capture capability."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_process as subject

SECRET = "PRIVATE-capture-path-pixels"


class ReaderProcessBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.scope = SimpleNamespace(prepare=Mock(), reserve_spawn=Mock(), bind_child=Mock(), admit=Mock(), retire=Mock())
        self.now = 100.0
        self.cancel = threading.Event()
        clock = patch.object(subject.time, "monotonic", side_effect=lambda: self.now)
        clock.start(); self.addCleanup(clock.stop)

    def error(self, code, call):
        with self.assertRaises(subject.ReaderProcessError) as caught: call()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.provider_completion, "UNKNOWN")
        self.assertEqual(caught.exception.owned_scope, "UNKNOWN")
        self.assertNotIn(SECRET, str(caught.exception))

    def capture(self, scope=None, **changes):
        values = dict(target="a12", width=1, height=1, runtime_dir="/run/owned", wayland_display="/run/owned/wayland-1",
                      deadline=102, guard=Mock(return_value=True), cancel=self.cancel)
        values.update(changes)
        return subject.capture_reader(scope or self.scope, **values)

    def test_public_capture_refuses_before_scope_filesystem_spawn_or_callbacks(self):
        guard = Mock(return_value=True)
        with patch.object(subprocess, "Popen") as spawn, patch.object(os, "pidfd_open") as pin, patch.object(os, "open") as opened, patch.object(os, "waitid") as waited, patch.object(signal, "pidfd_send_signal") as sent:
            self.error("UNKNOWN", lambda: self.capture(guard=guard))
            for call in (spawn, pin, opened, waited, sent, guard, *vars(self.scope).values()): call.assert_not_called()
        for name in ("_environment", "_cleanup", "_wait_stopped", "_capture_reader_unqualified"):
            self.assertFalse(hasattr(subject, name))

    def test_public_capture_does_not_inspect_foreign_input_before_refusing(self):
        class Forbidden:
            def __getattribute__(self, name): raise AssertionError("Input was inspected")
        self.error("UNKNOWN", lambda: self.capture(Forbidden(), target=Forbidden(), deadline=float("nan")))

    def test_public_capture_refusal_does_not_disclose_arguments(self):
        self.error("UNKNOWN", lambda: self.capture(target=SECRET, runtime_dir=SECRET, wayland_display=SECRET))

    def test_check_rejects_deadline_consumed_by_true_guard(self):
        def guard(): self.now = 103; return True
        self.error("DEADLINE", lambda: subject._check(102, self.cancel, guard))

    def test_check_rejects_cancel_set_by_true_guard(self):
        def guard(): self.cancel.set(); return True
        self.error("CANCELLED", lambda: subject._check(102, self.cancel, guard))

    def test_check_false_or_nonliteral_true_never_authorizes(self):
        for value in (False, 1, None, "yes"):
            self.error("BINDING", lambda: subject._check(102, self.cancel, lambda: value))

    def test_check_guard_exception_is_content_free(self):
        def guard(): raise OSError(SECRET)
        self.error("BINDING", lambda: subject._check(102, self.cancel, guard))

    def test_check_cancelled_admission_does_not_call_guard(self):
        guard = Mock(); self.cancel.set()
        self.error("CANCELLED", lambda: subject._check(102, self.cancel, guard)); guard.assert_not_called()

    def test_check_expired_admission_does_not_call_guard(self):
        guard = Mock()
        self.error("DEADLINE", lambda: subject._check(100, self.cancel, guard)); guard.assert_not_called()

    def test_check_live_literal_true_boundary_remains_valid(self):
        subject._check(102, self.cancel, lambda: True)


if __name__ == "__main__":
    unittest.main()
