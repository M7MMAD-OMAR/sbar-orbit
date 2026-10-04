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

from .host import HostError, metadata, peer, verify_host
from .budget import require_budget


ACTIONS = frozenset({"ghost-key", "ghost-type", "ghost-texthex", "ghost-click", "ghost-move", "ghost-target-check",
                     "ghost-scroll", "ghost-cursor", "ghost-hide-cursor", "ghost-release", "ghost-state"})


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
    if response == "ok" and command != "ghost-state":
        return response
    if command in ("ghost-type", "ghost-texthex") and re.fullmatch(r"ok \d+ keys", response):
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
    raise HostError(response or "Empty native plugin response")


class NativeTransport:
    def __init__(self, plan):
        self._plan = copy.deepcopy(plan)
        verify_host(self._plan)

    def _exchange(self, request):
        plan = self._plan
        verify_host(plan)
        path = Path(plan["runtime"]) / "hypr" / plan["signature"] / ".socket.sock"
        deadline = time.monotonic() + 3
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(path))
            if metadata(path) != plan["ipc_socket"] or peer(connection) != plan["compositor"]:
                raise HostError("Compositor changed before native request")
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
        verify_host(plan)
        return response.decode("utf-8")

    def execute(self, request, control):
        require_budget()
        command = action_request(request)
        return control.execute(request, lambda: action_response(command, self._exchange(request)))

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
