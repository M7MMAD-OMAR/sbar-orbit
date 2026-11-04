"""Dormant Linux peer qualification for a caller-owned Unix listener.

SO_PEERCRED is the connection creator, not necessarily the current writer:
connected descriptors may be passed or duplicated. Same UID is not a security
boundary against another process of that UID. Path checks are samples, not
continuous stability: rename-and-restore ABA is undetectable. The caller must
control the private directory and exclude hostile same-UID mutation. This does
not grant a conversation identity or protect irreversible callback effects. Callbacks must stage results,
not deliver them, until the post-check has succeeded. No production route uses
this module. The owner must not fork while a peer is live, or directly close
its private descriptors; inherited descriptors are not closed by this adapter
in a forked child and remain open there until process exit or exec. Run/close
serialize per peer. Deadlines are cooperative around filesystem and callbacks.
"""
from dataclasses import dataclass
import errno
import math
import os
import platform
import select
import selectors
import socket
import stat
import struct
import sys
import threading
import time


class ReadPeerError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__("Peer qualification failed (" + code + ")")


_CODES = frozenset({"INVALID", "UNKNOWN", "IDENTITY", "PEER_GONE", "UNSUPPORTED",
                    "CANCELLED", "DEADLINE", "BUSY"})


def _safe_code(code):
    return code if type(code) is str and code in _CODES else "UNKNOWN"


def _fail(code):
    raise ReadPeerError(_safe_code(code)) from None


@dataclass(frozen=True)
class PeerIdentity:
    pid: int
    uid: int
    gid: int
    start: int


def _check(deadline, cancel):
    if cancel is not None and cancel.is_set():
        _fail("CANCELLED")
    if time.monotonic() >= deadline:
        _fail("DEADLINE")


