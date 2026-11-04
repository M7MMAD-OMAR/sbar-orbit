"""Linux one-shot client for read_channel_server's fixed, NON-AUTHORIZING hello.

Trusted parent supplies canonical private root, basename and exact expected server
PeerIdentity from its retained process/birth evidence, never env or request labels.
SO_PEERPIDFD is mandatory: no fallback to a numeric PID or message credentials.
Kernel credentials identify the connection creator, not every writer of passed FDs.
The owner must exclude FD passing/fork and hostile same-UID filesystem mutation,
and keep standard descriptors 0/1/2 open without concurrent FD-table mutation.
Path/inode checks are samples; rename-and-restore ABA is not detectable here.

The same owner lock protects all guard generation/revocation changes. guard returns
an opaque object epoch (never reused), or None. It is synchronous, non-reentrant and
side-effect-free. The lock is never held while awaiting connect/ACK bytes; final
checks and the tiny hello send hold it. Filesystem/proc/syscalls may block beyond the
cooperative deadline; there is no bounded off-latency claim. Success linearizes at
the final locked generation check. Revocation can occur after that check and even
before this function returns. True is only a complete fixed ACK on this connection, not a
read grant, durable permission, DSH conversation identity, data drain or production
broker capability. No subprocess, secret, retry, app action or configuration here.
"""
import errno
import math
import os
import re
import select
import socket
import stat
import sys
import threading
import time

from . import read_peer as peer

_HELLO = b'\x00\x00\x00\x14{"v":1,"op":"hello"}'
_ACK = b'\x00\x00\x00\x11{"v":1,"ok":true}'
_CODES = frozenset({"INVALID", "UNKNOWN", "IDENTITY", "UNSUPPORTED", "PEER_GONE", "CANCELLED", "DEADLINE"})


class ReadChannelClientError(RuntimeError):
    def __init__(self, code="UNKNOWN"):
        self.code = code if type(code) is str and code in _CODES else "UNKNOWN"
        super().__init__("Read channel client refused (" + self.code + ")")


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _fail(code="UNKNOWN"):
    raise ReadChannelClientError(code)


def _pin(info):
    return info.st_dev, info.st_ino


def _trusted_directory(info, leaf=False):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & (0o022 | 0o7000)
            or leaf and (info.st_uid != os.getuid() or info.st_mode & 0o7777 != 0o700)):
        _fail("IDENTITY")


def _open_root_chain(root):
    descriptors, chain, failed = [], [], False
    try:
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        descriptors.append(fd)
        info = os.fstat(fd)
        _trusted_directory(info, root == "/")
        chain.append((fd, _pin(info), "/", root == "/"))
        parts = root.strip("/").split("/") if root != "/" else []
        prefix = ""
        for index, part in enumerate(parts):
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=descriptors[-1])
            descriptors.append(fd)
            info = os.fstat(fd)
            leaf = index == len(parts) - 1
            _trusted_directory(info, leaf)
            prefix += "/" + part
            chain.append((fd, _pin(info), prefix, leaf))
    except BaseException:
        failed = True
    if failed:
        for fd in reversed(descriptors):
            try:
                os.close(fd)
            except BaseException:
                pass
        raise ReadChannelClientError("IDENTITY")
    return chain


