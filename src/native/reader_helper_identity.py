"""Dormant identity pin for one fixed root-installed reader helper.

The caller must obtain the digest from a protected, trusted owner manifest. This
module does not authenticate its origin. No path, UID, executable or digest from
an untrusted request may authorize this module.
The pin does not execute anything, qualify a supervisor, establish static ELF or
validate its dynamic loader/libraries. Root, privileged mount changes and an
attacker able to mutate the trusted filesystem during checks are outside this
capability. ACL and file capabilities must be absent and xattr support proven.
File metadata and digests are snapshots, not immutable filesystem guarantees.
The 16 MiB byte bound is not an elapsed-time bound on filesystem syscalls.
This trusted in-process module is not an isolation boundary: Python callers can
invoke private functions or construct objects, so no returned object alone is
authentication, a capability grant, or proof of an installed runtime.
"""
import errno
import fcntl
import hashlib
import hmac
import os
import stat
import sys
import threading


_PATH = ("usr", "libexec", "sbar-orbit", "reader-helper")
_MAX_BYTES = 16 * 1024 * 1024
_CHUNK = 64 * 1024


class ReaderHelperIdentityError(RuntimeError):
    def __init__(self):
        self.code = "UNKNOWN"
        super().__init__("Reader helper identity unavailable")


def _fail():
    raise ReaderHelperIdentityError() from None


def _snapshot(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _no_xattr(fd, name):
    try:
        os.getxattr(fd, name)
    except OSError as error:
        if error.errno == errno.ENODATA:
            return
        _fail()
    _fail()


def _directory(fd, uid):
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o7022
            or os.get_inheritable(fd)):
        _fail()
    _no_xattr(fd, "system.posix_acl_access")
    _no_xattr(fd, "system.posix_acl_default")
    return _snapshot(info)


def _regular(fd, uid):
    info = os.fstat(fd)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o7022
            or not info.st_mode & 0o111 or info.st_nlink != 1
            or not 4 <= info.st_size <= _MAX_BYTES or flags & os.O_ACCMODE != os.O_RDONLY
            or os.get_inheritable(fd)):
        _fail()
    _no_xattr(fd, "system.posix_acl_access")
    _no_xattr(fd, "security.capability")
    return _snapshot(info)


def _digest(fd, size):
    digest = hashlib.sha256()
    total = 0
    first = bytearray()
    while total < size:
        block = os.pread(fd, min(_CHUNK, size - total), total)
        if not block:
            _fail()
        if len(first) < 4:
            first.extend(block[:4 - len(first)])
        total += len(block)
        if total > size:
            _fail()
        digest.update(block)
    if first != b"\x7fELF" or os.pread(fd, 1, size):
        _fail()
    return digest.digest()


def _named(parent, name, snapshot):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if _snapshot(info) != snapshot:
        _fail()


def _walk(root_fd, uid, expected):
    directories = []
    file_fd = None
    try:
        root_copy = fcntl.fcntl(root_fd, fcntl.F_DUPFD_CLOEXEC, 3)
        directories.append(root_copy)
        snapshots = [_directory(root_copy, uid)]
        for part in _PATH[:-1]:
            parent = directories[-1]
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=parent)
            directories.append(child)
            snapshot = _directory(child, uid)
            _named(parent, part, snapshot)
            snapshots.append(snapshot)
        file_fd = os.open(_PATH[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                          dir_fd=directories[-1])
        before = _regular(file_fd, uid)
        _named(directories[-1], _PATH[-1], before)
        digest = _digest(file_fd, before[6])
        after = _regular(file_fd, uid)
        if after != before or not hmac.compare_digest(digest, expected):
            _fail()
        _named(directories[-1], _PATH[-1], before)
        for i, part in enumerate(_PATH[:-1]):
            if _directory(directories[i + 1], uid) != snapshots[i + 1]:
                _fail()
            _named(directories[i], part, snapshots[i + 1])
        if _directory(directories[0], uid) != snapshots[0]:
            _fail()
        pin = _PinnedReaderHelper(file_fd, directories, snapshots, before, expected, uid)
        file_fd = None
        directories = []
        return pin
    except BaseException:
        failed = True
    else:
        failed = False
    finally:
        for fd in ([file_fd] if file_fd is not None else []) + list(reversed(directories)):
            try:
                os.close(fd)
            except BaseException:
                failed = True
    if failed:
        _fail()


class _PinnedReaderHelper:
    """Single owner pin; no fd transfer or launch method is exposed.

    Trusted code must never directly close, duplicate, mutate, or reuse the
    private descriptors. Python privacy is convention, not isolation. Fork while
    a pin is live is prohibited; child methods reject inherited ownership.
    Filesystem checks are not a root-adversary fence.
    """
    __slots__ = ("_fd", "_directories", "_snapshots", "_file_snapshot", "_expected", "_uid", "_pid", "_closed", "_close_failed", "_lock")

    def __init__(self, fd, directories, snapshots, file_snapshot, expected, uid):
        self._fd = fd
        self._directories = directories
        self._snapshots = snapshots
        self._file_snapshot = file_snapshot
        self._expected = expected
        self._uid = uid
        self._pid = os.getpid()
        self._closed = False
        self._close_failed = False
        self._lock = threading.RLock()

    def revalidate(self):
        if os.getpid() != self._pid:
            _fail()
        with self._lock:
            if self._closed:
                _fail()
            try:
                if _directory(self._directories[0], self._uid) != self._snapshots[0]:
                    _fail()
                # Pin and compare every current ancestor from the original root.
                for i, part in enumerate(_PATH[:-1]):
                    if _directory(self._directories[i + 1], self._uid) != self._snapshots[i + 1]:
                        _fail()
                    _named(self._directories[i], part, self._snapshots[i + 1])
                before = _regular(self._fd, self._uid)
                if before != self._file_snapshot:
                    _fail()
                _named(self._directories[-1], _PATH[-1], before)
                digest = _digest(self._fd, before[6])
                if (_regular(self._fd, self._uid) != before
                        or not hmac.compare_digest(digest, self._expected)):
                    _fail()
                _named(self._directories[-1], _PATH[-1], before)
                for i, part in enumerate(_PATH[:-1]):
                    if _directory(self._directories[i + 1], self._uid) != self._snapshots[i + 1]:
                        _fail()
                    _named(self._directories[i], part, self._snapshots[i + 1])
                if _directory(self._directories[0], self._uid) != self._snapshots[0]:
                    _fail()
            except BaseException:
                failed = True
            else:
                failed = False
            if failed:
                _fail()
            return None

    def close(self):
        if os.getpid() != self._pid:
            _fail()
        with self._lock:
            if self._closed:
                if self._close_failed:
                    _fail()
                return
            self._closed = True
            failed = False
            for fd in [self._fd, *reversed(self._directories)]:
                try:
                    os.close(fd)
                except BaseException:
                    failed = True
            if failed:
                self._close_failed = True
                _fail()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def open_reader_helper(*, expected_sha256):
    """Pin the sole fixed installed helper, using a trusted owner digest."""
    if sys.platform != "linux" or type(expected_sha256) is not bytes or len(expected_sha256) != 32:
        _fail()
    root = None
    pin = None
    try:
        root = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        pin = _walk(root, 0, expected_sha256)
    except BaseException:
        failed = True
    else:
        failed = False
    if root is not None:
        try:
            os.close(root)
        except BaseException:
            failed = True
    if failed:
        if pin is not None:
            try:
                pin.close()
            except BaseException:
                pass
        _fail()
    return pin
