"""Experimental read-only helper. No refs, semantic actions, launches or public socket.

Only a private inherited descriptor carries bounded observation requests. Parent-death
protection is armed before accessibility initialization. Provider errors never leave
the helper as exception strings. Cache/event freshness is best effort, not identity.
"""
import ctypes
import gc
import json
import os
from pathlib import Path
import re
import resource
import signal
import socket
import struct
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native import a11y_dump
from src.native.a11y import _trim

PROTOCOL = 1
MAX_REQUEST = 65536
MAX_RESPONSE = 262144
TOKEN = re.compile(r"[0-9a-f]{32}", re.ASCII)


def arm_parent_death(expected_parent):
    """No preexec_fn in a threaded parent; close the parent-death startup race here."""
    if type(expected_parent) is not int or expected_parent <= 1 or os.getppid() != expected_parent:
        raise RuntimeError("Parent unavailable")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise RuntimeError("Parent supervision unavailable")
    if os.getppid() != expected_parent:
        raise RuntimeError("Parent unavailable")


def resource_limits():
    # Additional per-helper ceilings supplement the inherited native process budget.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    for kind, ceiling in ((resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_NOFILE, 64)):
        soft, hard = resource.getrlimit(kind)
        limit = min(ceiling, soft) if soft != resource.RLIM_INFINITY else ceiling
        if hard != resource.RLIM_INFINITY:
            limit = min(limit, hard)
        resource.setrlimit(kind, (limit, hard))


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Invalid JSON")
        value[key] = item
    return value


def receive(connection):
    def exact(size):
        data = bytearray()
        while len(data) < size:
            part = connection.recv(size - len(data))
            if not part:
                raise EOFError()
            data.extend(part)
        return bytes(data)
    size = struct.unpack("!I", exact(4))[0]
    if not 1 <= size <= MAX_REQUEST:
        raise ValueError("Invalid frame")
    return json.loads(exact(size).decode("utf-8"), object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON")))


def send(connection, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if not 1 <= len(data) <= MAX_RESPONSE:
        raise ValueError("Invalid frame")
    connection.sendall(struct.pack("!I", len(data)) + data)


def parse_request(value, generation):
    if (type(value) is not dict or set(value) != {"protocol", "generation", "requestId", "method", "target"}
            or type(value["protocol"]) is not int or value["protocol"] != PROTOCOL
            or value["generation"] != generation or value["method"] != "observe"
            or type(value["requestId"]) is not str or not TOKEN.fullmatch(value["requestId"])):
        raise ValueError("Invalid request")
    target = value["target"]
    if (type(target) is not dict or set(target) != {"pid", "title", "maxNodes", "budgetMs", "deadlineNs"}
            or type(target["pid"]) is not int or not 0 < target["pid"] <= 2147483647
            or type(target["title"]) is not str or len(target["title"].encode("utf-8")) > 16384 or "\0" in target["title"]
            or type(target["maxNodes"]) is not int or target["maxNodes"] != 300
            or type(target["budgetMs"]) is not int or target["budgetMs"] != 1500
            or type(target["deadlineNs"]) is not int):
        raise ValueError("Invalid target")
    now = time.monotonic_ns()
    if not now < target["deadlineNs"] <= now + 5_000_000_000:
        raise ValueError("Expired request")
    return target


def process_generation(pid):
    # Linux stat field 22, after the final parenthesis of the executable name.
    fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    return fields[19]


class ReadOnlyProvider:
    def __init__(self):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
        self.atspi = Atspi
        self.context = GLib.MainContext.default()
        self.changed = False
        self.deadline = 0
        self.listener = Atspi.EventListener.new(self._changed, None)
        Atspi.init()
        for event in ("object:children-changed", "object:state-changed:defunct",
                      "object:property-change", "object:text-changed"):
            if not self.listener.register(event):
                raise RuntimeError("Event observation unavailable")

    def _changed(self, *args):
        self.changed = True

    def pump(self):
        # A flood must not turn event dispatch into an unbounded drain loop.
        for _ in range(16):
            if time.monotonic_ns() >= self.deadline:
                raise TimeoutError()
            if not self.context.pending():
                return
            self.context.iteration(False)
        if self.context.pending():
            self.changed = True

    def refresh(self, node):
        self.pump()
        node.set_cache_mask(self.atspi.Cache.NONE)
        node.clear_cache_single()

    def observe(self, target):
        self.deadline = target["deadlineNs"]
        self.pump()
        self.changed = False
        generation = process_generation(target["pid"])
        remaining_ms = max(1, (self.deadline - time.monotonic_ns()) // 1_000_000)
        budget = min(target["budgetMs"], remaining_ms)
        result = a11y_dump.main([str(target["pid"]), target["title"], str(target["maxNodes"]), str(budget)], refresh=self.refresh)
        self.pump()
        if self.changed or process_generation(target["pid"]) != generation:
            return {"status": "unavailable", "reason": "accessibility changed during observation"}
        if result.get("status") == "ok":
            result["nodes"], cut = _trim(result["nodes"])
            result["truncated"] = result.get("truncated") or cut
        return result


def serve(connection, generation, provider_factory=ReadOnlyProvider):
    if type(generation) is not str or not TOKEN.fullmatch(generation):
        raise ValueError("Invalid generation")
    provider = None
    connection.settimeout(60)  # Idle helpers exit, and the parent detects EOF on its next call.
    send(connection, {"protocol": PROTOCOL, "generation": generation, "kind": "ready"})
    try:
        while True:
            request = receive(connection)
            target = parse_request(request, generation)
            try:
                if provider is None:
                    provider = provider_factory()
                result = provider.observe(target)
                if time.monotonic_ns() >= target["deadlineNs"]:
                    raise TimeoutError()
            except Exception:
                result = {"status": "unavailable", "reason": "accessibility helper query failed"}
            send(connection, {"protocol": PROTOCOL, "generation": generation,
                              "requestId": request["requestId"], "ok": True, "result": result})
            gc.collect()
    except (EOFError, OSError, ValueError, UnicodeError):
        return
    finally:
        connection.close()


def main(argv):
    if len(argv) != 6 or set(argv[::2]) != {"--fd", "--expected-parent", "--generation"}:
        return 1
    arguments = dict(zip(argv[::2], argv[1::2]))
    descriptor, parent = int(arguments["--fd"]), int(arguments["--expected-parent"])
    arm_parent_death(parent)
    resource_limits()
    serve(socket.socket(fileno=descriptor), arguments["--generation"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(1)