def _hello_once(root, name, expected_server, *, deadline, authority_lock, guard, cancel=None):
    """Use one owned nonblocking connection; accept exact fixed ACK AND writer EOF.

    All paths/fds remain private to this invocation. The caller supplies protected
    root and expected connection-creator identity, not arbitrary model selections.
    Cleanup of every acquired resource is attempted independently; any uncertainty
    suppresses success. No raw path, bytes, nonce, or OS exception is returned.
    """
    if (sys.platform != "linux" or type(root) is not str or not root.startswith("/") or "\0" in root
            or os.path.normpath(root) != root or os.path.realpath(root) != root
            or type(name) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) is None
            or type(expected_server) is not peer.PeerIdentity
            or any(type(value) is not int for value in (expected_server.pid, expected_server.uid, expected_server.gid, expected_server.start))
            or expected_server.pid <= 0 or expected_server.pid == os.getpid() or expected_server.start <= 0
            or expected_server.uid != os.getuid() or expected_server.gid < 0
            or not _finite(deadline) or type(authority_lock) is not type(threading.Lock()) or not callable(guard)
            or cancel is not None and type(cancel) is not threading.Event):
        raise ReadChannelClientError("INVALID")
    path = os.path.join(root, name)
    if len(os.fsencode(path)) > 107:
        raise ReadChannelClientError("INVALID")
    # Keep stdio occupied throughout: every newly owned kernel descriptor must be >=3.
    for standard in (0, 1, 2):
        os.fstat(standard)
    connection, directory, entry, pidfd = None, None, None, None
    root_chain = []
    root_pin = entry_pin = connection_pin = credentials = None
    initial_epoch = None
    last = None
    code, succeeded = None, False

    def check():
        nonlocal last
        current = time.monotonic()
        if (not _finite(current) or last is not None and current < last
                or current >= deadline or last is None and deadline - current > 3.0):
            _fail("DEADLINE")
        last = current
        if cancel is not None and threading.Event.is_set(cancel):
            _fail("CANCELLED")
        return deadline - current

    def endpoint():
        for ancestor, identity, named_path, leaf in root_chain:
            checked = os.fstat(ancestor)
            named = os.stat(named_path, follow_symlinks=False)
            _trusted_directory(checked, leaf)
            if _pin(checked) != identity or _pin(named) != identity:
                _fail("IDENTITY")
        info, item = os.fstat(directory), os.fstat(entry)
        named_root = os.stat(root, follow_symlinks=False)
        named_entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o7777 != 0o700
                or _pin(info) != root_pin or _pin(named_root) != root_pin or os.path.realpath(root) != root
                or not stat.S_ISSOCK(item.st_mode) or item.st_uid != os.getuid() or item.st_mode & 0o7777 != 0o600
                or item.st_nlink != 1 or _pin(item) != entry_pin or _pin(named_entry) != entry_pin
                or named_entry.st_uid != item.st_uid or named_entry.st_mode != item.st_mode or named_entry.st_nlink != 1):
            _fail("IDENTITY")

    def verify_server():
        check()
        endpoint()
        if connection is not None and connection_pin is not None:
            if (peer._socket_id(connection) != connection_pin or connection.family != socket.AF_UNIX
                    or connection.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX
                    or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                    or connection.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0):
                _fail("IDENTITY")
        if pidfd is not None:
            peer._pidfd_live(pidfd, expected_server.pid)
            if (peer._credential(connection) != credentials or peer._proc(expected_server.pid) != expected_server.start):
                _fail("IDENTITY")
            peer._pidfd_live(pidfd, expected_server.pid)
        check()

    def epoch():
        value = guard()
        if type(value) is not object or initial_epoch is not None and value is not initial_epoch:
            _fail("IDENTITY")
        check()
        return value

    def acquire():
        while not authority_lock.acquire(timeout=min(.05, check())):
            check()

    try:
        check()
        initial_epoch = epoch()
        root_chain = _open_root_chain(root)
        directory, root_pin, _, _ = root_chain[-1]
        entry = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        entry_pin = _pin(os.fstat(entry))
        endpoint()
        check()
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_NONBLOCK | socket.SOCK_CLOEXEC)
        connection_pin = peer._socket_id(connection)
        result = connection.connect_ex(path)
        if result not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR):
            _fail("UNKNOWN")
        if result != 0:
            while True:
                verify_server()
                _, writable, _ = select.select([], [connection], [], min(.05, check()))
                check()
                if writable:
                    if connection.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) != 0:
                        _fail("UNKNOWN")
                    break
        connection.getpeername()
        verify_server()
        credentials = peer._credential(connection)
        if credentials != (expected_server.pid, expected_server.uid, expected_server.gid):
            _fail("IDENTITY")
        try:
            candidate_pidfd = connection.getsockopt(socket.SOL_SOCKET, peer._peerpidfd_option())
        except OSError as error:
            code = "UNSUPPORTED" if error.errno in (errno.ENOPROTOOPT, errno.EOPNOTSUPP) else "PEER_GONE" if error.errno in (errno.ENODATA, errno.ESRCH) else "UNKNOWN"
            raise ReadChannelClientError(code)
        if type(candidate_pidfd) is not int or candidate_pidfd < 3:
            _fail("UNKNOWN")  # Never claim/close an anomalous unowned numeric value.
        pidfd = candidate_pidfd
        os.set_inheritable(pidfd, False)
        if os.get_inheritable(pidfd):
            _fail("UNKNOWN")
        verify_server()
        epoch()
        acquire()
        try:
            verify_server()
            epoch()
            verify_server()
            # One tiny nonblocking send, never resend partial/uncertain acceptance.
            if connection.send(_HELLO, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL) != len(_HELLO):
                _fail("UNKNOWN")
            check()
            connection.shutdown(socket.SHUT_WR)
        finally:
            authority_lock.release()
        data = bytearray()
        while True:
            verify_server()
            epoch()
            ready, _, _ = select.select([connection], [], [], min(.05, check()))
            check()
            if not ready:
                continue
            try:
                chunk = connection.recv(len(_ACK) - len(data) + 1, socket.MSG_DONTWAIT)
            except BlockingIOError:
                continue
            verify_server()
            if not chunk:
                break
            if len(chunk) > len(_ACK) - len(data):
                _fail("UNKNOWN")
            data.extend(chunk)
        if bytes(data) != _ACK:
            _fail("UNKNOWN")
        acquire()
        try:
            verify_server()
            epoch()
            verify_server()
            succeeded = True
        finally:
            authority_lock.release()
    except BaseException as error:
        code = error.code if type(error) in (ReadChannelClientError, peer.ReadPeerError) and error.code in _CODES else "UNKNOWN"
    # Do not retain any raw exception context while raising the public error.
    cleanup_failed = False
    if connection is not None:
        try:
            connection.close()
        except BaseException:
            cleanup_failed = True
    for fd in ([entry] if entry is not None else []) + [item[0] for item in reversed(root_chain)]:
        if fd is not None:
            try:
                os.close(fd)
            except BaseException:
                cleanup_failed = True
    if cleanup_failed:
        code, succeeded = "UNKNOWN", False
    if succeeded:
        try:
            check()
            acquire()
            try:
                peer._pidfd_live(pidfd, expected_server.pid)
                if peer._proc(expected_server.pid) != expected_server.start:
                    _fail("IDENTITY")
                peer._pidfd_live(pidfd, expected_server.pid)
                epoch()
                check()
            finally:
                authority_lock.release()
        except BaseException as error:
            succeeded = False
            code = error.code if type(error) in (ReadChannelClientError, peer.ReadPeerError) and error.code in _CODES else "UNKNOWN"
    if pidfd is not None:
        try:
            os.close(pidfd)
        except BaseException as error:
            succeeded = False
            code = error.code if type(error) in (ReadChannelClientError, peer.ReadPeerError) and error.code in _CODES else "UNKNOWN"
    if succeeded:
        try:
            check()
        except BaseException as error:
            succeeded = False
            code = error.code if type(error) in (ReadChannelClientError, peer.ReadPeerError) and error.code in _CODES else "UNKNOWN"
    if not succeeded:
        raise ReadChannelClientError(code or "UNKNOWN")
    return True


def hello_once(root, name, expected_server, *, deadline, authority_lock, guard, cancel=None):
    """Normalize local failures; Python may still attach caller ambient __context__."""
    failed, code = False, "UNKNOWN"
    try:
        result = _hello_once(root, name, expected_server, deadline=deadline,
                             authority_lock=authority_lock, guard=guard, cancel=cancel)
    except BaseException as error:
        failed = True
        if type(error) is ReadChannelClientError and error.code in _CODES:
            code = error.code
    if failed:
        raise ReadChannelClientError(code) from None
    return result
