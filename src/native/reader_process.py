"""Unavailable owned capture admission plus pure staging-boundary checks.

The caller owns authorization, device credit, binding and runtime selection. A
successful result is not evidence of provider or compositor quiescence. Keep
conflicting provider credit quarantined until independently qualified. Every
error also reports owned_scope UNKNOWN, even if best-effort cleanup appeared
to succeed; callers must not infer an owned-scope drain from its error code.
Non-atomic Popen/pidfd acquisition and numeric cgroup admission remain unqualified
under competing external reapers; strict wait receipts do not repair creation.
The module remains dormant, never production admission or provider completion.
"""
from dataclasses import dataclass
import math
import time



class ReaderProcessError(RuntimeError):
    def __init__(self, code):
        self.code = code
        self.provider_completion = "UNKNOWN"
        self.owned_scope = "UNKNOWN"
        super().__init__("Reader capture failed (" + code + ")")


@dataclass(frozen=True)
class ReaderCapture:
    png: bytes
    width: int
    height: int
    provider_completion: str = "UNKNOWN"


def _fail(code):
    raise ReaderProcessError(code) from None


def _finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _check(deadline, cancel, guard):
    if cancel is not None and cancel.is_set():
        _fail("CANCELLED")
    if time.monotonic() >= deadline:
        _fail("DEADLINE")
    try:
        valid = guard()
    except BaseException:
        _fail("BINDING")
    if valid is not True:
        _fail("BINDING")
    # A trusted guard can consume the remaining budget or revoke via cancellation.
    # Its True return never bypasses the same absolute deadline/cancel boundary.
    after_guard = time.monotonic()
    if not _finite(after_guard) or after_guard >= deadline:
        _fail("DEADLINE")
    if cancel is not None and cancel.is_set():
        _fail("CANCELLED")


def capture_reader(scope, *, target, width, height, runtime_dir, wayland_display,
                   deadline, guard, cancel=None):
    """Unavailable until atomic owned creation and cgroup placement are qualified.

    Strict wait receipts do not prove that Popen->pidfd_open or numeric admission
    selected the original task. Refuse before inspecting input, preparing a scope,
    spawning, signaling, reading capture data or invoking callbacks. No enable flag,
    test bypass or alternate callable implementation exists here.
    """
    _fail("UNKNOWN")
