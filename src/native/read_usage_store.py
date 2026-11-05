"""Private Linux dirfd store. Dormant: no imports from production or CLI entrypoint.

The owner supplies a dedicated existing root and <=4 opaque object/key mappings.
Records are reconciliation evidence, NEVER restored enablement or acknowledgements.
Fresh coordinator instances must invalidate old Sessions/grants. Same-UID hostile
writers, mount changes and filesystem power-loss behavior require separate scope.
All filesystem calls are synchronous; timeout does not cancel a blocked syscall.
The owner must keep the root/ancestors stable during operations: a rename after
validation can leave writes in the original pinned directory before refusal,
never authorize a replacement path. Expected-root caller FDs must remain
exclusively owned until duplication completes; same-inode OFD ABA is not proven
by inode samples. After duplication the caller may close/reuse its original.
Store-owned private descriptors must not be externally closed or replaced;
violating that trusted in-process ownership can make numeric FD cleanup unsafe.
"""
import json
import os
import re
import stat
import sys
import threading
from functools import wraps
from types import MappingProxyType
try:
    import fcntl
except ImportError:
    fcntl = None


class ReadUsageStoreError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__("Private read usage storage refused")


def _fail(code="UNCONFIRMED"):
    raise ReadUsageStoreError(code) from None


def _close_fds(fds):
    failed = False
    for fd in fds:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                failed = True
    return not failed


def _identity(fd):
    info = os.fstat(fd)
    return info.st_dev, info.st_ino


def _directory(info, final=False):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o7022 or info.st_nlink == 0):
        _fail()
    if final and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        _fail()


