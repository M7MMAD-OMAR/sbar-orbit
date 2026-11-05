"""Journaled native plugin requests bound to a prepared compositor identity.

This cooperative transport does not install or activate a plugin and does not
provide an OS security boundary. Caller controls own the mode and durable log.
"""
import copy
import json
from pathlib import Path
import re
import socket
import time
import threading

from .host import GONE_TARGET, HostError, TargetClosed, metadata, peer, verify_host, deadline_timeout
from .keyboard import KEYBOARD_ACTIONS, input_acknowledged, prepared_input
from .budget import require_budget


ACTIONS = frozenset({"ghost-key", "ghost-type", "ghost-texthex", "ghost-click", "ghost-move", "ghost-mouse-down", "ghost-mouse-up", "ghost-drag", "ghost-target-check",
                     "ghost-window-close", "ghost-scroll", "ghost-cursor", "ghost-release", "ghost-state",
                     "ghost-semantic-prepare", "ghost-semantic-status", "ghost-semantic-send", "ghost-semantic-cancel"})
SEMANTIC_COMMANDS = frozenset({"ghost-semantic-prepare", "ghost-semantic-status", "ghost-semantic-send", "ghost-semantic-cancel"})
SEMANTIC_REASONS = frozenset({"preparing", "prepared", "awaiting-reply", "replied", "method-error", "bus-changed", "provider-changed",
                              "stale-object", "disconnected", "cancelled", "not-ready", "partial-send", "send-refused", "deadline",
                              "admission-refused", "invalid-transport"})


def _semantic_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate semantic field")
        result[key] = value
    return result


OWNER_PAUSED = "refused: application lease is paused while the owner"
OWNER_RESUME_SECONDS = 4


def action_request(request):
    if not isinstance(request, str) or not 1 <= len(request.encode("utf-8")) <= 65536:
        raise HostError("Native request must contain 1 to 65536 UTF-8 bytes")
    if any(character in request for character in ("\0", "\r", "\n")):
        raise HostError("Native request must be a single IPC command")
    parts = request.split()
    if not parts or parts[0] not in ACTIONS:
        raise HostError("Native transport accepts plugin actions only")
    return parts[0]


