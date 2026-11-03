"""Owned, read-only AT-SPI helper transport. No automatic retry or input verbs."""
import json
import math
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import subprocess
import threading
import time
import uuid

WORKER_PATH = Path(__file__).with_name("a11y_host_worker.py")
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_NODES = 300
BUDGET_MS = 1500
MAX_TIMEOUT_MS = 5000
# Cleanup is outside the observation deadline, bounded to this additional reserve.
TERM_WAIT_SECONDS = 0.1
KILL_WAIT_SECONDS = 0.3


class A11yHostError(RuntimeError):
    """Fixed content-free transport failure, never proof of observation freshness."""


def _invalid():
    return A11yHostError("Accessibility helper transport failed")


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise _invalid()
    return result


def _json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise _invalid()
        value[key] = item
    return value


class A11yHost:
    def __init__(self, runtime):
        try:
            path = Path(runtime)
            info = path.stat()
            if not path.is_absolute() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                raise _invalid()
            self._runtime = str(path)
        except (OSError, TypeError, ValueError):
            raise _invalid() from None
        self._operation = threading.Lock()
        self._state = threading.RLock()
        self._process = None
        self._socket = None
        self._generation = None
        self._closed = False

    def _destroy(self):
        """Invalidate first, retain ownership if the kernel cannot reap the child."""
        with self._state:
            self._generation = None
            connection, self._socket = self._socket, None
            if connection is not None:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    connection.close()
                except OSError:
                    pass
            process = self._process
            if process is None:
                return
            try:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=TERM_WAIT_SECONDS)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait(timeout=KILL_WAIT_SECONDS)
                else:
                    process.wait(timeout=0)
            except (OSError, subprocess.TimeoutExpired):
                # Quarantined: no socket or generation, but still own the unreaped process.
                raise _invalid() from None
            self._process = None

    def close(self):
        with self._state:
            self._closed = True
            self._destroy()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @staticmethod
    def _remaining(deadline):
        remaining = (deadline - time.monotonic_ns()) / 1_000_000_000
        if remaining <= 0:
            raise _invalid()
        return remaining

    def _start(self, deadline):
        with self._state:
            if self._closed:
                raise _invalid()
            if self._socket is not None:
                if self._process.poll() is not None:
                    raise _invalid()
                return self._socket, self._generation
            if self._process is not None:
                # Explicit close may attempt cleanup again. Observe never hides failed reaping.
                raise _invalid()
            self._remaining(deadline)
            parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            generation = uuid.uuid4().hex
            try:
                process = subprocess.Popen(
                    ["/usr/bin/python3", "-I", str(WORKER_PATH), "--fd", str(child.fileno()),
                     "--expected-parent", str(os.getpid()), "--generation", generation],
                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": self._runtime},
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    pass_fds=(child.fileno(),), close_fds=True, start_new_session=True)
                self._process, self._socket, self._generation = process, parent, generation
            except BaseException:
                parent.close()
                raise
            finally:
                child.close()
        hello = self._read(parent, deadline)
        if hello != {"protocol": 1, "generation": generation, "kind": "ready"} or type(hello.get("protocol")) is not int:
            raise _invalid()
        return parent, generation

    def _exact(self, connection, size, deadline):
        result = bytearray()
        while len(result) < size:
            connection.settimeout(self._remaining(deadline))
            chunk = connection.recv(size - len(result))
            if not chunk:
                raise _invalid()
            result.extend(chunk)
        return bytes(result)

    @staticmethod
    def _no_surplus(connection):
        # There are no unsolicited messages in this serialized request/reply protocol.
        if select.select([connection], [], [], 0)[0]:
            raise _invalid()

    def _read(self, connection, deadline):
        size = struct.unpack(">I", self._exact(connection, 4, deadline))[0]
        if not 1 <= size <= MAX_RESPONSE_BYTES:
            raise _invalid()
        payload = self._exact(connection, size, deadline)
        self._no_surplus(connection)
        try:
            value = json.loads(payload.decode("utf-8"), object_pairs_hook=_json_object, parse_float=_finite_float,
                               parse_constant=lambda _: (_ for _ in ()).throw(_invalid()))
        except (UnicodeError, ValueError, RecursionError):
            raise _invalid() from None
        if type(value) is not dict:
            raise _invalid()
        self._remaining(deadline)
        return value

    def observe(self, pid, title, timeout_ms=MAX_TIMEOUT_MS):
        acquired = False
        try:
            if (type(pid) is not int or not 0 < pid <= 2 ** 31 - 1 or type(title) is not str
                    or "\0" in title or len(title) > 16_384 or len(title.encode("utf-8")) > 16_384
                    or type(timeout_ms) not in (int, float) or not math.isfinite(timeout_ms)
                    or not 0 < timeout_ms <= MAX_TIMEOUT_MS):
                raise _invalid()
            deadline = time.monotonic_ns() + int(timeout_ms * 1_000_000)
            acquired = self._operation.acquire(timeout=self._remaining(deadline))
            if not acquired:
                raise _invalid()
            connection, generation = self._start(deadline)
            self._no_surplus(connection)
            request_id = uuid.uuid4().hex
            payload = json.dumps({
                "protocol": 1, "generation": generation, "requestId": request_id, "method": "observe",
                "target": {"pid": pid, "title": title, "maxNodes": MAX_NODES,
                           "budgetMs": BUDGET_MS, "deadlineNs": deadline},
            }, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if len(payload) > MAX_REQUEST_BYTES:
                raise _invalid()
            connection.settimeout(self._remaining(deadline))
            connection.sendall(struct.pack(">I", len(payload)) + payload)
            response = self._read(connection, deadline)
            common = {"protocol", "generation", "requestId", "ok"}
            if (type(response.get("protocol")) is not int or response.get("protocol") != 1
                    or response.get("generation") != generation or response.get("requestId") != request_id
                    or type(response.get("ok")) is not bool):
                raise _invalid()
            if response["ok"] is False:
                if set(response) != common | {"error"} or response["error"] != {"code": "UNAVAILABLE"}:
                    raise _invalid()
                raise _invalid()
            if set(response) != common | {"result"} or type(response["result"]) is not dict:
                raise _invalid()
            with self._state:
                if self._closed or self._generation != generation or self._socket is not connection:
                    raise _invalid()
            return response["result"]
        except BaseException as error:
            # Preflight and queued callers do not own the admitted operation or its helper.
            if acquired:
                try:
                    self._destroy()
                except A11yHostError:
                    pass
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise _invalid() from None
        finally:
            if acquired:
                self._operation.release()
