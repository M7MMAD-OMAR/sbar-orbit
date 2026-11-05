"""Dormant bounded pipe acquisition for a trusted, already-owned reader root.

This module never spawns, signals, authorizes, or proves scope quiescence. EOF
and a reaped root do not prove descendants stopped. The upper owned-scope layer
must stop/reconcile work before returning allocation credit or publishing data.
"""
from dataclasses import dataclass
import math
import os
import selectors
import stat
import subprocess
import threading
import time

_now = time.monotonic


class ReaderPipeError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def _fail(code, message):
    raise ReaderPipeError(code, message)


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


@dataclass(frozen=True)
class ReaderPipeLimits:
    stdout_bytes: int = 1048576
    stderr_bytes: int = 16384
    poll_seconds: float = 0.05

    def __post_init__(self):
        for value, maximum in ((self.stdout_bytes, 1048576), (self.stderr_bytes, 16384)):
            if type(value) is not int or not 1 <= value <= maximum:
                _fail("INVALID", "Reader pipe byte ceilings may only be narrowed")
        if (not _finite(self.poll_seconds)
                or not 0 < self.poll_seconds <= 0.05):
            _fail("INVALID", "Reader pipe polling interval is invalid")


@dataclass(frozen=True)
class ReaderPipeResult:
    stdout: bytes
    stderr: bytes
    returncode: int
    wait_receipt: object = None


def read_reader_pipes(process, *, deadline, limits=ReaderPipeLimits(), cancel=None, wait_root=None):
    """Read finite binary output; producer must separately own and drain its scope.

    Pipes must be dedicated unconsumed binary streams, not a buffered-prefix handoff.
    wait_root is a trusted scope-bound actual-kernel waiter, never request code;
    retirement independently requires the exact receipt identity registered there.
    If post-wait validation or stream cleanup fails, no result/token is returned.
    The consumed wait remains UNKNOWN/debt: do not retrieve private fields or
    retry wait_root to manufacture successful acquisition.
    Invalid static arguments do not take stream ownership. After validation all
    success/failure paths close the two owned pipes, including expired/cancelled
    acquisition. Closing pipes may affect that helper but never proves it ended.
    """
    if (not isinstance(process, subprocess.Popen) or type(limits) is not ReaderPipeLimits
            or not _finite(deadline) or not callable(wait_root)
            or deadline - _now() > 3.0 or cancel is not None and not isinstance(cancel, threading.Event)):
        _fail("INVALID", "Invalid internal reader pipe acquisition")
    streams = (process.stdout, process.stderr)
    try:
        if any(stream is None or stream.closed for stream in streams):
            _fail("INVALID", "Reader acquisition requires two open pipes")
        descriptors = tuple(stream.fileno() for stream in streams)
        identities = tuple(os.fstat(fd) for fd in descriptors)
        if (descriptors[0] == descriptors[1] or any(not stat.S_ISFIFO(info.st_mode) for info in identities)
                or (identities[0].st_dev, identities[0].st_ino) == (identities[1].st_dev, identities[1].st_ino)):
            _fail("INVALID", "Reader acquisition requires separate pipe descriptors")
    except ReaderPipeError:
        raise
    except BaseException:
        _fail("INVALID", "Reader pipe descriptors are invalid")

    buffers = (bytearray(), bytearray())
    ceilings = (limits.stdout_bytes, limits.stderr_bytes)
    selector = None
    error = None
    result = None

    def remaining():
        if cancel is not None and cancel.is_set():
            _fail("CANCELLED", "Reader pipe acquisition was cancelled; owned scope stop remains separate")
        left = deadline - _now()
        if left <= 0:
            _fail("DEADLINE", "Reader pipe acquisition exceeded its deadline; owned scope stop remains separate")
        return left

    try:
        remaining()
        selector = selectors.DefaultSelector()
        for index, stream in enumerate(streams):
            os.set_blocking(descriptors[index], False)
            selector.register(stream, selectors.EVENT_READ, index)
        while selector.get_map():
            events = selector.select(min(remaining(), limits.poll_seconds))
            remaining()
            for key, _ in events:
                remaining()
                index = key.data
                # Read at most one overflow sentinel beyond the remaining reservation.
                size = min(32768, ceilings[index] - len(buffers[index]) + 1)
                try:
                    chunk = os.read(key.fd, size)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                elif len(chunk) > ceilings[index] - len(buffers[index]):
                    _fail("OVERFLOW", "Reader pipe output exceeded its reserved byte ceiling")
                else:
                    buffers[index].extend(chunk)
        # Root waiting remains deadline/cancel aware even after both pipes close.
        # This is only a root outcome, never a descendant-empty receipt.
        remaining()
        # Trusted scope callback must consume actual P_PIDFD wait status. A promise,
        # Popen.returncode or Popen.wait(ECHILD)->0 is never root-reap evidence.
        receipt = wait_root(deadline=deadline, cancel=cancel)
        remaining()
        if receipt is None or type(receipt.returncode) is not int:
            _fail("IO", "Reader root has no actual kernel wait receipt")
        result = ReaderPipeResult(bytes(buffers[0]), bytes(buffers[1]), receipt.returncode, receipt)
    except ReaderPipeError as caught:
        error = caught
    except BaseException:
        error = ReaderPipeError("IO", "Reader pipe acquisition failed; owned scope stop remains separate")
    finally:
        cleanup_failed = False
        if selector is not None:
            try:
                selector.close()
            except BaseException:
                cleanup_failed = True
        for stream in streams:
            try:
                stream.close()
            except BaseException:
                cleanup_failed = True
        if cleanup_failed:
            error = ReaderPipeError("CLEANUP", "Reader pipe cleanup is unconfirmed; do not reclaim owned scope credit")
    # Conversion and descriptor cleanup also consume the end-to-end budget.
    if error is None:
        try:
            remaining()
        except ReaderPipeError as caught:
            error = caught
        except BaseException:
            error = ReaderPipeError("IO", "Reader completion state could not be verified")
    if error is not None:
        raise error from None
    return result