def action_response(command, response):
    response = response.strip()
    if command in SEMANTIC_COMMANDS:
        try:
            value = json.loads(response, object_pairs_hook=_semantic_fields)
        except (ValueError, TypeError, RecursionError):
            raise HostError("Native semantic response is unavailable or invalid") from None
        if (not isinstance(value, dict) or set(value) != {"schema", "requestId", "state", "delivery", "accepted", "reason"}
                or type(value["schema"]) is not int or value["schema"] != 1
                or type(value["requestId"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", value["requestId"])
                or type(value["reason"]) is not str or value["reason"] not in SEMANTIC_REASONS
                or type(value["state"]) is not str or value["state"] not in ("preparing", "ready", "pending", "settled")
                or type(value["delivery"]) is not str or value["delivery"] not in ("not-delivered", "unknown", "delivered")
                or (value["accepted"] is not None and type(value["accepted"]) is not bool)
                or (value["state"] in ("preparing", "ready") and (value["delivery"] != "not-delivered" or value["accepted"] is not None))
                or (value["state"] == "pending" and (value["delivery"] != "unknown" or value["accepted"] is not None))
                or (value["state"] == "settled" and ((value["delivery"] == "delivered") != (type(value["accepted"]) is bool)))
                or (value["state"] in ("preparing", "ready", "pending") and value["reason"] != {"preparing": "preparing", "ready": "prepared", "pending": "awaiting-reply"}[value["state"]])
                or (value["state"] == "settled" and value["reason"] in ("preparing", "prepared", "awaiting-reply"))
                or (value["delivery"] == "delivered" and value["reason"] != "replied")):
            raise HostError("Native semantic response is unavailable or invalid")
        return response
    if response == "ok" and command != "ghost-state":
        return response
    if input_acknowledged(command, response):
        return response
    if command == "ghost-state":
        try:
            state = json.loads(response)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(state, dict) and all(isinstance(state.get(key), bool)
                                              for key in ("suspended", "render_unfocused")):
                return response
    if response in GONE_TARGET:
        raise TargetClosed("The target window closed or was replaced")
    raise HostError(response or "Empty native plugin response")


class NativeTransport:
    def __init__(self, plan):
        self._plan = copy.deepcopy(plan)
        self._input_lock = threading.RLock()
        verify_host(self._plan)

    def _exchange(self, request, deadline=None):
        plan = self._plan
        shared_deadline = deadline
        if deadline is None:
            verify_host(plan)
            deadline = time.monotonic() + 3
        else:
            verify_host(plan, deadline=deadline)
        path = Path(plan["runtime"]) / "hypr" / plan["signature"] / ".socket.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(deadline_timeout(deadline))
            connection.connect(str(path))
            if metadata(path) != plan["ipc_socket"] or peer(connection) != plan["compositor"]:
                raise HostError("Compositor changed before native request")
            connection.settimeout(deadline_timeout(deadline))
            connection.sendall(request.encode("utf-8"))
            # Hyprland reads again after each complete 1023-byte input chunk.
            # EOF terminates exact chunk multiples without waiting for a reply.
            connection.shutdown(socket.SHUT_WR)
            response = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Native request exceeded its deadline")
                connection.settimeout(remaining)
                chunk = connection.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
                if len(response) > 65536:
                    raise HostError("Native response is too large")
        if shared_deadline is None:
            verify_host(plan)
        else:
            verify_host(plan, deadline=deadline)
        return response.decode("utf-8")

    def execute(self, request, control):
        require_budget()
        action_request(request)
        return control.execute(request, lambda: self._perform(request))

    def _perform(self, request):
        """Internal operation inside an already admitted durable action."""
        def attempt():
            require_budget()
            command = action_request(request)
            if command in SEMANTIC_COMMANDS:
                result = action_response(command, self._exchange(request))
                parts = request.split()
                if len(parts) < 3 or json.loads(result)["requestId"] != parts[2]:
                    raise HostError("Native semantic response identity changed")
                return result
            if command not in KEYBOARD_ACTIONS:
                return action_response(command, self._exchange(request))
            deadline = time.monotonic() + 3
            if not self._input_lock.acquire(timeout=deadline_timeout(deadline)):
                raise TimeoutError("Native keyboard action is busy")
            try:
                return action_response(command, prepared_input(request, self._exchange, deadline))
            finally:
                self._input_lock.release()

        give_up = time.monotonic() + OWNER_RESUME_SECONDS
        while True:
            try:
                return attempt()
            except HostError as error:
                # The compositor refuses before delivering anything while the owner types
                # or clicks in the client, and resumes by itself after a short idle.
                if not str(error).startswith(OWNER_PAUSED) or time.monotonic() >= give_up:
                    raise
                time.sleep(0.1)

    def enroll(self, lease, process, control):
        request = self._enrollment_request(lease, process)
        return control.execute(request, lambda: self._enroll(lease, process))

    @staticmethod
    def _enrollment_request(lease, process):
        require_budget()
        if (not isinstance(process, tuple) or len(process) != 2
                or any(type(value) is not int or value <= 0 for value in process)
                or not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.scope", lease.unit)):
            raise HostError("Enrollment requires an exact native scope and process identity")
        return f"ghost-register-scope-process {process[0]} {lease.unit}"

    def _enroll(self, lease, process):
        """Internal step of an already admitted, journaled launch operation."""
        request = self._enrollment_request(lease, process)
        if not lease.contains(process):
            raise HostError("Application is outside its native scope")
        response = self._exchange(request).strip()
        match = re.fullmatch(r"ok ([0-9a-fA-F-]{36})", response)
        if not match:
            raise HostError(response or "Empty native enrollment response")
        if not lease.contains(process):
            raise HostError("Application scope changed during enrollment")
        return match[1]
