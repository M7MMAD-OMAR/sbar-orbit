"""Fixed isolated capture bootstrap: stop before provider execution or forking.

Invoke with /usr/bin/python3 -I -S SCRIPT EXPECTED_PARENT STABLE_HEX_ID.
This is not an application launcher, arbitrary command runner or authority grant.
"""
import ctypes
import errno
import os
import re
import signal
import stat
import sys


FAILURE = 70


def _environment():
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    display = os.environ.get("WAYLAND_DISPLAY", "")
    if (not runtime.startswith("/") or runtime == "/" or "\0" in runtime
            or os.path.realpath(runtime) != runtime or runtime.endswith("/")):
        raise ValueError("Invalid runtime")
    directory = os.lstat(runtime)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise ValueError("Invalid runtime")
    if (not display.startswith(runtime + "/") or os.path.dirname(display) != runtime
            or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", os.path.basename(display))
            or os.path.basename(display) in (".", "..") or os.path.realpath(display) != display):
        raise ValueError("Invalid display")
    socket = os.lstat(display)
    if not stat.S_ISSOCK(socket.st_mode) or socket.st_uid != os.getuid():
        raise ValueError("Invalid display")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                   "XDG_RUNTIME_DIR": runtime, "WAYLAND_DISPLAY": display}
    identities = (directory.st_dev, directory.st_ino, socket.st_dev, socket.st_ino)
    return environment, identities


def _provider_identity():
    """Qualify the fixed nonprivileged package file without invoking a provider."""
    path = "/usr/bin/grim"
    if os.path.realpath(path) != path:
        raise ValueError("Invalid provider")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        named = os.stat(path, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o6022
                or not info.st_mode & 0o111
                or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise ValueError("Invalid provider")
        try:
            os.getxattr(fd, "security.capability")
        except OSError as error:
            if error.errno not in (errno.ENODATA, errno.ENOTSUP):
                raise
        else:
            raise ValueError("Privileged provider")
        return (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    finally:
        os.close(fd)


def main(argv=None):
    try:
        if sys.platform != "linux":
            return FAILURE
        arguments = sys.argv[1:] if argv is None else argv
        if (type(arguments) not in (list, tuple) or len(arguments) != 2
                or any(type(value) is not str for value in arguments)
                or not re.fullmatch(r"[1-9][0-9]{0,9}", arguments[0])
                or not re.fullmatch(r"[0-9a-f]{1,16}", arguments[1])):
            return FAILURE
        parent, stable = int(arguments[0]), arguments[1]
        if not 1 < parent <= 2147483647 or os.getppid() != parent:
            return FAILURE
        libc = ctypes.CDLL(None, use_errno=True)
        prctl = libc.prctl
        prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        prctl.restype = ctypes.c_int
        if prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
            return FAILURE
        environment, identities = _environment()
        provider_identity = _provider_identity()
        # KILL and STOP cannot be masked on Linux; explicitly remove ALRM
        # from an inherited mask as well, so the bootstrap alarm remains real.
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGALRM, signal.SIGKILL, signal.SIGSTOP})
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.alarm(5)
        # ALRM cannot terminate a SIGSTOPped child until it resumes. Durable
        # pre-spawn debt and separately owned stopped-child cleanup remain required.
        # Only this bootstrap stops itself. Parent must enroll the retained stopped
        # child in its owned scope before resuming it. No provider has run yet.
        os.kill(os.getpid(), signal.SIGSTOP)
        if os.getppid() != parent or _environment() != (environment, identities):
            return FAILURE
        # Do not clear PR_SET_PDEATHSIG or the alarm. Both survive normal grim
        # exec; parent death must not leave an orphan capture provider running.
        if _provider_identity() != provider_identity:
            return FAILURE
        # Metadata is checked immediately before fixed-path exec. Concurrent
        # same-UID/root package replacement is not an isolated security domain.
        os.execve("/usr/bin/grim", ["/usr/bin/grim", "-T", stable, "-"], environment)
        return FAILURE  # A real successful exec cannot return.
    except (OSError, ValueError, TypeError, OverflowError):
        return FAILURE


if __name__ == "__main__":
    raise SystemExit(main())
