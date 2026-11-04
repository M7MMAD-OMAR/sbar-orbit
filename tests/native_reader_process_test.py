"""Fake owned scope and process boundaries, no desktop or cgroup operations."""
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import struct
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_process as subject
from src.native.reader_pipe import ReaderPipeResult


def png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(data, zlib.crc32(kind)) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\x01\x02\x03")) + chunk(b"IEND", b""))


class FakeProcess:
    def __init__(self, events):
        self.events = events
        self.pid = 4242
        self.returncode = None
        self.stdout, self.stderr = io.BytesIO(), io.BytesIO()
        self.wait_error = False

    def wait(self, timeout):
        self.events.append("wait")
        if self.wait_error:
            raise subprocess.TimeoutExpired("redacted", timeout)
        self.returncode = -9
        return self.returncode


class FakeScope:
    def __init__(self, events):
        self.events = events
        self.fail = None
        self.bound = None
        self.receipt = {"scopeEmpty": True, "rootReaped": True, "neverAdmitted": False}
        self.retired = False

    def step(self, name):
        self.events.append(name)
        if self.fail == name:
            raise OSError("secret owned data")

    def prepare(self): self.step("prepare")
    def reserve_spawn(self): self.step("reserve")
    def bind_child(self, process):
        self.step("bind")
        self.bound = process
    def admit(self, process):
        self.step("admit")
        if process is not self.bound:
            raise AssertionError("wrong child")
    def kill(self): self.step("scope-kill")
    def retire(self):
        self.step("retire")
        if self.retired:
            raise OSError("already retired")
        if self.bound is not None and self.bound.returncode is None:
            raise OSError("root still alive")
        self.retired = True
        if self.bound is None:
            return {"scopeEmpty": True, "rootReaped": False, "neverAdmitted": True}
        return self.receipt


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.scope = FakeScope(self.events)
        self.child = FakeProcess(self.events)
        self.cancel = threading.Event()
        self.now = 100.0
        self.stop = SimpleNamespace(si_pid=4242, si_code=os.CLD_STOPPED, si_status=signal.SIGSTOP)
        self.stop_result = self.stop
        self.spawn_error = False
        self.pidfd_error = False
        self.signal_error = None
        self.close_error = False
        self.pipe_error = None
        self.pipe_result = ReaderPipeResult(png(), b"secret stderr", 0)
        self.valid = True
        self.after = None
        self.patches = [
            patch.object(subject, "ReaderScope", FakeScope),
            patch.object(subject, "_environment", return_value={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": "/run/owned", "WAYLAND_DISPLAY": "/run/owned/wayland-1"}),
            patch.object(subject.time, "monotonic", side_effect=lambda: self.now),
            patch.object(subject.time, "sleep", side_effect=self.sleep),
            patch.object(subject.subprocess, "Popen", side_effect=self.spawn),
            patch.object(subject.os, "pidfd_open", side_effect=self.pidfd),
            patch.object(subject.os, "waitid", side_effect=self.waitid),
            patch.object(subject.os, "close", side_effect=self.close_pidfd),
            patch.object(subject.signal, "pidfd_send_signal", side_effect=self.send),
            patch.object(subject, "read_reader_pipes", side_effect=self.pipes),
        ]
        for item in self.patches: item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def sleep(self, duration): self.now += duration
    def spawn(self, args, **kwargs):
        self.events.append("spawn")
        self.args, self.kwargs = args, kwargs
        if self.spawn_error: raise OSError("secret spawn")
        return self.child
    def pidfd(self, pid, flags):
        self.events.append("pidfd")
        if self.pidfd_error: raise OSError("secret pidfd")
        return 88
    def waitid(self, kind, pid, flags):
        self.events.append("waitid")
        self.assertEqual((kind, pid), (os.P_PID, self.child.pid))
        self.assertTrue(flags & os.WNOWAIT)
        return self.stop_result
    def close_pidfd(self, fd):
        self.events.append("close-pidfd")
        if self.close_error: raise OSError("secret close")
    def send(self, fd, sig):
        self.events.append("continue" if sig == signal.SIGCONT else "root-kill")
        self.assertEqual(fd, 88)
        if self.signal_error == sig: raise OSError("secret signal")
    def pipes(self, process, **kwargs):
        self.events.append("pipes")
        if self.after: self.after()
        if self.pipe_error: raise self.pipe_error
        process.returncode = self.pipe_result.returncode
        return self.pipe_result
    def guard(self): return self.valid
    def call(self, **overrides):
        args = dict(target="a12", width=1, height=1, runtime_dir="/run/owned",
                    wayland_display="/run/owned/wayland-1", deadline=102.0,
                    cancel=self.cancel, guard=self.guard)
        args.update(overrides)
        return subject.capture_reader(self.scope, **args)
    def failure(self, code="UNKNOWN", **kwargs):
        with self.assertRaises(subject.ReaderProcessError) as caught: self.call(**kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.provider_completion, "UNKNOWN")
        self.assertEqual(caught.exception.owned_scope, "UNKNOWN")
        self.assertNotIn("secret", str(caught.exception))

    def test_success_order_and_fixed_command(self):
        result = self.call()
        self.assertEqual(result.png, png())
        self.assertEqual(result.provider_completion, "UNKNOWN")
        self.assertEqual(self.events, ["prepare", "reserve", "spawn", "pidfd", "bind", "waitid", "admit", "continue", "pipes", "retire", "close-pidfd"])
        self.assertEqual(self.args[:3], ["/usr/bin/python3", "-I", "-S"])
        self.assertTrue(self.args[3].endswith("/src/native/reader_bootstrap.py"))
        self.assertEqual(self.args[4:], [str(os.getpid()), "a12"])
        self.assertEqual(self.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(self.kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(self.kwargs["stderr"], subprocess.PIPE)
        self.assertEqual(set(self.kwargs["env"]), {"PATH", "LANG", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"})
        self.assertTrue(self.kwargs["close_fds"])

    def test_pidfd_close_failure_refuses_result(self):
        self.close_error = True
        self.failure("UNKNOWN")
        self.assertIn("retire", self.events)

    def test_invalid_target_precedes_scope(self):
        self.failure("INVALID", target="0x12")
        self.assertEqual(self.events, [])

    def test_invalid_dimensions_precede_scope(self):
        for value in (True, 0, 1281):
            self.failure("INVALID", width=value)
        self.assertEqual(self.events, [])

    def test_cancel_precedes_scope(self):
        self.cancel.set()
        self.failure("CANCELLED")
        self.assertEqual(self.events, [])

    def test_invalid_deadline_precedes_scope(self):
        for value in (True, float("nan"), 100, 104, 10 ** 1000): self.failure("INVALID", deadline=value)
        self.assertEqual(self.events, [])

    def test_guard_refusal_precedes_scope(self):
        self.valid = False
        self.failure("BINDING")
        self.assertEqual(self.events, [])

    def test_cancel_after_prepare_retires_proven_no_child(self):
        original = self.scope.prepare
        def prepare_then_cancel():
            original()
            self.cancel.set()
        self.scope.prepare = prepare_then_cancel
        self.failure("CANCELLED")
        self.assertEqual(self.events, ["prepare", "retire"])

    def test_cancel_after_prepare_retire_failure_is_unknown(self):
        original = self.scope.prepare
        def prepare_then_cancel():
            original()
            self.cancel.set()
        self.scope.prepare = prepare_then_cancel
        self.scope.fail = "retire"
        self.failure("UNKNOWN")
        self.assertEqual(self.events, ["prepare", "retire"])

    def test_partial_prepare_never_retires(self):
        self.scope.fail = "prepare"
        self.failure("UNKNOWN")
        self.assertEqual(self.events, ["prepare"])

    def test_spawn_failure_keeps_reservation(self):
        self.spawn_error = True
        self.failure()
        self.assertEqual(self.events, ["prepare", "reserve", "spawn"])

    def test_reservation_failure_never_attempts_retirement(self):
        self.scope.fail = "reserve"
        self.failure()
        self.assertEqual(self.events, ["prepare", "reserve"])

    def test_bind_failure_stops_only_pidfd_and_keeps_debt(self):
        self.scope.fail = "bind"
        self.failure()
        self.assertIn("root-kill", self.events)
        self.assertNotIn("scope-kill", self.events)
        self.assertNotIn("retire", self.events)

    def test_pidfd_failure_binds_but_does_not_signal_numeric_pid(self):
        self.pidfd_error = True
        self.child.wait_error = True
        self.failure()
        self.assertIn("bind", self.events)
        self.assertNotIn("root-kill", self.events)
        self.assertNotIn("scope-kill", self.events)
        self.assertNotIn("retire", self.events)

    def test_bootstrap_exited_before_stop(self):
        self.stop_result = SimpleNamespace(si_pid=4242, si_code=os.CLD_EXITED, si_status=1)
        self.failure("BOOTSTRAP")
        self.assertIn("root-kill", self.events)
        self.assertNotIn("admit", self.events)
        self.assertNotIn("scope-kill", self.events)

    def test_stop_wait_deadline(self):
        self.stop_result = None
        self.failure("DEADLINE")
        self.assertNotIn("admit", self.events)
        self.assertIn("root-kill", self.events)

    def test_admit_failure_kills_owned_leaf_and_root(self):
        self.scope.fail = "admit"
        self.failure()
        self.assertIn("root-kill", self.events)
        self.assertIn("scope-kill", self.events)
        self.assertNotIn("continue", self.events)

    def test_continue_failure_kills_owned_leaf(self):
        self.signal_error = signal.SIGCONT
        self.failure()
        self.assertIn("scope-kill", self.events)
        self.assertIn("root-kill", self.events)

    def test_pipe_failure_kills_and_does_not_leak(self):
        self.pipe_error = OSError("secret output")
        self.failure()
        self.assertIn("scope-kill", self.events)
        self.assertIn("root-kill", self.events)

    def test_provider_exit_nonzero(self):
        self.pipe_result = ReaderPipeResult(b"secret", b"secret", 5)
        self.failure("PROVIDER")
        self.assertIn("scope-kill", self.events)

    def test_invalid_png_never_delivers(self):
        self.pipe_result = ReaderPipeResult(b"secret", b"secret", 0)
        self.failure()
        self.assertIn("scope-kill", self.events)

    def test_cancel_after_output_never_delivers(self):
        self.after = self.cancel.set
        self.failure("CANCELLED")
        self.assertIn("scope-kill", self.events)

    def test_binding_replaced_after_output_never_delivers(self):
        self.after = lambda: setattr(self, "valid", False)
        self.failure("BINDING")
        self.assertIn("scope-kill", self.events)

    def test_retire_requires_both_facts(self):
        self.scope.receipt["rootReaped"] = False
        self.failure()

    def test_kill_failure_prevents_retirement(self):
        self.pipe_error = OSError("secret")
        self.scope.fail = "scope-kill"
        self.failure()
        self.assertNotIn("retire", self.events)

    def test_root_wait_failure_prevents_retirement(self):
        self.pipe_error = OSError("secret")
        self.child.wait_error = True
        self.failure()
        self.assertNotIn("retire", self.events)

    def test_late_cancel_after_retirement_never_reuses_scope(self):
        original = self.scope.retire
        def retire_then_cancel():
            receipt = original()
            self.cancel.set()
            return receipt
        self.scope.retire = retire_then_cancel
        self.failure("CANCELLED")
        self.assertEqual(self.events.count("retire"), 1)
        self.assertNotIn("scope-kill", self.events)

    def test_guard_true_after_consuming_deadline_refuses_before_scope_work(self):
        def guard():
            self.now = 103.0
            return True
        self.failure("DEADLINE", guard=guard)
        self.assertEqual(self.events, [])

    def test_guard_true_after_cancellation_refuses_before_scope_work(self):
        def guard():
            self.cancel.set()
            return True
        self.failure("CANCELLED", guard=guard)
        self.assertEqual(self.events, [])

    def test_final_guard_true_after_deadline_never_returns_retired_capture(self):
        def guard():
            if self.scope.retired:
                self.now = 103.0
            return True
        self.failure("DEADLINE", guard=guard)
        self.assertEqual(self.events.count("retire"), 1)
        self.assertNotIn("scope-kill", self.events)

    def test_final_guard_true_after_cancel_never_returns_retired_capture(self):
        def guard():
            if self.scope.retired:
                self.cancel.set()
            return True
        self.failure("CANCELLED", guard=guard)
        self.assertEqual(self.events.count("retire"), 1)
        self.assertNotIn("scope-kill", self.events)

    def test_scope_retire_failure_never_delivers(self):
        self.scope.fail = "retire"
        self.failure()
        self.assertIn("scope-kill", self.events)


if __name__ == "__main__":
    unittest.main()
