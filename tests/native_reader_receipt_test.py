"""Owned synthetic pipe fixtures only, not evidence that a compositor helper is qualified."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
import fcntl
import hashlib
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import reader_receipt as subject

WIRE = struct.Struct(">8sBBBB32s32sII")
NONCE = bytes(range(32))
TARGET = hashlib.sha256(b"owned-native-binding-instance-geometry-epoch").digest()
SECRET = "PRIVATE-helper-path-error-pixels"


class Selector:
    def __init__(self, owner):
        self.owner, self.fd, self.closed = owner, None, False
        owner.selectors.append(self)

    def register(self, fd, events):
        self.fd = fd

    def select(self, timeout):
        self.owner.assertGreater(timeout, 0)
        self.owner.assertLessEqual(timeout, .05)
        self.owner.now += min(timeout, .01)
        if self.owner.on_select:
            self.owner.on_select()
        return [(None, selectors.EVENT_READ)]

    def close(self):
        self.closed = True
        if self.owner.on_close:
            self.owner.on_close()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.now, self.allowed = 100.0, True
        self.fds, self.reads, self.selectors = set(), [], []
        self.receipt_fds = set()
        self.on_select = self.on_close = None
        self.real_read = os.read
        self.real_selector = selectors.DefaultSelector
        self.patch(subject, "_now", lambda: self.now)
        self.patch(subject.selectors, "DefaultSelector", lambda: Selector(self))
        self.patch(subject.os, "read", self.read)
        self.addCleanup(self.cleanup)

    def patch(self, obj, name, value=None, **kwargs):
        operation = patch.object(obj, name, value, **kwargs) if value is not None else patch.object(obj, name, **kwargs)
        result = operation.start()
        self.addCleanup(operation.stop)
        return result

    def cleanup(self):
        for fd in self.fds:
            os.close(fd)

    def read(self, fd, count):
        if fd not in self.receipt_fds:
            return self.real_read(fd, count)
        self.reads.append((fd, count))
        self.assertFalse(os.get_blocking(fd))
        return self.real_read(fd, count)

    def record(self, **changes):
        fields = dict(magic=b"ORBRCP01", version=1, state=1, flags=3, reserved=0,
                      nonce=NONCE, target=TARGET, width=200, height=100)
        fields.update(changes)
        return WIRE.pack(*(fields[key] for key in ("magic", "version", "state", "flags", "reserved", "nonce", "target", "width", "height")))

    def pipe(self, data=b"", eof=True):
        rd, wr = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.fds.update((rd, wr))
        self.receipt_fds.add(rd)
        if data:
            self.assertEqual(os.write(wr, data), len(data))
        if eof:
            os.close(wr)
            self.fds.remove(wr)
        return rd, wr

    def reader(self, fd, **overrides):
        values = dict(nonce=NONCE, target_digest=TARGET, width=200, height=100)
        values.update(overrides)
        return subject.ReaderReceipt(fd, **values)

    def acquire(self, reader, **overrides):
        values = dict(deadline=self.now + .2, guard=lambda: self.allowed)
        values.update(overrides)
        return reader.read(**values)

    def assert_unknown(self, result):
        self.assertEqual(result, subject.ReaderReceiptResult("UNKNOWN"))
        self.assertNotIn(SECRET, repr(result))
        for field in ("nonce", "target_digest", "data", "error", "quiescent", "scope_empty"):
            self.assertFalse(hasattr(result, field))

    def test_fixed_84_byte_record_and_frozen_ready_result(self):
        self.assertEqual(WIRE.size, 84)
        fd, _ = self.pipe(self.record())
        result = self.acquire(self.reader(fd))
        self.assertEqual(result, subject.ReaderReceiptResult("READY", 200, 100))
        with self.assertRaises(FrozenInstanceError):
            result.status = "UNKNOWN"
        self.assertTrue(all(selector.closed for selector in self.selectors))

    def test_eof_without_record_is_not_evidence(self):
        fd, _ = self.pipe()
        self.assert_unknown(self.acquire(self.reader(fd)))

    def test_complete_record_without_writer_eof_cannot_succeed(self):
        fd, _ = self.pipe(self.record(), eof=False)
        self.assert_unknown(self.acquire(self.reader(fd), deadline=100.035))
        self.assertLessEqual(self.now, 100.035 + 1e-9)

    def test_every_truncated_prefix_is_unknown(self):
        for size in range(84):
            with self.subTest(size=size):
                fd, _ = self.pipe(self.record()[:size])
                self.assert_unknown(self.acquire(self.reader(fd)))

    def test_trailing_junk_and_multiple_records_are_unknown(self):
        for payload in (self.record() + b"x", self.record() * 2, self.record() + SECRET.encode()):
            fd, _ = self.pipe(payload)
            self.assert_unknown(self.acquire(self.reader(fd)))

    def test_one_byte_overflow_sentinel_never_requests_unbounded_bytes(self):
        fd, _ = self.pipe(self.record() * 3)
        self.assert_unknown(self.acquire(self.reader(fd)))
        self.assertEqual(self.reads, [(fd, 85)])

    def test_exact_nonce_identity_geometry_and_wire_values_required(self):
        for changes in (dict(magic=b"NOTVALID"), dict(version=0), dict(version=2), dict(state=0), dict(state=3),
                        dict(reserved=1), dict(flags=4), dict(nonce=b"n" * 32), dict(target=b"t" * 32),
                        dict(width=201), dict(height=101), dict(width=0), dict(height=0)):
            with self.subTest(changes=changes.keys()):
                fd, _ = self.pipe(self.record(**changes))
                self.assert_unknown(self.acquire(self.reader(fd)))

    def test_ready_requires_both_teardown_and_same_connection_sync_flags(self):
        for flags in (0, 1, 2):
            fd, _ = self.pipe(self.record(flags=flags))
            self.assert_unknown(self.acquire(self.reader(fd)))

    def test_failed_record_even_with_both_progress_flags_remains_unknown(self):
        for flags in (0, 1, 2, 3):
            fd, _ = self.pipe(self.record(state=2, flags=flags))
            self.assert_unknown(self.acquire(self.reader(fd)))

    def test_second_read_cannot_retry_or_replay_success(self):
        fd, _ = self.pipe(self.record())
        reader = self.reader(fd)
        self.assertEqual(self.acquire(reader).status, "READY")
        count = len(self.reads)
        self.assert_unknown(self.acquire(reader))
        self.assertEqual(len(self.reads), count)

    def test_guard_revoked_before_read_prevents_io(self):
        fd, _ = self.pipe(self.record())
        self.allowed = False
        self.assert_unknown(self.acquire(self.reader(fd)))
        self.assertEqual(self.reads, [])

    def test_guard_revoked_during_selector_cleanup_suppresses_late_ready(self):
        fd, _ = self.pipe(self.record())
        self.on_close = lambda: setattr(self, "allowed", False)
        self.assert_unknown(self.acquire(self.reader(fd)))

    def test_cancel_before_read_and_after_eof_cleanup(self):
        for stage in ("before", "cleanup"):
            fd, _ = self.pipe(self.record())
            event = threading.Event()
            if stage == "before":
                event.set()
            else:
                self.on_close = event.set
            self.assert_unknown(self.acquire(self.reader(fd), cancel=event))
            self.on_close = None

    def test_deadline_expired_before_io_and_consumed_during_cleanup(self):
        fd, _ = self.pipe(self.record())
        self.assert_unknown(self.acquire(self.reader(fd), deadline=100.0))
        self.assertEqual(self.reads, [])
        fd, _ = self.pipe(self.record())
        self.on_close = lambda: setattr(self, "now", 101.0)
        self.assert_unknown(self.acquire(self.reader(fd), deadline=100.2))

    def test_invalid_deadlines_guard_and_cancel_have_no_io_or_retry(self):
        for values in (dict(deadline=True), dict(deadline=float("nan")), dict(deadline=float("inf")),
                       dict(deadline=10 ** 1000), dict(deadline=104), dict(guard=None), dict(cancel=True)):
            fd, _ = self.pipe(self.record())
            reader = self.reader(fd)
            self.assert_unknown(self.acquire(reader, **values))
            self.assert_unknown(self.acquire(reader))
        self.assertEqual(self.reads, [])

    def test_guard_deadline_or_cancellation_side_effect_cannot_publish(self):
        for mode in ("deadline", "cancel"):
            fd, _ = self.pipe(self.record())
            event = threading.Event()
            deadline = self.now + .2
            def guard():
                if mode == "deadline":
                    self.now = deadline
                else:
                    event.set()
                return True
            self.assert_unknown(self.acquire(self.reader(fd), deadline=deadline, guard=guard, cancel=event))

    def test_partial_trickle_cannot_renew_absolute_deadline(self):
        fd, wr = self.pipe(eof=False)
        sent = [0]
        def trickle():
            os.write(wr, self.record()[sent[0]:sent[0] + 1])
            sent[0] += 1
        self.on_select = trickle
        self.assert_unknown(self.acquire(self.reader(fd), deadline=100.035))
        self.assertLessEqual(sent[0], 4)

    def test_fragmented_record_then_eof_is_accepted(self):
        fd, wr = self.pipe(eof=False)
        sent = [0]
        def fragment():
            start = sent[0]
            if start < 84:
                count = os.write(wr, self.record()[start:start + 17])
                sent[0] += count
            else:
                os.close(wr)
                self.fds.remove(wr)
                self.on_select = None
        self.on_select = fragment
        self.assertEqual(self.acquire(self.reader(fd)).status, "READY")

    def test_fd_borrow_is_not_closed_and_flags_are_not_changed(self):
        fd, _ = self.pipe(self.record())
        before = (os.fstat(fd).st_ino, fcntl.fcntl(fd, fcntl.F_GETFL))
        self.assertEqual(self.acquire(self.reader(fd)).status, "READY")
        self.assertEqual((os.fstat(fd).st_ino, fcntl.fcntl(fd, fcntl.F_GETFL)), before)

    def test_replaced_fd_or_changed_blocking_mode_refuses_without_consumption(self):
        fd, _ = self.pipe(self.record())
        reader = self.reader(fd)
        other, _ = self.pipe(self.record())
        os.dup2(other, fd)
        self.assert_unknown(self.acquire(reader))
        self.assertEqual(self.real_read(fd, 84), self.record())
        fd, _ = self.pipe(self.record())
        reader = self.reader(fd)
        os.set_blocking(fd, True)
        self.assert_unknown(self.acquire(reader))

    def test_regular_file_write_end_and_blocking_pipe_rejected(self):
        with tempfile.TemporaryFile() as regular:
            with self.assertRaises(subject.ReaderReceiptError):
                self.reader(regular.fileno())
        fd, wr = self.pipe(eof=False)
        with self.assertRaises(subject.ReaderReceiptError):
            self.reader(wr)
        os.set_blocking(fd, True)
        with self.assertRaises(subject.ReaderReceiptError):
            self.reader(fd)

    def test_constructor_static_types_and_caps_are_strict(self):
        for changes in (dict(nonce=b"x" * 31), dict(nonce=bytearray(32)), dict(target_digest=b"x" * 33),
                        dict(width=True), dict(width=0), dict(width=1281), dict(height=961), dict(height=1.0)):
            fd, _ = self.pipe()
            with self.assertRaises(subject.ReaderReceiptError):
                self.reader(fd, **changes)
        for fd in (True, -1, 0, 1, 2, "3"):
            with self.assertRaises(subject.ReaderReceiptError):
                self.reader(fd)

    def test_constructor_io_failure_has_no_raw_context_or_secret(self):
        fd, _ = self.pipe()
        with patch.object(subject.os, "fstat", side_effect=OSError(SECRET)):
            with self.assertRaises(subject.ReaderReceiptError) as caught:
                self.reader(fd)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_read_selector_and_cleanup_errors_are_fixed_unknown(self):
        for operation in ("read", "select", "close"):
            fd, _ = self.pipe(self.record())
            reader = self.reader(fd)
            target, name = (subject.os, "read") if operation == "read" else (Selector, operation)
            with patch.object(target, name, side_effect=OSError(SECRET)):
                self.assert_unknown(self.acquire(reader))
            os.fstat(fd)

    def test_clock_rollback_nonfinite_and_exception_are_unknown(self):
        for clock in ((100.0, 99.0), (float("nan"),), (OSError(SECRET),)):
            fd, _ = self.pipe(self.record())
            reader = self.reader(fd)
            with patch.object(subject, "_now", side_effect=clock):
                self.assert_unknown(self.acquire(reader))

    def test_guard_can_not_reenter_reader_or_expose_second_record(self):
        fd, _ = self.pipe(self.record())
        reader = self.reader(fd)
        calls = []
        def guard():
            calls.append(self.acquire(reader).status)
            return True
        self.assertEqual(self.acquire(reader, guard=guard).status, "READY")
        self.assertTrue(calls)
        self.assertEqual(set(calls), {"UNKNOWN"})

    def test_guard_fd_replacement_is_rejected_before_consuming_replacement_pipe(self):
        fd, _ = self.pipe(self.record())
        other, _ = self.pipe(self.record())
        reader = self.reader(fd)
        changed = [False]
        def guard():
            if not changed[0]:
                changed[0] = True
                os.dup2(other, fd)
            return True
        self.assert_unknown(self.acquire(reader, guard=guard))
        self.assertEqual(self.reads, [])
        self.assertEqual(self.real_read(fd, 84), self.record())

    def test_concurrent_calls_share_exactly_one_single_use_attempt(self):
        fd, _ = self.pipe(self.record())
        reader = self.reader(fd)
        barrier = threading.Barrier(2)
        def run():
            barrier.wait(timeout=1)
            return self.acquire(reader).status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: run(), range(2)))
        self.assertEqual(sorted(results), ["READY", "UNKNOWN"])

    def test_real_owned_child_inherited_pipe_record_and_eof(self):
        fd, wr = self.pipe(eof=False)
        reader = self.reader(fd)
        code = "import os,sys; data=sys.stdin.buffer.read(85); os.write(int(sys.argv[1]),data); os.close(int(sys.argv[1]))"
        # Retain the exact Popen object even if __init__ fails after starting its child.
        child = subprocess.Popen.__new__(subprocess.Popen)
        try:
            with patch.object(subject.os, "read", self.real_read):
                subprocess.Popen.__init__(child, [sys.executable, "-I", "-S", "-c", code, str(wr)], stdin=subprocess.PIPE,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(wr,))
            child.stdin.write(self.record())
            child.stdin.close()
            os.close(wr)
            self.fds.remove(wr)
            with patch.object(subject, "_now", time.monotonic), patch.object(subject.selectors, "DefaultSelector", self.real_selector):
                result = reader.read(deadline=time.monotonic() + 1.0, guard=lambda: True)
            self.assertEqual(result.status, "READY")
            self.assertEqual(child.wait(timeout=2), 0)
        finally:
            stdin = getattr(child, "stdin", None)
            if stdin is not None and not stdin.closed:
                stdin.close()
            if getattr(child, "_child_created", False) and child.poll() is None:
                child.kill()
                child.wait(timeout=1)


if __name__ == "__main__":
    unittest.main()
