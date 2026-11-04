"""Owned FIFO and controlled Popen fixtures, not process or scope-stop qualification."""
from dataclasses import FrozenInstanceError
import io
import math
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_pipe as subject


class FakeChild(subprocess.Popen):
    """A retained Popen object with no OS child and no signal-capable methods."""
    def __init__(self, owner, stdout, stderr):
        self.owner = owner
        self.stdout, self.stderr = stdout, stderr
        self.returncode = None
        self._child_created = False
        self.pid = 123456789
        self.exit_code = 0
        self.exit_at = 0.0
        self.waits = []
        self.outside_pipe_work_live = True

    def poll(self):
        if self.owner.now >= self.exit_at:
            self.returncode = self.exit_code
        return self.returncode

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.poll() is not None:
            return self.returncode
        if timeout is None or timeout <= 0 or not math.isfinite(timeout):
            raise AssertionError("Unbounded or invalid root wait")
        self.owner.now += timeout
        if self.owner.on_wait:
            self.owner.on_wait()
        if self.poll() is None:
            raise subprocess.TimeoutExpired("private-fixture-command", timeout)
        return self.returncode

    def terminate(self):
        raise AssertionError("Reader must never signal a root")

    kill = terminate
    send_signal = terminate


class FakeSelector:
    def __init__(self, owner):
        self.owner = owner
        self.keys = {}
        self.closed = False
        self.timeouts = []
        owner.instances.append(self)

    def register(self, fileobj, events, data=None):
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        key = selectors.SelectorKey(fileobj, fd, events, data)
        self.keys[fd] = key
        return key

    def unregister(self, fileobj):
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        return self.keys.pop(fd)

    def select(self, timeout=None):
        self.timeouts.append(timeout)
        if timeout is None or timeout < 0 or not math.isfinite(timeout):
            raise AssertionError("Unbounded selector wait")
        if self.owner.select_error:
            raise OSError(self.owner.secret)
        self.owner.now += min(timeout, .01)
        if self.owner.on_select:
            self.owner.on_select()
        # A ready indication may be stale. Nonblocking read must tolerate EAGAIN.
        return [(key, selectors.EVENT_READ) for key in list(self.keys.values())]

    def close(self):
        self.closed = True
        if self.owner.close_selector_error:
            raise OSError(self.owner.secret)

    def get_map(self):
        return self.keys

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class ReaderPipeTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.instances = []
        self.streams = []
        self.writers = []
        self.reads = []
        self.secret = "PRIVATE-output-path-command-token-\u2603"
        self.on_select = self.on_wait = None
        self.select_error = self.close_selector_error = False
        self.real_read = os.read
        self.patch(subject, "_now", lambda: self.now)
        self.patch(subject.time, "sleep", lambda seconds: self.advance(seconds))
        self.patch(subject.selectors, "DefaultSelector", lambda: FakeSelector(self))
        self.patch(subject.os, "read", self.read)
        self.patch(os, "kill", side_effect=AssertionError("No fixture PID signals"))
        self.patch(os, "killpg", side_effect=AssertionError("No fixture group signals"))
        self.patch(subprocess.Popen, "__init__", side_effect=AssertionError("No fixture subprocesses"))
        self.addCleanup(self.close_pipes)

    def patch(self, obj, name, value=None, **kwargs):
        operation = patch.object(obj, name, value, **kwargs) if value is not None else patch.object(obj, name, **kwargs)
        mocked = operation.start()
        self.addCleanup(operation.stop)
        return mocked

    def advance(self, seconds):
        self.assertGreater(seconds, 0)
        self.assertLessEqual(seconds, .05)
        self.now += seconds

    def read(self, fd, count):
        self.reads.append((fd, count))
        self.assertFalse(os.get_blocking(fd), "Pipe must be nonblocking before every read")
        return self.real_read(fd, count)

    def pipe(self, data=b"", eof=True):
        rd, wr = os.pipe()
        stream = os.fdopen(rd, "rb", buffering=0)
        self.streams.append(stream)
        if data:
            self.assertEqual(os.write(wr, data), len(data))
        if eof:
            os.close(wr)
        else:
            self.writers.append(wr)
        return stream

    def child(self, out=b"", err=b"", eof=True):
        return FakeChild(self, self.pipe(out, eof), self.pipe(err, eof))

    def close_pipes(self):
        for stream in self.streams:
            if not stream.closed:
                stream.close()
        for fd in self.writers:
            os.close(fd)

    def acquire(self, child, **kwargs):
        kwargs.setdefault("deadline", self.now + .2)
        return subject.read_reader_pipes(child, **kwargs)

    def assert_code(self, code, operation):
        with self.assertRaises(subject.ReaderPipeError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(self.secret, str(caught.exception))
        self.assertNotIn("private-fixture-command", str(caught.exception))
        return caught.exception

    def assert_closed(self, child):
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)
        self.assertTrue(self.instances)
        self.assertTrue(all(selector.closed for selector in self.instances))

    def limits(self, **kwargs):
        values = dict(stdout_bytes=8, stderr_bytes=4, poll_seconds=.02)
        values.update(kwargs)
        return subject.ReaderPipeLimits(**values)

    def test_default_limits_and_frozen_fields(self):
        value = subject.ReaderPipeLimits()
        self.assertEqual((value.stdout_bytes, value.stderr_bytes, value.poll_seconds), (1048576, 16384, .05))
        with self.assertRaises(FrozenInstanceError):
            value.stdout_bytes = 1

    def test_empty_pipes_root_success_is_frozen_result(self):
        child = self.child()
        result = self.acquire(child)
        self.assertIsInstance(result, subject.ReaderPipeResult)
        self.assertEqual((result.stdout, result.stderr, result.returncode), (b"", b"", 0))
        with self.assertRaises(FrozenInstanceError):
            result.returncode = 2
        self.assert_closed(child)

    def test_binary_and_unicode_bytes_preserved(self):
        out = b"\x00\xff\xfe" + "hello \u2603".encode()
        err = b"\x80\x00" + "\u0627".encode()
        child = self.child(out, err)
        result = self.acquire(child)
        self.assertEqual((result.stdout, result.stderr), (out, err))
        self.assert_closed(child)

    def test_exact_both_caps_succeed(self):
        child = self.child(b"a" * 8, b"b" * 4)
        result = self.acquire(child, limits=self.limits())
        self.assertEqual((result.stdout, result.stderr), (b"a" * 8, b"b" * 4))
        self.assert_closed(child)

    def test_one_byte_caps_succeed(self):
        child = self.child(b"a", b"b")
        result = self.acquire(child, limits=self.limits(stdout_bytes=1, stderr_bytes=1))
        self.assertEqual((result.stdout, result.stderr), (b"a", b"b"))

    def test_stdout_cap_plus_one_overflows(self):
        child = self.child(b"a" * 9)
        self.assert_code("OVERFLOW", lambda: self.acquire(child, limits=self.limits()))
        self.assert_closed(child)

    def test_stderr_cap_plus_one_overflows(self):
        child = self.child(b"", b"b" * 5)
        self.assert_code("OVERFLOW", lambda: self.acquire(child, limits=self.limits()))
        self.assert_closed(child)

    def test_overflow_read_requests_never_exceed_remaining_plus_one(self):
        child = self.child(b"a" * 100, b"b" * 100)
        outfd, errfd = child.stdout.fileno(), child.stderr.fileno()
        self.assert_code("OVERFLOW", lambda: self.acquire(child, limits=self.limits()))
        self.assertTrue(self.reads)
        for fd, count in self.reads:
            self.assertGreater(count, 0)
            self.assertLessEqual(count, {outfd: 9, errfd: 5}[fd])

    def test_partial_reads_respect_decreasing_remaining_capacity(self):
        child = self.child(b"abcdefgh", b"1234")
        base_read = self.real_read
        actual_counts = []
        def partial(fd, count):
            actual_counts.append((fd, count))
            self.assertFalse(os.get_blocking(fd))
            return base_read(fd, min(count, 2))
        self.patch(subject.os, "read", partial)
        outfd, errfd = child.stdout.fileno(), child.stderr.fileno()
        result = self.acquire(child, limits=self.limits())
        self.assertEqual((result.stdout, result.stderr), (b"abcdefgh", b"1234"))
        remaining = {outfd: 8, errfd: 4}
        for fd, count in actual_counts:
            self.assertLessEqual(count, remaining[fd] + 1)
            remaining[fd] -= min(remaining[fd], 2)

    def test_stderr_drains_while_stdout_waits(self):
        child = self.child(eof=False)
        os.write(self.writers[1], b"1234")
        self.on_select = lambda: event.set() if any(fd == child.stderr.fileno() for fd, _ in self.reads) else None
        event = threading.Event()
        self.assert_code("CANCELLED", lambda: self.acquire(child, limits=self.limits(), cancel=event))
        self.assertTrue(self.reads)
        self.assert_closed(child)

    def test_read_eagain_does_not_mean_eof(self):
        child = self.child(eof=False)
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=self.now + .025))
        self.assertGreaterEqual(len(self.reads), 2)
        self.assert_closed(child)

    def test_nonzero_root_code_is_data_not_io_error(self):
        child = self.child(b"ok", b"diagnostic")
        child.exit_code = 7
        result = self.acquire(child)
        self.assertEqual(result.returncode, 7)
        self.assert_closed(child)

    def test_root_exit_without_pipe_eof_still_deadlines(self):
        child = self.child(eof=False)
        self.assertEqual(child.poll(), 0)
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=self.now + .025))
        self.assert_closed(child)

    def test_eof_without_root_exit_still_deadlines(self):
        child = self.child()
        child.exit_at = 1000
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=self.now + .025))
        self.assertIsNone(child.returncode)
        self.assert_closed(child)

    def test_cancellation_while_waiting_for_root_after_eof(self):
        child = self.child()
        child.exit_at = 1000
        event = threading.Event()
        self.on_wait = event.set
        self.assert_code("CANCELLED", lambda: self.acquire(child, cancel=event))
        self.assertTrue(child.waits)
        self.assert_closed(child)

    def test_root_wait_is_sliced_by_poll_and_remaining_deadline(self):
        child = self.child()
        child.exit_at = self.now + .045
        result = self.acquire(child, deadline=self.now + .055, limits=self.limits())
        self.assertEqual(result.returncode, 0)
        self.assertTrue(child.waits)
        self.assertTrue(all(0 < timeout <= .02 for timeout in child.waits))
        self.assertLessEqual(self.now, 100.055)

    def test_cancellation_during_pipe_read(self):
        child = self.child(eof=False)
        event = threading.Event()
        self.on_select = event.set
        self.assert_code("CANCELLED", lambda: self.acquire(child, cancel=event))
        self.assert_closed(child)

    def test_already_cancelled_never_waits_for_root(self):
        child = self.child()
        event = threading.Event()
        event.set()
        self.assert_code("CANCELLED", lambda: self.acquire(child, cancel=event))
        self.assertEqual(child.waits, [])
        self.assertEqual(self.reads, [])
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)

    def test_deadline_absolute_not_renewed_by_partial_progress(self):
        child = self.child(b"abcdef", eof=False)
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=100.035))
        self.assertLessEqual(self.now, 100.035 + 1e-9)
        self.assert_closed(child)

    def test_expired_deadline_before_io(self):
        for deadline in (99.0, 100.0):
            with self.subTest(deadline=deadline):
                child = self.child()
                self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=deadline))
                self.assertTrue(child.stdout.closed)
                self.assertTrue(child.stderr.closed)
        self.assertEqual(self.reads, [])
        self.assertEqual(self.instances, [])

    def test_invalid_deadline_types_and_nonfinite_values(self):
        for deadline in (True, False, None, "101", float("nan"), float("inf"), -float("inf"), 10 ** 1000):
            with self.subTest(deadline=deadline):
                self.assert_code("INVALID", lambda: self.acquire(self.child(), deadline=deadline))
        self.assertEqual(self.reads, [])

    def test_deadline_over_three_seconds_rejected(self):
        self.assert_code("INVALID", lambda: self.acquire(self.child(), deadline=103.0001))
        self.assertEqual(self.instances, [])

    def test_deadline_exact_three_seconds_allowed(self):
        self.assertEqual(self.acquire(self.child(), deadline=103.0).returncode, 0)

    def test_invalid_byte_caps(self):
        for key in ("stdout_bytes", "stderr_bytes"):
            for value in (True, False, 0, -1, 1.5, "8", None, 2 ** 53):
                with self.subTest(key=key, value=value):
                    self.assert_code("INVALID", lambda: self.acquire(self.child(), limits=self.limits(**{key: value})))

    def test_caps_cannot_exceed_defaults(self):
        for key, value in (("stdout_bytes", 1048577), ("stderr_bytes", 16385)):
            with self.subTest(key=key):
                self.assert_code("INVALID", lambda: self.acquire(self.child(), limits=self.limits(**{key: value})))

    def test_invalid_poll_intervals(self):
        for value in (True, False, 0, -.01, .050001, float("nan"), float("inf"), "0.01", None, 10 ** 1000):
            with self.subTest(value=value):
                self.assert_code("INVALID", lambda: self.acquire(self.child(), limits=self.limits(poll_seconds=value)))

    def test_limits_object_must_be_typed(self):
        for limits in (None, {}, SimpleNamespace(stdout_bytes=8, stderr_bytes=4, poll_seconds=.01)):
            with self.subTest(limits=limits):
                self.assert_code("INVALID", lambda: self.acquire(self.child(), limits=limits))

    def test_cancel_must_be_event_or_none(self):
        for value in (False, True, object(), SimpleNamespace(is_set=lambda: False)):
            with self.subTest(value=value):
                self.assert_code("INVALID", lambda: self.acquire(self.child(), cancel=value))

    def test_process_must_be_retained_popen(self):
        for value in (None, object(), SimpleNamespace(stdout=self.pipe(), stderr=self.pipe(), poll=lambda: 0)):
            with self.subTest(value=value):
                self.assert_code("INVALID", lambda: self.acquire(value))

    def test_stdout_and_stderr_cannot_be_same_stream(self):
        child = self.child()
        child.stderr = child.stdout
        self.assert_code("INVALID", lambda: self.acquire(child))
        self.assertEqual(self.reads, [])

    def test_duplicate_fifo_descriptor_rejected(self):
        child = self.child()
        clone = os.fdopen(os.dup(child.stdout.fileno()), "rb", buffering=0)
        self.streams.append(clone)
        child.stderr = clone
        self.assert_code("INVALID", lambda: self.acquire(child))
        self.assertEqual(self.reads, [])

    def test_non_fifo_and_missing_or_closed_pipes_rejected(self):
        with tempfile.TemporaryFile("w+b") as regular:
            for value in (None, io.BytesIO(b"secret"), regular):
                with self.subTest(value=type(value).__name__):
                    child = self.child()
                    child.stdout = value
                    self.assert_code("INVALID", lambda: self.acquire(child))
            child = self.child()
            child.stdout.close()
            self.assert_code("INVALID", lambda: self.acquire(child))
        self.assertEqual(self.reads, [])

    def test_selector_failure_is_private_typed_io_error(self):
        child = self.child(self.secret.encode(), self.secret.encode())
        self.select_error = True
        self.assert_code("IO", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_read_failure_is_private_typed_io_error(self):
        child = self.child(self.secret.encode(), self.secret.encode())
        self.patch(subject.os, "read", side_effect=OSError(self.secret))
        self.assert_code("IO", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_wait_failure_is_private_typed_io_error(self):
        child = self.child()
        child.exit_at = 1000
        self.patch(child, "wait", side_effect=OSError(self.secret))
        self.assert_code("IO", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_cleanup_failure_never_returns_a_success_receipt(self):
        child = self.child()
        self.close_selector_error = True
        self.assert_code("CLEANUP", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_overflow_error_never_exposes_stream_contents(self):
        child = self.child(self.secret.encode(), self.secret.encode())
        error = self.assert_code("OVERFLOW", lambda: self.acquire(child, limits=self.limits()))
        self.assertNotIn(self.secret.encode().hex(), str(error))
        self.assertFalse(hasattr(error, "stdout"))
        self.assertFalse(hasattr(error, "stderr"))
        self.assert_closed(child)

    def test_invalid_static_arguments_leave_valid_streams_untouched(self):
        for kwargs in ({"deadline": True}, {"deadline": 103.001}, {"cancel": False}, {"limits": {}}):
            with self.subTest(kwargs=kwargs):
                child = self.child()
                self.assert_code("INVALID", lambda: self.acquire(child, **kwargs))
                self.assertFalse(child.stdout.closed)
                self.assertFalse(child.stderr.closed)
                self.assertTrue(os.get_blocking(child.stdout.fileno()))
                self.assertTrue(os.get_blocking(child.stderr.fileno()))
        self.assertEqual(self.instances, [])

    def test_selector_creation_failure_closes_both_pipes(self):
        child = self.child()
        self.patch(subject.selectors, "DefaultSelector", side_effect=OSError(self.secret))
        self.assert_code("IO", lambda: self.acquire(child))
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)

    def test_register_failure_closes_selector_and_both_pipes(self):
        child = self.child()
        self.patch(FakeSelector, "register", side_effect=OSError(self.secret))
        self.assert_code("IO", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_nonblocking_setup_failure_closes_both_pipes(self):
        child = self.child()
        self.patch(subject.os, "set_blocking", side_effect=OSError(self.secret))
        self.assert_code("IO", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_stream_close_failure_still_closes_other_stream(self):
        child = self.child()
        original = child.stdout.close
        def close_then_fail():
            original()
            raise OSError(self.secret)
        self.patch(child.stdout, "close", close_then_fail)
        self.assert_code("CLEANUP", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_cleanup_failure_overrides_read_failure_without_leaking_content(self):
        child = self.child()
        self.select_error = self.close_selector_error = True
        self.assert_code("CLEANUP", lambda: self.acquire(child))
        self.assert_closed(child)

    def test_late_root_reply_cannot_escape_absolute_deadline(self):
        child = self.child()
        def late_wait(timeout=None):
            self.now = 101.0
            return 0
        self.patch(child, "wait", late_wait)
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=100.1))
        self.assert_closed(child)

    def test_cancel_set_with_successful_wait_suppresses_result(self):
        child = self.child()
        event = threading.Event()
        def cancel_wait(timeout=None):
            event.set()
            return 0
        self.patch(child, "wait", cancel_wait)
        self.assert_code("CANCELLED", lambda: self.acquire(child, cancel=event))
        self.assert_closed(child)

    def test_invalid_root_return_code_is_not_a_receipt(self):
        for value in (True, None, "0"):
            with self.subTest(value=value):
                child = self.child()
                with patch.object(child, "wait", return_value=value):
                    self.assert_code("IO", lambda: self.acquire(child))
                self.assert_closed(child)

    def test_selector_cleanup_consuming_deadline_suppresses_success(self):
        child = self.child(b"result", b"diagnostic")
        deadline = self.now + .1
        original = FakeSelector.close
        def close_after_deadline(selector):
            original(selector)
            self.now = deadline + .001
        self.patch(FakeSelector, "close", close_after_deadline)
        self.assert_code("DEADLINE", lambda: self.acquire(child, deadline=deadline))
        self.assertEqual(child.returncode, 0)
        self.assert_closed(child)

    def test_stream_cleanup_setting_cancel_suppresses_success(self):
        child = self.child(b"result", b"diagnostic")
        event = threading.Event()
        original = child.stderr.close
        def close_then_cancel():
            original()
            event.set()
        self.patch(child.stderr, "close", close_then_cancel)
        self.assert_code("CANCELLED", lambda: self.acquire(child, cancel=event))
        self.assertEqual(child.returncode, 0)
        self.assertTrue(event.is_set())
        self.assert_closed(child)

    def test_eof_and_root_success_do_not_prove_scope_empty(self):
        child = self.child(b"result")
        result = self.acquire(child)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(child.outside_pipe_work_live)
        for name in ("quiescent", "scope_empty", "stopped", "drained"):
            self.assertFalse(hasattr(result, name))
        # This is a logical descendant marker only. No real child is created.
        child.outside_pipe_work_live = False
        self.assert_closed(child)


class OwnedPipeIntegrationTests(unittest.TestCase):
    """Two finite isolated stdlib children, not desktop helpers or scope proof."""
    def acquire_owned(self, body, limits):
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", body],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            return subject.read_reader_pipes(child, deadline=time.monotonic() + 2, limits=limits)
        finally:
            if child.poll() is None:
                child.kill()  # Retained unreaped own fixture root only.
            child.wait(timeout=2)
            child.stdout.close()
            child.stderr.close()

    def test_real_binary_stdout_and_stderr_roundtrip(self):
        result = self.acquire_owned("import os; os.write(1, bytes([0,255,195,169])); os.write(2,b'diag')",
                                    subject.ReaderPipeLimits(stdout_bytes=4, stderr_bytes=4))
        self.assertEqual(result.stdout, bytes([0,255,195,169]))
        self.assertEqual(result.stderr, b"diag")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(hasattr(result, "scope_empty"))

    def test_real_pipe_overflow_is_bounded_and_owned_root_is_reaped(self):
        with self.assertRaises(subject.ReaderPipeError) as caught:
            self.acquire_owned("import os; os.write(1,b'x'*64)",
                               subject.ReaderPipeLimits(stdout_bytes=8, stderr_bytes=8))
        self.assertEqual(caught.exception.code, "OVERFLOW")
        self.assertNotIn("xxxxxxxx", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