def _file(fd, cap=65536):
    data = bytearray()
    while len(data) <= cap:
        chunk = os.read(fd, min(4096, cap + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    if len(data) > cap:
        _fail("UNKNOWN")
    return bytes(data)


def _read_proc(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        return _file(fd)
    finally:
        os.close(fd)


def _proc(pid):
    data = _read_proc(f"/proc/{pid}/stat")
    try:
        head, tail = data.rsplit(b")", 1)
        if int(head.split(b" ", 1)[0]) != pid:
            _fail("UNKNOWN")
        fields = tail.split()
        state = fields[0]
        start = int(fields[19])
        if state in (b"Z", b"X", b"x") or start <= 0:
            _fail("PEER_GONE")
        return start
    except (ValueError, IndexError):
        _fail("UNKNOWN")


def _pidfd_live(fd, pid):
    # fdinfo is rendered in this procfs mount's PID namespace. Require the
    # singleton NSpid form; nested namespaces or kernels omitting it are refused
    # even when otherwise valid. Ambiguous mappings are not authority.
    data = _read_proc(f"/proc/self/fdinfo/{fd}")
    try:
        fields = {}
        for line in data.splitlines():
            key, sep, value = line.partition(b":")
            if sep and key in (b"Pid", b"NSpid"):
                if key in fields:
                    _fail("UNKNOWN")
                fields[key] = value.split()
        if (fields.get(b"Pid") != [str(pid).encode("ascii")]
                or fields.get(b"NSpid") != [str(pid).encode("ascii")]):
            _fail("UNKNOWN")
    except (ValueError, TypeError):
        _fail("UNKNOWN")
    poll = select.poll()
    poll.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    if poll.poll(0):
        _fail("PEER_GONE")


def _credential(connection):
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    if len(raw) != struct.calcsize("3i"):
        _fail("UNKNOWN")
    pid, uid, gid = struct.unpack("3i", raw)
    if pid <= 0 or pid == os.getpid() or uid != os.getuid() or gid < 0:
        _fail("IDENTITY")
    return pid, uid, gid


def _socket_id(sock):
    info = os.fstat(sock.fileno())
    if not stat.S_ISSOCK(info.st_mode):
        _fail("IDENTITY")
    return info.st_dev, info.st_ino


def _listener_pin(listener):
    if (type(listener) is not socket.socket or listener.family != socket.AF_UNIX
            or listener.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX
            or listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
            or listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1
            or os.get_blocking(listener.fileno())):
        _fail("INVALID")
    path = listener.getsockname()
    if (type(path) is not str or not path.startswith("/") or "\0" in path
            or os.path.realpath(path) != path):
        _fail("INVALID")
    parent, name = os.path.split(path)
    if not parent or not name or name in (".", ".."):
        _fail("INVALID")
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(directory)
        named_parent = os.stat(parent, follow_symlinks=False)
        entry_fd = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            entry = os.fstat(entry_fd)
            named_entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                    or (info.st_dev, info.st_ino) != (named_parent.st_dev, named_parent.st_ino)
                    or not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid()
                    or entry.st_mode & 0o077
                    or (entry.st_dev, entry.st_ino) != (named_entry.st_dev, named_entry.st_ino)):
                _fail("IDENTITY")
            result = (path, _socket_id(listener), (info.st_dev, info.st_ino), (entry.st_dev, entry.st_ino))
            return result, directory, entry_fd
        except BaseException as error:
            code = _safe_code(error.code) if type(error) is ReadPeerError else "UNKNOWN"
            try:
                os.close(entry_fd)
            except BaseException:
                code = "UNKNOWN"
            _fail(code)
    except BaseException as error:
        code = _safe_code(error.code) if type(error) is ReadPeerError else "UNKNOWN"
        try:
            os.close(directory)
        except BaseException:
            code = "UNKNOWN"
    _fail(code)


def _listener_state(listener):
    state, directory, entry = _listener_pin(listener)
    failed = False
    for fd in (entry, directory):
        try:
            os.close(fd)
        except BaseException:
            failed = True
    if failed:
        _fail("UNKNOWN")
    return state


def _peerpidfd_option():
    option = getattr(socket, "SO_PEERPIDFD", None)
    if option is not None:
        return option
    # This checkout's x86_64 Linux UAPI defines 77; do not guess elsewhere.
    if platform.machine() == "x86_64":
        return 77
    _fail("UNSUPPORTED")


class OwnedPeer:
    """One accepted peer. Caller owns listener; this owns only connection/pidfd."""
    def __init__(self, connection, pidfd, identity, socket_id, listener, listener_state,
                 directory, entry, deadline, cancel):
        self._connection = connection
        self._pidfd = pidfd
        self._identity = identity
        self._socket_id = socket_id
        self._listener = listener
        self._listener_state = listener_state
        self._directory = directory
        self._entry = entry
        self._deadline = deadline
        self._cancel = cancel
        self._used = False
        self._closed = False
        self._owner_pid = os.getpid()
        self._lock = threading.RLock()
        self._running = False

    def _verify(self):
        _check(self._deadline, self._cancel)
        if self._closed or os.getpid() != self._owner_pid:
            _fail("IDENTITY")
        if _listener_state(self._listener) != self._listener_state:
            _fail("IDENTITY")
        conn = self._connection
        if (_socket_id(conn) != self._socket_id
                or conn.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX
                or conn.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                or conn.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0):
            _fail("IDENTITY")
        conn.getpeername()
        if _credential(conn) != (self._identity.pid, self._identity.uid, self._identity.gid):
            _fail("IDENTITY")
        _pidfd_live(self._pidfd, self._identity.pid)
        if _proc(self._identity.pid) != self._identity.start:
            _fail("IDENTITY")
        _pidfd_live(self._pidfd, self._identity.pid)
        if _listener_state(self._listener) != self._listener_state:
            _fail("IDENTITY")
        _check(self._deadline, self._cancel)

    def run(self, callback):
        if os.getpid() != self._owner_pid:
            _fail("IDENTITY")
        with self._lock:
            if self._used or not callable(callback):
                _fail("INVALID")
            self._used = True
            self._running = True
            try:
                self._verify()
                try:
                    result = callback(self._identity)
                except BaseException:
                    callback_failed = True
                else:
                    callback_failed = False
                if callback_failed:
                    _fail("UNKNOWN")
                self._verify()
                return result
            except BaseException as error:
                # Retain only fixed codes, never an exception or traceback.
                code = _safe_code(error.code) if type(error) is ReadPeerError else "UNKNOWN"
            finally:
                self._running = False
            _fail(code)

    def close(self):
        # Check before acquiring a possibly inherited lock after fork.
        if os.getpid() != self._owner_pid:
            _fail("IDENTITY")
        with self._lock:
            if self._running:
                _fail("BUSY")
            if self._closed:
                return
            self._closed = True
            failed = False
            try:
                self._connection.close()
            except BaseException:
                failed = True
            for fd in (self._pidfd, self._entry, self._directory):
                try:
                    os.close(fd)
                except BaseException:
                    failed = True
            if failed:
                _fail("UNKNOWN")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def accept_owned_peer(listener, *, deadline, cancel=None):
    """Accept and qualify one connection on a trusted, private listener.

    Listener remains caller-owned and nonblocking. The caller must own its
    creation and binding: pathname metadata alone cannot prove the listener
    actually bound that filesystem inode. No message metadata participates.
    SO_PEERPIDFD is mandatory; unsupported kernels refuse.
    """
    try:
        valid_deadline = type(deadline) in (int, float) and math.isfinite(deadline)
    except (OverflowError, ValueError):
        valid_deadline = False
    now = time.monotonic()
    if (sys.platform != "linux" or not valid_deadline or deadline <= now or deadline - now > 3
            or cancel is not None and not isinstance(cancel, threading.Event)):
        _fail("INVALID")
    connection = None
    pidfd = None
    selector = None
    directory = None
    entry = None
    peer = None
    code = None
    try:
        _check(deadline, cancel)
        original, directory, entry = _listener_pin(listener)
        selector = selectors.DefaultSelector()
        selector.register(listener, selectors.EVENT_READ)
        while True:
            _check(deadline, cancel)
            if not selector.select(min(0.05, max(0, deadline - time.monotonic()))):
                continue
            _check(deadline, cancel)
            try:
                connection, _ = listener.accept()
                break
            except BlockingIOError:
                continue
        if _listener_state(listener) != original:
            _fail("IDENTITY")
        if (connection.family != socket.AF_UNIX
                or connection.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX
                or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                or connection.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0):
            _fail("IDENTITY")
        connection.getpeername()
        socket_id = _socket_id(connection)
        credentials = _credential(connection)
        try:
            pidfd = connection.getsockopt(socket.SOL_SOCKET, _peerpidfd_option())
        except OSError as error:
            if error.errno in (errno.ENOPROTOOPT, errno.EOPNOTSUPP):
                code = "UNSUPPORTED"
            elif error.errno in (errno.ENODATA, errno.ESRCH):
                code = "PEER_GONE"
            else:
                code = "UNKNOWN"
            _fail(code)
        if type(pidfd) is not int or pidfd < 0:
            _fail("UNKNOWN")
        os.set_inheritable(pidfd, False)
        if os.get_inheritable(pidfd):
            _fail("UNKNOWN")
        _pidfd_live(pidfd, credentials[0])
        start = _proc(credentials[0])
        _pidfd_live(pidfd, credentials[0])
        if _proc(credentials[0]) != start or _credential(connection) != credentials:
            _fail("IDENTITY")
        _check(deadline, cancel)
        if _listener_state(listener) != original or _socket_id(connection) != socket_id:
            _fail("IDENTITY")
        peer = OwnedPeer(connection, pidfd, PeerIdentity(*credentials, start), socket_id,
                         listener, original, directory, entry, deadline, cancel)
    except BaseException as error:
        code = _safe_code(error.code) if type(error) is ReadPeerError else "UNKNOWN"
    # Close all temporary resources independently. A cleanup failure always
    # prevents transferring the peer and overrides any primary result.
    cleanup_failed = False
    if selector is not None:
        try:
            selector.close()
        except BaseException:
            cleanup_failed = True
    if code is not None or cleanup_failed:
        if connection is not None:
            try:
                connection.close()
            except BaseException:
                cleanup_failed = True
        for fd in (pidfd, entry, directory):
            if fd is not None and type(fd) is int and fd >= 0:
                try:
                    os.close(fd)
                except BaseException:
                    cleanup_failed = True
        if cleanup_failed:
            _fail("UNKNOWN")
        _fail(code)
    return peer
