"""Owned synchronous store protocol, NOT process startup or public authorization.

Owner transfers exclusive lifetime of one pre-established nonblocking AF_UNIX
stream socket and supplies actual protected object/key mappings and root FD.
The service always seals a permanent same-root session marker under the actual
Store flock before construction returns. The owner separately guarantees a newly
provisioned root, no legacy writers/orphan and a stable authoritative root mapping;
absence of a marker is NOT historical cleanliness. Pre-seal failure/orphan startup
remains unqualified. Close never removes the marker, even after apparent success.
No socket connect/listen, subprocess, peer authentication, environment, paths or
keys on the wire. Same-UID hostile code and externally closed/reused FDs are not
an isolation boundary. The owner must keep socket descriptors private/exclusive.

Frames: 4-byte BE length (1..1024) and EXACT compact ASCII JSON, ordered keys:
{id,slot,record:{instance,epoch,enabled}}; ACK {id,ok:true}. IDs start at1 and
increase exactly once without wrapping past MAX_SAFE. Slots index <=4 trusted
mappings, not client-selected identities. ACK is sent ONLY after actual durable
commit returns; successful send does not prove the client received it or drain.

No automatic threads/timers/retries. serve_one is synchronous and nonreentrant.
FS calls cannot be preempted by timeout/cancel. close during an active call
poisons it without touching the socket and does NOT close/release the store until
the call returns. close(False) is NOT cancellation, a revocation fence, or a promise
of no future effects: a commit may start and ACK bytes may be queued after that
request. Already sent bytes cannot be retracted. The client independently poisons
on channel failure. Local success linearizes at the final mutex publication, not
future authority. The owner waits for each serve_one return before the next call;
clients wait for ACK and do not pipeline. Peeking rejects only already queued extra
bytes, not arbitrary future sends. A complete ACK can reach the peer BEFORE a
late root/marker failure is observed; there is no atomic filesystem/client-ACK
authorization boundary. Trusted root stability and client failure fencing remain
required. FD-alias exclusion is a trusted owner contract,
not enforced by the socket-object weak claim. Unknown/lost ACK must poison the external coordinator, never replay
or restore enabled state from disk. Local close is not peer/process-stop proof.
"""
import json
import math
import os
import re
import select
import socket
import stat
import struct
import sys
import threading
import time
import weakref
from types import MappingProxyType

from .read_usage_store import ReadUsageStore

_MAX_SAFE = 9007199254740991
_CLAIMS = weakref.WeakSet()
_CLAIM_LOCK = threading.Lock()


class ReadUsageServiceError(RuntimeError):
    def __init__(self, code="UNCONFIRMED"):
        self.code = code if code in ("INVALID", "CLOSED", "BUSY", "UNCONFIRMED") else "UNCONFIRMED"
        super().__init__("Owned usage store service refused")


def _fail(code="UNCONFIRMED"):
    raise ReadUsageServiceError(code)


def _finite(value):
    try: return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError): return False


def _pairs(items):
    result = {}
    for key, value in items:
        if type(key) is not str or key in result: _fail("INVALID")
        result[key] = value
    return result


def _encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=False).encode("ascii")


def _request(raw, expected, count):
    value = json.loads(raw.decode("ascii"), object_pairs_hook=_pairs,
                       parse_constant=lambda unused: _fail("INVALID"))
    if type(value) is not dict or set(value) != {"id", "slot", "record"}: _fail("INVALID")
    request_id, slot, record = value["id"], value["slot"], value["record"]
    if (type(request_id) is not int or request_id != expected or not 1 <= request_id <= _MAX_SAFE
            or type(slot) is not int or not 0 <= slot < count or type(record) is not dict
            or set(record) != {"instance", "epoch", "enabled"}): _fail("INVALID")
    if (type(record["instance"]) is not str or re.fullmatch(r"[0-9a-f]{64}", record["instance"]) is None
            or type(record["epoch"]) is not int or not 1 <= record["epoch"] <= _MAX_SAFE
            or type(record["enabled"]) is not bool): _fail("INVALID")
    snapshot = {"instance": record["instance"], "epoch": record["epoch"], "enabled": record["enabled"]}
    if raw != _encoded({"id": request_id, "slot": slot, "record": snapshot}): _fail("INVALID")
    return request_id, slot, snapshot


