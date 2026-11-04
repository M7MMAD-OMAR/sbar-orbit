"""Dormant, trusted-only one-shot capture orchestration.

The caller owns authorization, device credit, binding and runtime selection. A
successful result is not evidence of provider or compositor quiescence. Keep
conflicting provider credit quarantined until independently qualified. Every
error also reports owned_scope UNKNOWN, even if best-effort cleanup appeared
to succeed; callers must not infer an owned-scope drain from its error code.
"""
from dataclasses import dataclass
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time

from .reader_pipe import read_reader_pipes
from .reader_png import validate_reader_png
from .reader_scope import ReaderScope


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


def _environment(runtime, display):
    # No side effects before scope.prepare, and mirror bootstrap's path contract.
    if (not runtime.startswith("/") or runtime == "/" or runtime.endswith("/")
            or "\0" in runtime or os.path.realpath(runtime) != runtime
            or not display.startswith(runtime + "/") or os.path.dirname(display) != runtime
            or re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", os.path.basename(display)) is None
            or os.path.basename(display) in (".", "..") or os.path.realpath(display) != display):
        _fail("INVALID")
    try:
        directory, socket = os.lstat(runtime), os.lstat(display)
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid()
                or directory.st_mode & 0o077 or not stat.S_ISSOCK(socket.st_mode)
                or socket.st_uid != os.getuid()):
            _fail("INVALID")
    except OSError:
        _fail("INVALID")
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "XDG_RUNTIME_DIR": runtime, "WAYLAND_DISPLAY": display}


def _wait_stopped(process, deadline, cancel, guard):
    # WNOWAIT leaves the exit for Popen.wait and the root-reap receipt.
    while True:
        _check(deadline, cancel, guard)
        info = os.waitid(os.P_PID, process.pid, os.WSTOPPED | os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if info is not None and info.si_pid:
            if info.si_code == os.CLD_STOPPED and info.si_status == signal.SIGSTOP:
                return
            _fail("BOOTSTRAP")
        time.sleep(min(0.01, max(0, deadline - time.monotonic())))


def _cleanup(scope, process, pidfd, admission_attempted, bound, deadline):
    """Best effort within a separate short ceiling; never infer a receipt."""
    ok = pidfd is not None or process.returncode is not None
    if pidfd is not None and process.returncode is None:
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except BaseException:
            ok = False
    if admission_attempted:
        try:
            scope.kill()
        except BaseException:
            ok = False
    if process is not None:
        try:
            process.wait(timeout=max(0, deadline - time.monotonic()))
        except BaseException:
            ok = False
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except BaseException:
                    ok = False
    if bound and ok and time.monotonic() < deadline:
        try:
            # retire performs independent root identity, reap and leaf-empty checks.
            receipt = scope.retire()
            if (receipt.get("scopeEmpty") is not True or receipt.get("rootReaped") is not True
                    or receipt.get("neverAdmitted") is not False):
                ok = False
        except BaseException:
            ok = False
    return ok


def capture_reader(scope, *, target, width, height, runtime_dir, wayland_display,
                   deadline, guard, cancel=None):
    """Capture one exact trusted binding, without exposing any command choice.

    The guard is a trusted owner-side binding/permission check, not a request
    callback. Scope, environment and geometry must originate in protected owner
    state. No production caller is enabled by this module. Deadline checks are
    cooperative: Popen, filesystem, journal and kernel calls may block beyond it.
    Guard callbacks are trusted non-reentrant staging checks. Final delivery must
    recheck binding/permission under the same owner authority lock as revocation;
    this function return is not atomic future permission or provider-stop proof.
    """
    now = time.monotonic()
    if (sys.platform != "linux" or type(scope) is not ReaderScope
            or type(target) is not str or re.fullmatch(r"[0-9a-f]{1,16}", target) is None
            or type(width) is not int or not 0 < width <= 1280
            or type(height) is not int or not 0 < height <= 960
            or type(runtime_dir) is not str or type(wayland_display) is not str
            or not runtime_dir.startswith("/") or not wayland_display.startswith(runtime_dir + "/")
            or not _finite(deadline)
            or deadline <= now or deadline - now > 3.0
            or not callable(guard) or (cancel is not None and not isinstance(cancel, threading.Event))):
        _fail("INVALID")
    try:
        environment = _environment(runtime_dir, wayland_display)
    except BaseException:
        _fail("INVALID")
    _check(deadline, cancel, guard)
    process = None
    pidfd = None
    bound = False
    admission_attempted = False
    reserved = False
    prepared = False
    retired = False
    try:
        scope.prepare()
        prepared = True
        _check(deadline, cancel, guard)
        # An interrupted or failed journal append can already have created debt.
        reserved = True
        scope.reserve_spawn()
        _check(deadline, cancel, guard)
        bootstrap = str(Path(__file__).resolve().with_name("reader_bootstrap.py"))
        process = subprocess.Popen(["/usr/bin/python3", "-I", "-S", bootstrap,
                                    str(os.getpid()), target], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=environment, close_fds=True)
        # Pin the direct child before binding, so binding failure can still stop
        # this exact process without ever signalling a recycled numeric PID.
        try:
            pidfd = os.pidfd_open(process.pid, 0)
        except BaseException:
            # Record the exact child if possible, but never signal by numeric PID.
            scope.bind_child(process)
            bound = True
            raise
        scope.bind_child(process)
        bound = True
        _wait_stopped(process, deadline, cancel, guard)
        _check(deadline, cancel, guard)
        admission_attempted = True
        scope.admit(process)
        _check(deadline, cancel, guard)
        signal.pidfd_send_signal(pidfd, signal.SIGCONT)
        pipes = read_reader_pipes(process, deadline=deadline, cancel=cancel)
        if pipes.returncode != 0:
            _fail("PROVIDER")
        _check(deadline, cancel, guard)
        validate_reader_png(pipes.stdout, width, height,
                            check=lambda: _check(deadline, cancel, guard))
        _check(deadline, cancel, guard)
        receipt = scope.retire()
        retired = True
        if (receipt.get("scopeEmpty") is not True or receipt.get("rootReaped") is not True
                or receipt.get("neverAdmitted") is not False):
            _fail("UNKNOWN")
        _check(deadline, cancel, guard)
        return ReaderCapture(pipes.stdout, width, height)
    except BaseException as error:
        cleanup_deadline = time.monotonic() + 0.25
        if process is not None and not retired:
            _cleanup(scope, process, pidfd, admission_attempted, bound, cleanup_deadline)
        elif process is None and prepared and not reserved:
            # Only a fully prepared leaf before spawn reservation is eligible.
            # Partial prepare or uncertain retirement remains durable debt.
            try:
                receipt = scope.retire()
                if (receipt.get("scopeEmpty") is not True or receipt.get("rootReaped") is not False
                        or receipt.get("neverAdmitted") is not True):
                    _fail("UNKNOWN")
            except BaseException:
                _fail("UNKNOWN")
        # Preserve no internal exception object or context that could expose output.
        code = error.code if type(error) is ReaderProcessError else "UNKNOWN"
        _fail(code)
    finally:
        if pidfd is not None:
            try:
                os.close(pidfd)
            except OSError:
                _fail("UNKNOWN")
