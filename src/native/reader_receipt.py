"""One operation's borrowed-pipe helper evidence, NOT compositor/GPU quiescence.

Wire v1 is exactly 84 bytes, network order >8sBBBB32s32sII:
ORBRCP01, version=1, READY=1 or FAILED=2, progress flags (teardown=1,
same-connection sync observed=2), reserved=0, operation nonce[32], exact
native-target identity digest[32], expected physical width and height.
READY requires both flags. FAILED can report either/both progress flags but
always yields UNKNOWN. No text, paths, JSON, pixels or provider diagnostics.

The caller supplies unpredictable per-operation nonce and identity digest via
protected parent state. The receipt FD must be an exclusive, unconsumed,
already-nonblocking read-only FIFO. Caller keeps it alive and must not close,
reuse, duplicate-consume or change its flags until read returns. This reader
never closes the borrowed FD or changes its flags. A separately qualified
helper must actually perform teardown and sync on the same connection before
writing. Existing grim/process/EOF results cannot manufacture those facts.
No production capture import, spawning, signals, retries or grants exist here.
"""
from dataclasses import dataclass
import fcntl
import hmac
import math
import os
import selectors
import stat
import struct
import threading
import time

_now = time.monotonic
_RECORD = struct.Struct(">8sBBBB32s32sII")
_MAGIC = b"ORBRCP01"
_UNKNOWN = None


class ReaderReceiptError(RuntimeError):
    def __init__(self):
        self.code = "INVALID"
        super().__init__("Invalid internal reader receipt binding")


@dataclass(frozen=True)
class ReaderReceiptResult:
    status: str
    width: int | None = None
    height: int | None = None


_UNKNOWN = ReaderReceiptResult("UNKNOWN")


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _pipe_identity(fd):
    info = os.fstat(fd)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    if (not stat.S_ISFIFO(info.st_mode) or flags & os.O_ACCMODE != os.O_RDONLY
            or not flags & os.O_NONBLOCK):
        raise ReaderReceiptError()
    return (info.st_dev, info.st_ino)


class ReaderReceipt:
    """Single-use parsing only, never a stop grant or authenticated helper receipt.

    Caller MUST verify exact writer process/provenance and hold exclusive reader
    ownership across ALL instances and duplicated descriptors for this pipe. The
    per-instance lock only prevents concurrent/reentrant use of this instance.
    Result objects are freely constructible and must never serve as authority.
    guard must not mutate, close, reuse or consume the FD. Parent FD exclusivity
    remains mandatory; identity checks cannot remove a concurrent-close TOCTOU.
    """
    __slots__ = ("_fd", "_identity", "_nonce", "_target", "_width", "_height", "_used", "_lock")

    def __init__(self, fd, *, nonce, target_digest, width, height):
        if (type(fd) is not int or fd < 3 or type(nonce) is not bytes or len(nonce) != 32
                or type(target_digest) is not bytes or len(target_digest) != 32
                or type(width) is not int or not 1 <= width <= 1280
                or type(height) is not int or not 1 <= height <= 960):
            raise ReaderReceiptError()
        identity = None
        try:
            identity = _pipe_identity(fd)
        except BaseException:
            pass
        if identity is None:
            # Raise outside the handler: no retained raw exception context.
            raise ReaderReceiptError()
        self._fd, self._identity = fd, identity
        self._nonce, self._target = nonce, target_digest
        self._width, self._height, self._used = width, height, False
        self._lock = threading.Lock()

    def read(self, *, deadline, guard, cancel=None):
        """Require exact record AND writer EOF before returning any READY evidence.

        Bounded nonblocking waits use one absolute monotonic deadline <=3 seconds.
        Scheduling/syscalls are cooperative, not hard preemption of a stalled OS.
        Every runtime failure maps to fixed UNKNOWN; no raw bytes/error are exposed.
        guard is a trusted synchronous non-reentrant owner-side final boundary,
        combining current binding/permission, deadline and revocation checks. A
        matching nonce is correlation only and never supplies that authority.
        The caller must serialize final guard/receipt consumption with revocation
        under its protected shared authority lock; this borrowed pipe cannot make
        arbitrary external revocation atomic or authorize future work.
        """
        with self._lock:
            if self._used:
                return _UNKNOWN
            self._used = True  # Before callbacks: no concurrent/reentrant retry.
        if (not _finite(deadline) or not callable(guard)
                or cancel is not None and type(cancel) is not threading.Event):
            return _UNKNOWN
        selector, data, valid = None, bytearray(), False
        last = None

        def check():
            nonlocal last
            sampled = _now()
            if (not _finite(sampled) or last is not None and sampled < last
                    or sampled >= deadline or last is None and deadline - sampled > 3.0):
                raise RuntimeError()
            last = sampled
            if cancel is not None and threading.Event.is_set(cancel):
                raise RuntimeError()
            if _pipe_identity(self._fd) != self._identity:
                raise RuntimeError()
            if guard() is not True:
                raise RuntimeError()
            if _pipe_identity(self._fd) != self._identity:
                raise RuntimeError()
            after = _now()
            if not _finite(after) or after < sampled or after >= deadline:
                raise RuntimeError()
            last = after
            if cancel is not None and threading.Event.is_set(cancel):
                raise RuntimeError()
            return deadline - after

        try:
            check()
            selector = selectors.DefaultSelector()
            selector.register(self._fd, selectors.EVENT_READ)
            eof = False
            while not eof:
                ready = selector.select(min(0.05, check()))
                check()
                for _key, _event in ready:
                    check()
                    try:
                        # One overflow sentinel; never retain more than the fixed record.
                        chunk = os.read(self._fd, _RECORD.size - len(data) + 1)
                    except (BlockingIOError, InterruptedError):
                        continue
                    check()
                    if not chunk:
                        eof = True
                        break
                    if len(chunk) > _RECORD.size - len(data):
                        return _UNKNOWN
                    data.extend(chunk)
            check()
            if len(data) != _RECORD.size:
                return _UNKNOWN
            magic, version, state, flags, reserved, nonce, target, width, height = _RECORD.unpack(data)
            valid = (magic == _MAGIC and version == 1 and state in (1, 2)
                     and flags in (0, 1, 2, 3) and reserved == 0
                     and hmac.compare_digest(nonce, self._nonce)
                     and hmac.compare_digest(target, self._target)
                     and width == self._width and height == self._height
                     and state == 1 and flags == 3)
            check()
        except BaseException:
            valid = False
        finally:
            if selector is not None:
                try:
                    selector.close()
                except BaseException:
                    valid = False
        # Cleanup itself can consume the deadline or revoke the operation.
        if valid:
            try:
                check()
            except BaseException:
                valid = False
        return ReaderReceiptResult("READY", self._width, self._height) if valid else _UNKNOWN