class ReadUsageStoreService:
    """No production route. Socket ownership transfers after static validation."""
    def __init__(self, connection, root, entries, *, expected_root_fd):
        if (sys.platform != "linux" or type(connection) is not socket.socket
                or type(root) is not str or type(expected_root_fd) is not int or expected_root_fd < 3
                or type(entries) is not tuple or not 1 <= len(entries) <= 4): _fail("INVALID")
        for item in entries:
            if (type(item) is not tuple or len(item) != 2 or type(item[0]) is not object
                    or type(item[1]) is not str or re.fullmatch(r"[0-9a-f]{64}", item[1]) is None): _fail("INVALID")
        if (len({item[1] for item in entries}) != len(entries)
                or len({id(item[0]) for item in entries}) != len(entries)): _fail("INVALID")
        try:
            info = os.fstat(connection.fileno())
            valid = (stat.S_ISSOCK(info.st_mode) and connection.family == socket.AF_UNIX
                     and connection.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) == socket.AF_UNIX
                     and connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM
                     and connection.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0
                     and not os.get_blocking(connection.fileno()))
            connection.getpeername()
        except BaseException:
            valid = False
        if not valid: _fail("INVALID")
        with _CLAIM_LOCK:
            if connection in _CLAIMS: _fail("BUSY")
            _CLAIMS.add(connection)
        self._pid, self._mutex = os.getpid(), threading.Lock()
        self._connection, self._socket_pin = connection, (info.st_dev, info.st_ino)
        self._entries = entries
        self._next, self._busy, self._failed, self._closing = 1, False, False, False
        self._closed = self._cleanup_started = False
        self._cleanup_ok = False
        self._store = None
        failed = False
        try:
            self._store = ReadUsageStore(root, entries, expected_root_fd=expected_root_fd)
            self._store._seal_session()  # Durable same-root fence BEFORE any service handle/request.
        except BaseException:
            failed = True
        if failed:
            self._failed = self._closing = True
            self._finish_close()
            _fail()

    def _owner(self):
        if os.getpid() != self._pid: _fail()

    def _check(self, deadline, cancel, last):
        self._owner()
        sampled = time.monotonic()
        if (not _finite(sampled) or sampled < last or sampled >= deadline
                or cancel is not None and threading.Event.is_set(cancel)): _fail()
        with self._mutex:
            if self._failed or self._closing or self._closed: _fail()
        info = os.fstat(self._connection.fileno())
        if ((info.st_dev, info.st_ino) != self._socket_pin or os.get_blocking(self._connection.fileno())): _fail()
        self._store._guard()  # Revalidate retained root/lock/session marker immediately before I/O/ACK.
        after = time.monotonic()
        if (not _finite(after) or after < sampled or after >= deadline
                or cancel is not None and threading.Event.is_set(cancel)): _fail()
        with self._mutex:
            if self._failed or self._closing or self._closed: _fail()
        return after

    def _no_extra(self):
        try:
            extra = self._connection.recv(1, socket.MSG_DONTWAIT | socket.MSG_PEEK)
        except BlockingIOError:
            return
        # Both a pipelined extra frame and client EOF break the exclusive channel.
        _fail()

    def _finish_close(self):
        with self._mutex:
            if self._busy or self._cleanup_started: return self._cleanup_ok
            self._cleanup_started = True
            store, self._store = self._store, None
        okay = True
        if store is not None:
            try: store.close()
            except BaseException: okay = False
        try: self._connection.close()
        except BaseException: okay = False
        with self._mutex:
            self._closed, self._cleanup_ok = True, okay
            if not okay: self._failed = True
        return okay

    def close(self):
        self._owner()
        with self._mutex:
            self._closing = True
            active = self._busy
            if active: self._failed = True
        # Do not act on the socket after releasing the mutex: another closer may
        # finish and its previous owner may reuse the Python socket object. The
        # active call observes the flag on its next bounded I/O check; filesystem
        # syscalls may still block indefinitely. False is not cancellation.
        if active:
            return False
        return self._finish_close()

    def status(self):
        self._owner()
        with self._mutex:
            return MappingProxyType({"busy": self._busy, "closed": self._closed,
                                     "failed": self._failed, "localResourcesClosed": self._cleanup_ok})

    def serve_one(self, *, deadline, cancel=None):
        """One sequential commit. True is local ACK-send, NOT acknowledged client state."""
        self._owner()
        if not _finite(deadline) or cancel is not None and type(cancel) is not threading.Event:
            self.close(); _fail("INVALID")
        now = time.monotonic()
        if not _finite(now) or not 0 < deadline - now <= 3:
            self.close(); _fail("INVALID")
        with self._mutex:
            if self._closed or self._closing or self._failed: _fail("CLOSED")
            conflict = self._busy
            if not conflict: self._busy = True
        if conflict:
            self.close(); _fail("BUSY")
        last, succeeded = now, False
        try:
            def receive(size):
                nonlocal last
                data = bytearray()
                while len(data) < size:
                    last = self._check(deadline, cancel, last)
                    ready, _, _ = select.select([self._connection], [], [], min(.05, deadline-last))
                    last = self._check(deadline, cancel, last)
                    if not ready: continue
                    try: part = self._connection.recv(size-len(data), socket.MSG_DONTWAIT)
                    except BlockingIOError: continue
                    if not part: _fail()
                    data.extend(part)
                return bytes(data)
            length = struct.unpack(">I", receive(4))[0]
            if not 1 <= length <= 1024: _fail("INVALID")
            request_id, slot, record = _request(receive(length), self._next, len(self._entries))
            self._no_extra()
            last = self._check(deadline, cancel, last)
            self._store.commit(self._entries[slot][0], record)
            last = self._check(deadline, cancel, last)
            self._no_extra()
            payload = _encoded({"id": request_id, "ok": True})
            frame = struct.pack(">I", len(payload)) + payload
            offset = 0
            while offset < len(frame):
                last = self._check(deadline, cancel, last)
                _, ready, _ = select.select([], [self._connection], [], min(.05, deadline-last))
                last = self._check(deadline, cancel, last)
                if not ready: continue
                try: count = self._connection.send(memoryview(frame)[offset:], socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL)
                except BlockingIOError: continue
                if count <= 0: _fail()
                offset += count
            last = self._check(deadline, cancel, last)
            # Publish local completion atomically against close, not after an
            # unlocked last check. This point does not acknowledge client receipt.
            with self._mutex:
                if self._failed or self._closing or self._closed: _fail()
                self._next += 1  # MAX_SAFE+1 is exhausted, never wraps.
                succeeded = True
        except BaseException:
            with self._mutex: self._failed = self._closing = True
        finally:
            with self._mutex:
                self._busy = False
                must_close = self._closing or not succeeded
                if must_close:
                    self._closing = True
                    succeeded = False
            # A close after the busy flag changes performs its own cleanup; a
            # close during work is observed above and completed here exactly once.
            if must_close: self._finish_close()
        if not succeeded: _fail()
        return True