def _chain(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    pins = []
    try:
        pins.append(os.open("/", flags))
        _directory(os.fstat(pins[-1]))
        for component in path.split("/")[1:]:
            pins.append(os.open(component, flags, dir_fd=pins[-1]))
            _directory(os.fstat(pins[-1]))
        _directory(os.fstat(pins[-1]), final=True)
        return pins
    except BaseException:
        _close_fds(reversed(pins))
        raise


def _record(value):
    if type(value) is not dict or any(type(key) is not str for key in value) or set(value) != {"instance", "epoch", "enabled"}:
        _fail("INVALID")
    if (type(value["instance"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", value["instance"])
            or type(value["epoch"]) is not int or not 1 <= value["epoch"] <= 9007199254740991
            or type(value["enabled"]) is not bool):
        _fail("INVALID")
    return dict(value)


def _encoded(record):
    return (json.dumps({"schema": 1, **record}, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            _fail()
        result[key] = value
    return result


def _serial(method):
    @wraps(method)
    def call(self, *args, **kwargs):
        acquired = started = False
        failure, result = None, None
        try:
            acquired = self._mutex.acquire(blocking=False)
            if not acquired or self._busy:
                _fail("BUSY")
            self._busy = True
            started = True
            result = method(self, *args, **kwargs)
        except BaseException as error:
            failure = error.code if isinstance(error, ReadUsageStoreError) else "UNCONFIRMED"
        finally:
            if started:
                self._busy = False
            if acquired:
                self._mutex.release()
        # Construct outside our handler so internally caught filesystem errors
        # are not retained as context. Ambient caller-owned exception context
        # may still be attached by Python; this is not universal context erasure.
        if failure is not None:
            raise ReadUsageStoreError(failure) from None
        return result
    return call


class ReadUsageStore:
    MAX_BYTES = 256
    LOCK = ".read-usage.lock"
    SESSION = ".read-usage.session"
    SESSION_BYTES = b"ORB-USAGE-SESSION-1\n"

    def __init__(self, root, entries, *, expected_root_fd=None):
        self._mutex = threading.RLock()
        self._busy = self._closed = self._broken = False
        self._pid = os.getpid()
        self._pins, self._lock = [], None
        self._lock_created = False
        self._session_fd = self._session_identity = None
        self._expected_fd = None
        self._expected_identity = None
        self._entries = []
        if sys.platform != "linux" or fcntl is None or not all(operation in os.supports_dir_fd for operation in (os.open, os.stat, os.rename, os.unlink)):
            _fail("UNSUPPORTED")
        if expected_root_fd is not None and (type(expected_root_fd) is not int or not 3 <= expected_root_fd <= 2147483647):
            _fail("INVALID")
        if expected_root_fd is not None and not hasattr(fcntl, "F_DUPFD_CLOEXEC"):
            _fail("UNSUPPORTED")
        if type(root) is not str:
            _fail("INVALID")
        raw = root
        if (type(raw) is not str or not raw.startswith("/") or len(raw) > 4096 or "\0" in raw
                or len(raw.split("/")) > 65 or any(part in ("", ".", "..") for part in raw.split("/")[1:])):
            _fail("INVALID")
        self._root_path = raw
        if type(entries) is not tuple or not 1 <= len(entries) <= 4:
            _fail("INVALID")
        keys = set()
        for entry in entries:
            if type(entry) is not tuple or len(entry) != 2:
                _fail("INVALID")
            conversation, key = entry
            if (type(conversation) is not object or type(key) is not str or not re.fullmatch(r"[0-9a-f]{64}", key)
                    or key in keys or any(item[0] is conversation for item in self._entries)):
                _fail("INVALID")
            keys.add(key)
            self._entries.append((conversation, key, {"uncertain": False, "instance": None, "epoch": 0}))
        self._allowed = {self.LOCK} | {key + suffix for key in keys for suffix in (".json", ".pending", ".writing")}
        failure = None
        try:
            if expected_root_fd is not None:
                # The caller owns this process-local FD, not a numeric identity
                # transferable through JSON. Pin an independent CLOEXEC duplicate.
                _directory(os.fstat(expected_root_fd), final=True)
                expected = _identity(expected_root_fd)
                duplicate = fcntl.fcntl(expected_root_fd, fcntl.F_DUPFD_CLOEXEC, 3)
                if type(duplicate) is not int or duplicate < 3:
                    _fail()
                self._expected_fd = duplicate
                _directory(os.fstat(self._expected_fd), final=True)
                if _identity(self._expected_fd) != expected or _identity(expected_root_fd) != expected:
                    _fail()
                self._expected_identity = expected
            self._pins = _chain(raw)
            self._identities = tuple(_identity(fd) for fd in self._pins)
            # This comparison precedes namespace scans, lock creation and fsync.
            if self._expected_fd is not None and self._identities[-1] != self._expected_identity:
                _fail()
            self._namespace()
            self._root_guard()  # Recheck the full path/pin binding before the first mutation.
            lock_flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            try:
                self._lock = os.open(self.LOCK, lock_flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=self._pins[-1])
                self._lock_created = True
            except FileExistsError:
                self._lock = os.open(self.LOCK, lock_flags, dir_fd=self._pins[-1])
            self._file(self._lock)
            self._lock_identity = _identity(self._lock)
            try:
                fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                _fail("BUSY")
            os.fsync(self._lock)
            os.fsync(self._pins[-1])
            self._guard()
        except BaseException as error:
            self._closed = True
            cleaned = _close_fds([self._lock, self._expected_fd, *reversed(self._pins)])
            self._lock, self._expected_fd, self._pins = None, None, []
            failure = error.code if cleaned and isinstance(error, ReadUsageStoreError) else "UNCONFIRMED"
        if failure is not None:
            raise ReadUsageStoreError(failure) from None

    def _namespace(self):
        with os.scandir(self._pins[-1]) as entries:
            for count, entry in enumerate(entries):
                if count >= len(self._allowed) or entry.name not in self._allowed:
                    _fail()

    def _file(self, fd):
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_dev != os.fstat(self._pins[-1]).st_dev):
            _fail()

    def _optional(self, name):
        try:
            return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=self._pins[-1])
        except FileNotFoundError:
            return None

    def _named(self, name, expected):
        fd = self._optional(name)
        if fd is None:
            _fail()
        try:
            self._file(fd)
            if _identity(fd) != expected:
                _fail()
        finally:
            if not _close_fds([fd]):
                _fail()

    def _root_guard(self):
        current = []
        try:
            if self._expected_fd is not None:
                _directory(os.fstat(self._expected_fd), final=True)
                if (_identity(self._expected_fd) != self._expected_identity
                        or self._expected_identity != self._identities[-1]):
                    _fail()
            current = _chain(self._root_path)
            if tuple(_identity(fd) for fd in current) != self._identities:
                _fail()
            for index, fd in enumerate(self._pins):
                _directory(os.fstat(fd), final=index == len(self._pins) - 1)
                if _identity(fd) != self._identities[index]:
                    _fail()
        finally:
            if not _close_fds(reversed(current)):
                _fail()

    def _guard(self):
        if self._closed:
            _fail("CLOSED")
        if self._broken or os.getpid() != self._pid:
            _fail()
        try:
            self._root_guard()
            self._named(self.LOCK, self._lock_identity)
            self._namespace()
            if self._session_fd is not None:
                self._file(self._session_fd)
                if _identity(self._session_fd) != self._session_identity:
                    _fail()
                self._named(self.SESSION, self._session_identity)
                if os.pread(self._session_fd, len(self.SESSION_BYTES)+1, 0) != self.SESSION_BYTES:
                    _fail()
        except BaseException:
            self._broken = True
            _fail()

    @_serial
    def _seal_session(self):
        """Service-only, one-shot same-root crash fence, never a freshness proof.

        Owner must provision a genuinely fresh exclusive root and exclude legacy
        writers. Pre-seal crashes/orphans and selection of another root need an
        authoritative registry before production. No boolean/clear/unlink API.
        """
        try:
            self._guard()
            if self._session_fd is not None or not self._lock_created:
                _fail()
            with os.scandir(self._pins[-1]) as entries:
                if any(item.name != self.LOCK for item in entries):
                    _fail()
            self._root_guard()
            self._session_fd = os.open(self.SESSION, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                                       0o600, dir_fd=self._pins[-1])
            self._file(self._session_fd)
            self._session_identity = _identity(self._session_fd)
            self._write(self._session_fd, self.SESSION_BYTES)
            os.fsync(self._session_fd)
            os.fsync(self._pins[-1])
            self._root_guard()
            self._named(self.LOCK, self._lock_identity)
            self._named(self.SESSION, self._session_identity)
            if os.pread(self._session_fd, len(self.SESSION_BYTES)+1, 0) != self.SESSION_BYTES:
                _fail()
            # Only this exact live owner recognizes its retained marker. All new
            # ordinary Store constructors still reject this unknown namespace.
            self._allowed.add(self.SESSION)
            self._guard()
        except BaseException:
            self._broken = True
            _fail()

    def _entry(self, conversation):
        for item, key, state in self._entries:
            if item is conversation:
                if state["uncertain"]:
                    _fail()
                return key, state
        _fail("DENIED")

    def _no_pending(self, key):
        for suffix in (".pending", ".writing"):
            fd = self._optional(key + suffix)
            if fd is not None:
                _close_fds([fd])
                _fail()

    def _read(self, key):
        fd = self._optional(key + ".json")
        if fd is None:
            return None
        try:
            self._file(fd)
            size = os.fstat(fd).st_size
            if not 1 <= size <= self.MAX_BYTES:
                _fail()
            raw = os.read(fd, self.MAX_BYTES + 1)
            if len(raw) != size:
                _fail()
            parsed = json.loads(raw.decode("ascii"), object_pairs_hook=_pairs)
            if type(parsed) is not dict or set(parsed) != {"schema", "instance", "epoch", "enabled"} or type(parsed["schema"]) is not int or parsed["schema"] != 1:
                _fail()
            result = _record({key: value for key, value in parsed.items() if key != "schema"})
            if _encoded(result) != raw:
                _fail()
            self._file(fd)
            return result
        finally:
            if not _close_fds([fd]):
                _fail()

    @staticmethod
    def _write(fd, data):
        while data:
            count = os.write(fd, data)
            if count <= 0:
                _fail()
            data = data[count:]

    @_serial
    def commit(self, conversation, value):
        if self._closed:
            _fail("CLOSED")
        key, state = self._entry(conversation)
        marker = writing = None
        try:
            snapshot = _record(value)
            self._guard()
            self._no_pending(key)
            previous = self._read(key)
            if ((state["instance"] is not None and state["instance"] != snapshot["instance"])
                    or snapshot["epoch"] <= state["epoch"]
                    or (previous is not None and previous["instance"] == snapshot["instance"] and snapshot["epoch"] <= previous["epoch"])):
                _fail()
            encoded = _encoded(snapshot)
            if len(encoded) > self.MAX_BYTES:
                _fail("INVALID")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
            marker_name, writing_name = key + ".pending", key + ".writing"
            marker = os.open(marker_name, flags, 0o600, dir_fd=self._pins[-1])
            self._file(marker)
            marker_identity = _identity(marker)
            self._write(marker, b"pending\n")
            os.fsync(marker)
            os.fsync(self._pins[-1])
            writing = os.open(writing_name, flags, 0o600, dir_fd=self._pins[-1])
            self._file(writing)
            writing_identity = _identity(writing)
            self._write(writing, encoded)
            os.fsync(writing)
            self._guard()
            self._file(marker)
            self._file(writing)
            self._named(marker_name, marker_identity)
            self._named(writing_name, writing_identity)
            self._read(key)
            os.rename(writing_name, key + ".json", src_dir_fd=self._pins[-1], dst_dir_fd=self._pins[-1])
            os.fsync(self._pins[-1])
            self._guard()
            self._named(key + ".json", writing_identity)
            if self._read(key) != snapshot:
                _fail()
            self._file(marker)
            self._named(marker_name, marker_identity)
            # Finish all owned file closes before removing the durable barrier.
            # Never retry close after an uncertain error: its FD may be reused.
            to_close, writing, marker = [writing, marker], None, None
            if not _close_fds(to_close):
                _fail()
            self._guard()
            self._named(marker_name, marker_identity)
            os.unlink(marker_name, dir_fd=self._pins[-1])
            os.fsync(self._pins[-1])
            self._guard()
            state["instance"], state["epoch"] = snapshot["instance"], snapshot["epoch"]
        except BaseException as error:
            state["uncertain"] = True
            if isinstance(error, ReadUsageStoreError) and error.code == "INVALID":
                _fail("INVALID")
            _fail()
        finally:
            # Unknown markers/data are never unlinked or retried as cleanup.
            if not _close_fds([writing, marker]):
                state["uncertain"] = True
                _fail()

    @_serial
    def read_evidence(self, conversation):
        key, state = self._entry(conversation)
        self._guard()
        try:
            self._no_pending(key)
            value = self._read(key)
            self._guard()
            label = "absent" if value is None else "recorded-on" if value["enabled"] else "recorded-off"
        except BaseException:
            state["uncertain"] = True
            label = "unconfirmed"
        # Even a clean durable record cannot prove the previous caller received
        # its acknowledgement. Never restore enablement or old grants from it.
        return MappingProxyType({"enabled": False, "reconciliationRequired": True,
                                 "acknowledgement": "unknown", "state": label})

    @_serial
    def close(self):
        if self._closed:
            return
        self._closed = True
        fds, self._pins = [self._session_fd, self._lock, self._expected_fd, *reversed(self._pins)], []
        self._session_fd = self._session_identity = None
        self._lock = self._expected_fd = None
        if not _close_fds(fds):
            _fail()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
