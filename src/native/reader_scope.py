"""Dormant owned cgroup2 leaf primitive. No spawning, PID signals or parent edits.

Only trusted owner runtime paths belong here, never model-provided resource IDs.
A durable journal is debt until the original leaf is proved empty and retired.
Recovered generations retain broader containment debt even when the original leaf
is empty or no root was recorded. Legacy v1 can have an unrecorded child before
admission; v1/v2 do not prove atomic containment. Historical recovered retirement
is refused on load; uncertainty erased by older checkpoints cannot be reconstructed.
Same-owner numeric admission is separately unqualified/dormant, not production.
This is not an input-quiescence receipt or a 32 MiB logical-buffer/RSS promise.
Python private fields are readable by trusted code, not an isolation boundary.
Only directly returned wait receipts may cross the internal API; callers must
never recover tokens from private attributes or let model data supply them.
"""
import ctypes
from dataclasses import dataclass
import fcntl
import json
import math
import os
import select
import signal
import time
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import uuid
from functools import wraps


class ReaderScopeError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class RootWaitReceipt:
    """Content-free kernel outcome; only exact instance registered by its scope is proof."""
    returncode: int


def _acquire_wait_lock(lock, timeout):
    """Fixed native lock call; private deterministic fault-fixture boundary only."""
    return lock.acquire(timeout=timeout)


def _dup_wait_pidfd(pidfd, pid):
    """Borrowed FD exclusive during this call; own duplicate pins the same kernel pidfd.

    This does NOT prove the original pidfd was acquired atomically with creation.
    No pidfd_open, numeric signal, process poll or fallback is performed here.
    The owner keeps input/stdio descriptors stable during duplication. Python
    asynchronous interruption between os.dup and recording its result remains
    a resource-cleanup limitation, never evidence of process completion.
    """
    owned = None
    failed = False
    try:
        if type(pidfd) is not int or pidfd < 3:
            raise ValueError()
        for standard in (0, 1, 2): os.fstat(standard)
        original = os.fstat(pidfd)
        if os.readlink(f"/proc/self/fd/{pidfd}") != "anon_inode:[pidfd]":
            raise ValueError()
        candidate = os.dup(pidfd)
        if type(candidate) is not int or candidate < 3:
            raise ValueError()
        owned = candidate
        copied = os.fstat(owned)
        if (original.st_dev, original.st_ino) != (copied.st_dev, copied.st_ino):
            raise ValueError()
        os.set_inheritable(owned, False)
        fd = os.open(f"/proc/self/fdinfo/{owned}", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
        if len(raw) > 4096:
            raise ValueError()
        fields = {}
        for line in raw.splitlines():
            key, sep, value = line.partition(b":")
            if sep and key in (b"Pid", b"NSpid"):
                if key in fields: raise ValueError()
                fields[key] = value.split()
        expected = [str(pid).encode("ascii")]
        if fields.get(b"Pid") != expected or fields.get(b"NSpid") != expected:
            raise ValueError()
    except BaseException:
        failed = True
    if failed:
        if owned is not None:
            try: os.close(owned)
            except BaseException: pass
        _fail("UNKNOWN", "Reader wait pidfd identity is unconfirmed")
    return owned


def _fail(code, message):
    raise ReaderScopeError(code, message)


@dataclass(frozen=True)
class ReaderLimits:
    """Helper cgroup ceilings, separate from retained observation buffer credit."""
    memory_bytes: int = 256 * 1024 * 1024
    pids: int = 32
    cpu_quota: int = 100000
    cpu_period: int = 100000

    def __post_init__(self):
        for value, maximum in ((self.memory_bytes, 256 * 1024 * 1024),
                               (self.pids, 32), (self.cpu_quota, 100000)):
            if type(value) is not int or not 1 <= value <= maximum:
                _fail("INVALID", "Reader limits must be positive integers no greater than defaults")
        if type(self.cpu_period) is not int or self.cpu_period != 100000:
            _fail("INVALID", "Reader CPU period must be 100000 microseconds")


def _cgroup2(fd):
    """Check the actual pinned filesystem, not a cgroup-looking directory name."""
    if sys.platform != "linux" or ctypes.sizeof(ctypes.c_long) != 8:
        _fail("UNSUPPORTED", "Reader scopes require 64-bit Linux cgroup2")
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.fstatfs
    call.argtypes = [ctypes.c_int, ctypes.c_void_p]
    call.restype = ctypes.c_int
    # Larger than Linux statfs on supported 64-bit ABIs; only f_type is needed.
    buffer = ctypes.create_string_buffer(256)
    if call(fd, buffer) != 0:
        _fail("UNSUPPORTED", "Cannot verify reader cgroup filesystem")
    if ctypes.c_long.from_buffer(buffer).value != 0x63677270:
        _fail("UNSUPPORTED", "Reader resource root is not cgroup2")


def _identity(fd):
    info = os.fstat(fd)
    return [info.st_dev, info.st_ino]


def _directory(path, private=False):
    """Open every absolute component without following any symlink."""
    raw = os.fspath(path)
    if not isinstance(raw, str) or not raw.startswith("/") or raw == "/" or "\0" in raw:
        _fail("INVALID", "Reader directories must be absolute non-root paths")
    parts = raw.split("/")[1:]
    if any(part in ("", ".", "..") for part in parts):
        _fail("INVALID", "Reader directory path must be canonical")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        forbidden = 0o077 if private else 0o022
        if info.st_uid != os.getuid() or info.st_mode & forbidden:
            _fail("INVALID", "Reader directory ownership or permissions are unsafe")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _proc_identity(pid):
    """Birth identity plus parent/state; absence differs from unreadable metadata."""
    try:
        fd = os.open(f"/proc/{pid}/stat", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        data = os.read(fd, 65537)
    finally:
        os.close(fd)
    if len(data) > 65536:
        _fail("UNKNOWN", "Reader process identity exceeds its bound")
    try:
        fields = data.decode("utf-8").rsplit(")", 1)[1].split()
        return {"pid": pid, "start": int(fields[19]), "parent": int(fields[1]), "state": fields[0]}
    except (ValueError, IndexError, UnicodeError):
        _fail("UNKNOWN", "Reader process identity is unavailable")


def _boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        value = stream.read(65).strip()
    if not re.fullmatch(r"[0-9a-f-]{36}", value):
        _fail("UNKNOWN", "Reader boot identity is unavailable")
    return value


def _birth(process):
    return [process["pid"], process["start"]]


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("DEBT", "Reader journal contains duplicate fields")
        result[key] = value
    return result


def _serialized(method):
    @wraps(method)
    def call(self, *args, **kwargs):
        with self._mutex:
            try:
                return method(self, *args, **kwargs)
            except (OSError, UnicodeError) as error:
                raise ReaderScopeError("UNKNOWN", "Reader kernel or storage state could not be verified") from error
    return call


class ReaderScope:
    """One flock-protected journal and one fresh pinned leaf at a time.

    The stopped bootstrap, resume, root wait and stream handling belong to a
    separate trusted layer. Closing this object never clears unresolved debt.
    """
    MAX_JOURNAL_BYTES = 65536
    _PHASES = {"idle", "intent", "pinned", "prepared", "spawn_intent", "spawn_bound",
               "admitting", "admitted", "killing", "recovery", "retired"}

    def __init__(self, root, journal, *, limits=ReaderLimits(), initialize=False):
        self._mutex = threading.RLock()
        if type(initialize) is not bool:
            _fail("INVALID", "Reader journal initialization must be an explicit boolean")
        if type(limits) is not ReaderLimits:
            _fail("INVALID", "Reader limits must be ReaderLimits")
        self.root = Path(root)
        self.journal = Path(journal)
        self._limits = limits
        self._root_fd = self._journal_dir = self._journal_fd = self._leaf_fd = None
        self._child = None
        self._wait_receipt = self._wait_child = self._wait_birth = self._wait_generation = self._wait_code = None
        self._wait_consumed = False
        self._wait_ready = False
        self._wait_owner = None
        self._wait_poisoned = False
        self._record = None
        self._poisoned = False
        self._closed = False
        self._recovered = False
        self._started = False
        self._pid = os.getpid()
        owner = _proc_identity(self._pid)
        if owner is None:
            _fail("UNKNOWN", "Reader owner birth identity is unavailable")
        self._owner = _birth(owner)
        self._boot = _boot_id()
        try:
            self._root_fd = _directory(os.fspath(root))
            _cgroup2(self._root_fd)
            self._root_identity = _identity(self._root_fd)
            raw_journal = os.fspath(journal)
            if not isinstance(raw_journal, str) or not raw_journal.startswith("/") or Path(raw_journal).name in ("", ".", ".."):
                _fail("INVALID", "Reader journal must be an absolute private file")
            self._journal_dir = _directory(os.fspath(self.journal.parent), private=True)
            self._journal_dir_identity = _identity(self._journal_dir)
            flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            if initialize:
                self._root_no_work()
                try:
                    self._journal_fd = os.open(self.journal.name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=self._journal_dir)
                except FileExistsError:
                    _fail("DEBT", "Explicit reader initialization cannot replace an existing journal")
            else:
                try:
                    self._journal_fd = os.open(self.journal.name, flags, dir_fd=self._journal_dir)
                except FileNotFoundError:
                    _fail("DEBT", "Expected reader journal is missing; initialization is not implicit")
            self._journal_identity = _identity(self._journal_fd)
            self._validate_journal()
            try:
                fcntl.flock(self._journal_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                _fail("BUSY", "Reader journal already has an active owner")
            if initialize:
                self._root_no_work()
                self._record = self._initial_record()
                self._append("idle")
                os.fsync(self._journal_dir)
            else:
                self._record = self._load()
                if self._record["boot"] != self._boot or self._record["root"] != self._root_identity:
                    _fail("DEBT", "Reader journal belongs to an unavailable boot or resource root")
        except BaseException:
            self.close()
            raise

    def _initial_record(self):
        return {"v": 1, "sequence": -1, "phase": "idle", "boot": self._boot,
                "root": self._root_identity, "owner": self._owner, "leaf": None,
                "leaf_identity": None, "process": None, "recovered": False,
                "limits": self._limits_record()}

    @staticmethod
    def _populated(text):
        fields = {}
        for line in text.splitlines():
            parts = line.split()
            if len(parts) != 2 or parts[0] in fields or not parts[1].isdigit():
                _fail("UNKNOWN", "Reader populated state is invalid")
            fields[parts[0]] = int(parts[1])
        if fields.get("populated") not in (0, 1):
            _fail("UNKNOWN", "Reader populated state is unavailable")
        return fields["populated"]

    def _root_no_work(self):
        """Read the trusted root only, never configure or kill this parent."""
        fd = _directory(os.fspath(self.root))
        try:
            _cgroup2(fd)
            if _identity(fd) != self._root_identity or _identity(self._root_fd) != self._root_identity:
                _fail("IDENTITY", "Reader resource root changed")
        finally:
            os.close(fd)
        events = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                         dir_fd=self._root_fd)
        try:
            _cgroup2(events)
            info = os.fstat(events)
            if not stat.S_ISREG(info.st_mode) or info.st_dev != self._root_identity[0]:
                _fail("IDENTITY", "Reader root events identity is invalid")
            data = os.read(events, 65537)
            if len(data) > 65536 or self._populated(data.decode("ascii")) != 0:
                _fail("DEBT", "Reader initialization or checkpoint requires an empty resource root")
        finally:
            os.close(events)
        with os.scandir(self._root_fd) as entries:
            for count, entry in enumerate(entries):
                if count >= 4096:
                    _fail("DEBT", "Reader resource root enumeration exceeds its bound")
                mode = entry.stat(follow_symlinks=False).st_mode
                if stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
                    _fail("DEBT", "Reader resource root contains an existing child or alias")

    @property
    def limits(self):
        return self._limits

    def _limits_record(self):
        return {"memory_bytes": self.limits.memory_bytes, "pids": self.limits.pids,
                "cpu_quota": self.limits.cpu_quota, "cpu_period": self.limits.cpu_period, "swap_bytes": 0}

    def _validate_journal(self):
        info = os.fstat(self._journal_fd)
        named = os.stat(self.journal.name, dir_fd=self._journal_dir, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or [info.st_dev, info.st_ino] != self._journal_identity
                or [named.st_dev, named.st_ino] != self._journal_identity):
            _fail("IDENTITY", "Reader journal was replaced or is unsafe")

    def _load(self):
        size = os.fstat(self._journal_fd).st_size
        if not 0 < size <= self.MAX_JOURNAL_BYTES:
            _fail("DEBT", "Reader journal is empty or exceeds its bound")
        data = os.pread(self._journal_fd, self.MAX_JOURNAL_BYTES + 1, 0)
        if len(data) != size or not data.endswith(b"\n"):
            _fail("DEBT", "Reader journal is incomplete")
        last = None
        keys = {"v", "sequence", "phase", "boot", "root", "owner", "leaf", "leaf_identity", "process", "recovered", "limits"}
        try:
            for sequence, line in enumerate(data.splitlines()):
                record = json.loads(line, object_pairs_hook=_pairs)
                if type(record) is not dict or type(record.get("v")) is not int or record["v"] not in (1, 2):
                    _fail("DEBT", "Reader journal schema is invalid")
                expected_keys = keys if record["v"] == 1 else keys | {"spawn_pending"}
                if (set(record) != expected_keys or type(record["sequence"]) is not int
                        or record["sequence"] != sequence or record["phase"] not in self._PHASES
                        or type(record["recovered"]) is not bool):
                    _fail("DEBT", "Reader journal record is invalid")
                if record["v"] == 2 and (type(record["spawn_pending"]) is not bool
                        or (record["spawn_pending"] and record["process"] is not None)):
                    _fail("DEBT", "Reader journal spawn ownership is invalid")
                for field in ("root", "owner"):
                    if not self._valid_identity(record[field]):
                        _fail("DEBT", "Reader journal identity is invalid")
                for field in ("leaf_identity", "process"):
                    if record[field] is not None and not self._valid_identity(record[field]):
                        _fail("DEBT", "Reader journal identity is invalid")
                if type(record["boot"]) is not str or not re.fullmatch(r"[0-9a-f-]{36}", record["boot"]):
                    _fail("DEBT", "Reader journal boot identity is invalid")
                if record["leaf"] is not None and (type(record["leaf"]) is not str or not re.fullmatch(r"orbit-reader-[0-9a-f]{32}", record["leaf"])):
                    _fail("DEBT", "Reader journal leaf name is invalid")
                limits = record["limits"]
                if type(limits) is not dict or set(limits) != {"memory_bytes", "pids", "cpu_quota", "cpu_period", "swap_bytes"}:
                    _fail("DEBT", "Reader journal limits are invalid")
                if type(limits["swap_bytes"]) is not int or limits["swap_bytes"] != 0:
                    _fail("DEBT", "Reader journal swap limit is invalid")
                try:
                    ReaderLimits(**{key: value for key, value in limits.items() if key != "swap_bytes"})
                except ReaderScopeError:
                    _fail("DEBT", "Reader journal limits are invalid")
                # Inspect EVERY historical event, not only the final phase. A later
                # healthy generation cannot erase legacy unproven recovered-root debt.
                if record["phase"] == "retired" and record["recovered"]:
                    _fail("DEBT", "Journal contains unproven recovered retirement")
                self._validate_transition(last, record)
                last = record
        except (ValueError, TypeError, KeyError, UnicodeError):
            _fail("DEBT", "Reader journal cannot be parsed")
        return last

    @staticmethod
    def _validate_transition(previous, record):
        phase = record["phase"]
        if previous is None:
            if (phase != "idle" or record["leaf"] is not None or record["leaf_identity"] is not None
                    or record["process"] is not None or record["recovered"] or record.get("spawn_pending", False)):
                _fail("DEBT", "Reader journal lacks its initial empty record")
            return
        # Append history is schema-monotonic. A healthy checkpoint starts a new
        # file history; it is never an in-history schema downgrade or key removal.
        if set(previous) - set(record):
            _fail("DEBT", "Reader journal fields cannot be removed from append history")
        if previous["v"] > record["v"] or (previous["v"] != record["v"] and phase != "spawn_intent"):
            _fail("DEBT", "Reader journal schema transition is invalid")
        allowed = {"intent": {"idle", "retired"}, "pinned": {"intent"}, "prepared": {"pinned"},
                   "spawn_intent": {"prepared"}, "spawn_bound": {"spawn_intent"},
                   "admitting": {"prepared", "spawn_bound"}, "admitted": {"admitting"},
                   "killing": {"pinned", "prepared", "spawn_intent", "spawn_bound", "admitting", "admitted"},
                   "recovery": {"pinned", "prepared", "spawn_bound", "admitting", "admitted", "killing", "recovery"},
                   "retired": {"pinned", "prepared", "spawn_bound", "admitting", "admitted", "killing", "recovery"}}
        if previous["phase"] not in allowed.get(phase, set()):
            _fail("DEBT", "Reader journal phase transition is invalid")
        changed = {key for key in record if record[key] != previous.get(key)} - {"phase", "sequence"}
        permitted = {"intent": {"leaf", "leaf_identity", "process", "owner", "recovered", "limits"},
                     "pinned": {"leaf_identity"}, "admitting": {"process"},
                     "spawn_intent": {"v", "spawn_pending"}, "spawn_bound": {"process", "spawn_pending"},
                     "recovery": {"owner", "recovered"}}
        if changed - permitted.get(phase, set()):
            _fail("DEBT", "Reader journal identity or limits changed unexpectedly")
        if phase == "intent":
            if (record["leaf"] is None or record["leaf"] == previous["leaf"]
                    or record["leaf_identity"] is not None or record["process"] is not None or record["recovered"]):
                _fail("DEBT", "Reader journal intent is invalid")
        elif record["leaf"] is None or record["leaf_identity"] is None:
            _fail("DEBT", "Reader journal lacks a pinned leaf")
        if phase == "spawn_intent" and (record["v"] != 2 or not record["spawn_pending"] or record["process"] is not None):
            _fail("DEBT", "Reader spawn intent is invalid")
        if phase == "spawn_bound" and (record["v"] != 2 or record["spawn_pending"] or record["process"] is None):
            _fail("DEBT", "Reader spawn binding is invalid")
        if phase == "admitting" and previous["phase"] == "spawn_bound" and record["process"] != previous["process"]:
            _fail("DEBT", "Reader admission changed its bound process")
        if phase in ("recovery", "retired") and record.get("spawn_pending", False):
            _fail("DEBT", "Unresolved reader spawn cannot be recovered or retired")
        if phase in ("admitting", "admitted") and record["process"] is None:
            _fail("DEBT", "Reader journal lacks admitted root identity")
        if phase == "recovery" and not record["recovered"]:
            _fail("DEBT", "Reader journal recovery is invalid")

    @staticmethod
    def _valid_identity(value):
        return type(value) is list and len(value) == 2 and all(type(item) is int and item > 0 for item in value)

    def _guard(self, leaf=False):
        if self._closed or self._poisoned or os.getpid() != self._pid:
            _fail("UNKNOWN", "Reader scope ownership is closed, inherited or uncertain")
        for path, identity, private in ((self.root, self._root_identity, False),
                                        (self.journal.parent, self._journal_dir_identity, True)):
            fd = _directory(os.fspath(path), private)
            try:
                if _identity(fd) != identity:
                    _fail("IDENTITY", "Reader directory identity changed")
            finally:
                os.close(fd)
        _cgroup2(self._root_fd)
        if _identity(self._root_fd) != self._root_identity:
            _fail("IDENTITY", "Pinned reader resource root changed")
        self._validate_journal()
        if self._load() != self._record:
            _fail("IDENTITY", "Reader journal changed during ownership")
        if leaf:
            if self._leaf_fd is None or self._record["leaf_identity"] is None:
                _fail("UNKNOWN", "Reader leaf identity is unavailable")
            _cgroup2(self._leaf_fd)
            named = os.stat(self._record["leaf"], dir_fd=self._root_fd, follow_symlinks=False)
            if (not stat.S_ISDIR(named.st_mode) or _identity(self._leaf_fd) != self._record["leaf_identity"]
                    or [named.st_dev, named.st_ino] != self._record["leaf_identity"]):
                _fail("IDENTITY", "Original reader leaf is unavailable or replaced")

    def _append(self, phase, **updates):
        self._validate_journal()
        record = dict(self._record, phase=phase, sequence=self._record["sequence"] + 1, **updates)
        data = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        if os.fstat(self._journal_fd).st_size + len(data) > self.MAX_JOURNAL_BYTES:
            _fail("DEBT", "Reader journal is full; unresolved debt cannot be evicted")
        try:
            remaining = data
            while remaining:
                written = os.write(self._journal_fd, remaining)
                if written <= 0:
                    raise OSError("Reader journal made no progress")
                remaining = remaining[written:]
            os.fsync(self._journal_fd)
            self._validate_journal()
        except BaseException:
            self._poisoned = True
            raise
        self._record = record

    def _control(self, name, value=None):
        self._guard(leaf=True)
        flags = (os.O_RDONLY if value is None else os.O_WRONLY) | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        fd = os.open(name, flags, dir_fd=self._leaf_fd)
        try:
            _cgroup2(fd)
            if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_dev != self._record["leaf_identity"][0]:
                _fail("IDENTITY", "Reader control is not in the original cgroup filesystem")
            if value is not None:
                data = (value + "\n").encode("ascii")
                if os.write(fd, data) != len(data):
                    _fail("UNKNOWN", "Reader cgroup control write was incomplete")
                return None
            data = os.read(fd, 65537)
            if len(data) > 65536:
                _fail("UNKNOWN", "Reader cgroup control exceeded its bound")
            return data.decode("ascii").strip()
        finally:
            os.close(fd)

    @_serialized
    def prepare(self):
        self._guard()
        if self._started:
            _fail("DEBT", "Reader scope instances cannot be reused")
        if self._record["phase"] not in ("idle", "retired"):
            _fail("DEBT", "Unresolved reader scope blocks new admission")
        if os.fstat(self._journal_fd).st_size > self.MAX_JOURNAL_BYTES - 16384:
            _fail("DEBT", "Reader journal lacks completion reserve")
        leaf = "orbit-reader-" + uuid.uuid4().hex
        self._started = True  # Consume this instance before any durable intent or leaf creation.
        self._append("intent", leaf=leaf, leaf_identity=None, process=None, owner=self._owner,
                     recovered=False, limits=self._limits_record())
        self._recovered = False
        # mkdir is exclusive. Never adopt a colliding existing name.
        os.mkdir(leaf, 0o700, dir_fd=self._root_fd)
        self._leaf_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self._root_fd)
        _cgroup2(self._leaf_fd)
        info = os.fstat(self._leaf_fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            _fail("IDENTITY", "Fresh reader leaf permissions are unsafe")
        self._append("pinned", leaf_identity=_identity(self._leaf_fd))
        if self._control("cgroup.type") != "domain" or not self.empty():
            _fail("UNSUPPORTED", "Reader leaf must be an empty cgroup2 domain")
        controls = {"memory.max": str(self.limits.memory_bytes), "memory.swap.max": "0",
                    "pids.max": str(self.limits.pids),
                    "cpu.max": f"{self.limits.cpu_quota} {self.limits.cpu_period}"}
        for name, value in controls.items():
            self._control(name, value)
            if self._control(name).split() != value.split():
                _fail("UNSUPPORTED", "Reader cgroup limits were not retained")
        # Require the exact kernel kill primitive before any helper may enter.
        fd = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self._leaf_fd)
        try:
            _cgroup2(fd)
        finally:
            os.close(fd)
        self._append("prepared")

    @_serialized
    def reserve_spawn(self):
        """Durably charge an unknown possible child BEFORE subprocess creation.

        Preflight must precede this call. There is deliberately no spawn-failed
        boolean/exception resolver: Popen can fail after creating a child.
        """
        self._guard(leaf=True)
        if self._record["phase"] != "prepared" or self._child is not None:
            _fail("DEBT", "Reader spawn can only be reserved once before admission")
        self._append("spawn_intent", v=2, spawn_pending=True)

    @_serialized
    def bind_child(self, process):
        """Bind the actual retained direct child before waiting for its stop."""
        self._guard(leaf=True)
        if self._record["phase"] != "spawn_intent" or self._child is not None:
            _fail("DEBT", "Reader spawn has no unbound child reservation")
        if not isinstance(process, subprocess.Popen) or process.returncode is not None:
            _fail("INVALID", "Reader binding requires a retained unreaped subprocess")
        current = _proc_identity(process.pid)
        if current is None or current["parent"] != self._pid:
            _fail("INVALID", "Reader binding requires an own direct child")
        again = _proc_identity(process.pid)
        if (again is None or _birth(again) != _birth(current)
                or again["parent"] != self._pid or process.returncode is not None):
            _fail("IDENTITY", "Reader child identity changed before binding")
        self._child = process
        self._append("spawn_bound", process=_birth(current), spawn_pending=False)
        after = _proc_identity(process.pid)
        if after is None or _birth(after) != _birth(current) or after["parent"] != self._pid:
            _fail("IDENTITY", "Reader child identity changed during durable binding")

    def admit(self, process):
        """Unavailable: numeric PID migration is not atomic owned-task placement.

        Refuse before inspecting inputs/self, acquiring locks or reading/writing
        cgroups. A future atomic-creation/placement schema needs a separate API.
        """
        _fail("UNSUPPORTED", "Reader numeric PID admission is unavailable")


    @_serialized
    def empty(self):
        """Recursive kernel populated state only, never root-reap or result ownership."""
        populated = self._populated(self._control("cgroup.events"))
        self._guard(leaf=True)
        return populated == 0

    @_serialized
    def kill(self):
        """Kill only the originally pinned owned leaf, never a PID or shared root."""
        self._guard(leaf=True)
        if self._record["phase"] not in ("pinned", "prepared", "spawn_intent", "spawn_bound", "admitting", "admitted", "killing", "recovery"):
            _fail("DEBT", "Reader leaf has no killable owned operation")
        if self._record["phase"] not in ("killing", "recovery"):
            self._append("killing")
        self._control("cgroup.kill", "1")

    @_serialized
    def recover(self):
        """Pin recorded original debt only after its recorded owner birth is dead."""
        self._guard()
        if self._started or self._leaf_fd is not None or self._record["phase"] in ("idle", "retired"):
            _fail("DEBT", "Reader scope has no recoverable orphan debt")
        if self._record.get("spawn_pending", False):
            _fail("UNKNOWN", "Unbound reader spawn debt cannot be reconciled after ownership loss")
        previous = _proc_identity(self._record["owner"][0])
        if previous is not None and _birth(previous) == self._record["owner"]:
            _fail("BUSY", "Reader scope owner may still be alive")
        if self._record["leaf_identity"] is None or self._record["leaf"] is None:
            _fail("UNKNOWN", "Reader intent lacks a recoverable original leaf identity")
        self._started = True  # A failed recovery cannot later adopt another leaf in this instance.
        fd = os.open(self._record["leaf"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self._root_fd)
        try:
            _cgroup2(fd)
            if _identity(fd) != self._record["leaf_identity"]:
                _fail("IDENTITY", "Orphan reader leaf was replaced; no cleanup attempted")
        except BaseException:
            os.close(fd)
            raise
        self._leaf_fd = fd
        self._guard(leaf=True)
        self._append("recovery", owner=self._owner, recovered=True)
        self._recovered = True
        # Caller explicitly chooses kill/empty/retire; recovery itself never signals.

    @_serialized
    def wait_root(self, pidfd, *, deadline, cancel=None):
        """Observe AND consume exact P_PIDFD wait status; ECHILD is always UNKNOWN.

        The scope must already bind the retained direct child. Birth/PPid are checked
        while the WNOWAIT zombie still exists, never inferred after reaping. This is
        not atomic creation/admission provenance, descendant or provider completion.
        Retained Popen/pidfd are exclusive owner state, not public poll/wait handles.
        returncode may become visible after an interrupted consuming syscall; ONLY
        an exact directly returned receipt may acknowledge root accounting. There
        is no cached token recovery; interruption after publication retains poison
        until the caller explicitly supplies its returned token to retire. Arbitrary
        async exceptions during lock/FD acquisition cannot promise leak-free
        cleanup or bounded termination/reaping. The owner must exclude arbitrary
        asynchronous interruption at ownership-acquisition boundaries for liveness.
        Unknown stays sticky; it never becomes a root-reaped receipt.
        """
        self._guard(leaf=True)
        child = self._child
        birth = self._record["process"]
        generation = (self._record["leaf"], tuple(self._record["leaf_identity"]))
        if (self._recovered or child is None or birth is None or child.pid != birth[0]
                or getattr(os, "P_PIDFD", None) != 3 or not hasattr(os, "WNOWAIT")):
            _fail("UNKNOWN", "Reader root wait has no exact retained binding")
        if self._wait_poisoned:
            _fail("UNKNOWN", "Reader wait consumption is unresolved")
        try:
            finite = type(deadline) in (int, float) and math.isfinite(deadline)
        except (OverflowError, ValueError):
            finite = False
        if not finite or cancel is not None and type(cancel) is not threading.Event:
            _fail("UNKNOWN", "Reader root wait boundary is invalid")
        now = time.monotonic()
        if not math.isfinite(now) or not 0 < deadline - now <= 3 or cancel is not None and threading.Event.is_set(cancel):
            _fail("UNKNOWN", "Reader root wait exceeded its boundary")
        if self._wait_receipt is not None:
            _fail("UNKNOWN", "Reader wait is one-shot; no cached receipt retrieval")
        fd, acquired, failed, receipt = None, False, False, None
        last = now
        def check():
            nonlocal last
            sampled = time.monotonic()
            if not math.isfinite(sampled) or sampled < last or sampled >= deadline:
                raise RuntimeError()
            last = sampled
            if cancel is not None and threading.Event.is_set(cancel):
                raise RuntimeError()
            return deadline - sampled
        # Poison before ANY ownership acquisition; interrupted acquire/assignment
        # can strand a lock or FD, but must never permit a fresh wait or retirement.
        self._wait_poisoned = True
        try:
            lock = child._waitpid_lock
            if type(lock) is not type(threading.Lock()): raise RuntimeError()
            while not acquired:
                acquired = _acquire_wait_lock(lock, min(.05, check()))
            if child.returncode is not None: raise RuntimeError()
            # Acquisition/cleanup uncertainty is sticky too, not only reap uncertainty.
            self._wait_poisoned = True
            fd = _dup_wait_pidfd(pidfd, birth[0])
            while True:
                check()
                observed = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if observed is None:
                    select.select([fd], [], [], min(.05, check()))
                    continue
                if (observed.si_pid != birth[0] or observed.si_code not in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED)
                        or type(observed.si_status) is not int): raise RuntimeError()
                current = _proc_identity(birth[0])
                if (current is None or _birth(current) != birth or current["parent"] != self._pid
                        or current["state"] != "Z" or child.pid != birth[0] or child.returncode is not None):
                    raise RuntimeError()
                check()
                # Consuming is irreversible. Any interruption from here quarantines
                # the binding, even if Popen.returncode later becomes available.
                self._wait_poisoned = True
                consumed = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG)
                if (consumed is None or (consumed.si_pid, consumed.si_code, consumed.si_status)
                        != (observed.si_pid, observed.si_code, observed.si_status)):
                    raise RuntimeError()
                status = consumed.si_status
                if consumed.si_code == os.CLD_EXITED:
                    if not 0 <= status <= 255: raise RuntimeError()
                    code = status
                else:
                    if not 0 < status < signal.NSIG: raise RuntimeError()
                    code = -status
                if child.pid != birth[0] or child.returncode is not None: raise RuntimeError()
                child.returncode = code  # Actual waitid result, never Popen ECHILD synthesis.
                receipt = RootWaitReceipt(code)
                self._wait_owner = self
                self._wait_receipt, self._wait_code, self._wait_child = receipt, code, child
                self._wait_birth, self._wait_generation = tuple(birth), generation
                check()
                break
        except BaseException:
            failed = True
        finally:
            if fd is not None:
                try: os.close(fd)
                except BaseException:
                    failed = True
                    self._poisoned = True
            if acquired:
                try:
                    lock.release()
                except BaseException:
                    failed = True
        if not failed:
            try:
                check()
            except BaseException:
                failed = True
        if failed:
            self._wait_ready = False
            self._wait_receipt = None
            _fail("UNKNOWN", "Reader root has no confirmed kernel wait outcome")
        # Explicit acknowledgement: keep poison until retire receives the exact
        # object actually returned to the caller. An interrupted return cannot
        # recover a token through a cached wait_root retry. Private fields are
        # not a token retrieval API or an authority channel.
        self._wait_ready = True
        return receipt

    @_serialized
    def retire(self, wait_receipt=None):
        """Return separate scope-empty/root-reaped facts after original-leaf removal."""
        self._guard(leaf=True)
        if self._record.get("spawn_pending", False):
            _fail("UNKNOWN", "Reader scope emptiness cannot resolve an unbound possible child")
        if self._recovered or self._record["recovered"]:
            _fail("UNKNOWN", "Recovered reader process containment remains unconfirmed")
        if not self.empty():
            _fail("UNKNOWN", "Reader descendants have not been proved absent")
        root_reaped = False
        if self._record["process"] is not None:
            if (self._wait_owner is not self or not self._wait_ready or wait_receipt is None or wait_receipt is not self._wait_receipt or self._wait_consumed
                    or self._child is None or self._wait_child is not self._child
                    or self._wait_birth != tuple(self._record["process"])
                    or self._wait_generation != (self._record["leaf"], tuple(self._record["leaf_identity"]))
                    or self._child.returncode != self._wait_code):
                _fail("UNKNOWN", "Reader root requires its exact consumed kernel wait receipt")
            root_reaped = True
        self._guard(leaf=True)
        os.rmdir(self._record["leaf"], dir_fd=self._root_fd)
        # A crash before this durable event leaves debt, not permission to infer empty.
        self._append("retired")
        if root_reaped:
            self._wait_consumed = True
            self._wait_ready = False
            self._wait_poisoned = False
        os.close(self._leaf_fd)
        self._leaf_fd = None
        self._child = None
        return {"scopeEmpty": True, "rootReaped": root_reaped,
                "neverAdmitted": self._record["process"] is None, "recovered": self._recovered}

    @_serialized
    def checkpoint(self):
        """Bound healthy history on the SAME locked inode, never clear active debt.

        The instance's single-operation flag is deliberately not reset. A crash
        leaving empty/torn storage refuses reopen. A fully persisted idle record
        describes only this already-proven no-work state, not active work.
        """
        self._guard()
        if (self._recovered or self._record["recovered"]
                or self._record["phase"] not in ("idle", "retired") or self._leaf_fd is not None or self._child is not None):
            _fail("DEBT", "Reader checkpoint cannot discard unresolved scope ownership")
        self._root_no_work()
        # Keep the original flock and inode; never rename or replace the lock file.
        try:
            fcntl.flock(self._journal_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("BUSY", "Reader journal lock is unavailable for checkpoint")
        self._guard()
        try:
            os.ftruncate(self._journal_fd, 0)
            self._record = self._initial_record()
            self._append("idle")
            self._validate_journal()
        except BaseException:
            self._poisoned = True
            # Even a failed fsync after writing complete JSON must not look like
            # success on an ordinary reopen. If storage rejects invalidation as
            # well, durable failure marking cannot be guaranteed; never claim it.
            try:
                os.ftruncate(self._journal_fd, 0)
                os.fsync(self._journal_fd)
            except BaseException:
                pass
            raise

    @_serialized
    def status(self):
        self._guard()
        return {"phase": self._record["phase"], "leaf": self._record["leaf"],
                "hasDebt": self._record["phase"] not in ("idle", "retired"),
                "recovered": self._record["recovered"]}

    @_serialized
    def close(self):
        """Drop local descriptors only. Never erase journal debt or kill work."""
        self._closed = True
        errors = []
        for name in ("_leaf_fd", "_journal_fd", "_journal_dir", "_root_fd"):
            fd = getattr(self, name, None)
            setattr(self, name, None)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError as error:
                    errors.append(error)
        if errors:
            raise ExceptionGroup("Reader scope descriptor cleanup failed", errors)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
