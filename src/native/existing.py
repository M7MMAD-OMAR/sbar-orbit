"""Borrow a live application without launching, moving, or closing it."""
import copy
import json
import math
import os
from pathlib import Path
import re
import threading
from types import SimpleNamespace
import uuid

from .application import private_directory
from .handoff_release import require_owner_handoff
from .budget import require_budget
from .session import NativeSession, SessionError, identifier
from .transport import NativeTransport, action_response


class ExistingApplicationSession(NativeSession):
    def open(self, value):
        from .owner_open import open_application
        with self.lock:
            if self.closed or self.lease_id is not None:
                raise SessionError("Open an application before claiming its session")
            return open_application(self, value)

    def __init__(self, plan, directory, control):
        self.plan = copy.deepcopy(plan)
        self.directory = private_directory(directory)
        self.control = control
        self.transport = NativeTransport(self.plan)
        self.apps, self.windows = {}, {}
        self.closed = False
        self.lease_id = None
        self.lock = threading.RLock()

    @staticmethod
    def selection(value):
        if not isinstance(value, dict) or set(value) - {"workspace", "address", "stableId"}:
            raise SessionError("Invalid existing application selection")
        workspace = value.get("workspace")
        if type(workspace) is not int or not 1 <= workspace <= 2147483647:
            raise SessionError("Handoff requires a positive workspace number")
        if ("address" in value) != ("stableId" in value):
            raise SessionError("Select both the exact window address and stable identity")
        if "address" in value and (not isinstance(value["address"], str)
                or not re.fullmatch(r"0x[0-9a-f]{1,16}", value["address"])
                or not isinstance(value["stableId"], str)
                or not re.fullmatch(r"[0-9a-f]{1,16}", value["stableId"])):
            raise SessionError("Invalid existing window identity")
        return dict(value)

    def candidates(self, value):
        require_budget()
        selection = self.selection(value)
        clients = json.loads(self.transport._exchange("j/clients"))
        if not isinstance(clients, list) or len(clients) > 4096:
            raise SessionError("Invalid compositor window list")
        result = []
        for client in clients:
            if not isinstance(client, dict):
                raise SessionError("Invalid compositor window metadata")
            if client.get("workspace", {}).get("id") != selection["workspace"]:
                continue
            address, stable = client.get("address"), client.get("stableId")
            if (not isinstance(address, str) or not re.fullmatch(r"0x[0-9a-f]{1,16}", address)
                    or not isinstance(stable, str) or not re.fullmatch(r"[0-9a-f]{1,16}", stable)):
                raise SessionError("Compositor returned an invalid existing window identity")
            if "address" in selection and (address != selection["address"] or stable != selection["stableId"]):
                continue
            result.append({"address": address, "stableId": stable,
                           "title": str(client.get("title", ""))[:160], "xwayland": bool(client.get("xwayland"))})
            if len(result) > 64:
                raise SessionError("Workspace contains too many handoff candidates")
        return {"workspace": selection["workspace"], "candidates": result}

    def _info(self):
        if self.lease_id is None:
            raise SessionError("No application has been handed off")
        reply = json.loads(self.transport._exchange("ghost-application-info " + self.lease_id))
        if (not isinstance(reply, dict) or reply.get("schema") != 1
                or reply.get("lease_id") != self.lease_id
                or reply.get("status") not in ("active", "paused", "unavailable")
                or not isinstance(reply.get("windows"), list) or len(reply["windows"]) > 64):
            raise SessionError("Invalid compositor application lease response")
        if reply["status"] != "unavailable" and reply.get("scope") != "entire-wayland-client":
            raise SessionError("Compositor changed the application scope")
        return reply

    def claim(self, value):
        require_owner_handoff()
        require_budget()
        with self.lock:
            if self.closed or self.lease_id is not None:
                raise SessionError("Existing application session already claimed or closed")
            selection = self.selection(value)
            candidates = self.candidates(selection)["candidates"]
            if len(candidates) != 1:
                raise SessionError("Workspace handoff requires one exact selected window; list candidates first")
            selected = candidates[0]
            lease_id = uuid.uuid4().hex
            self.lease_id = lease_id
            pending = self.directory / "handoff.json"
            with pending.open("x", encoding="utf-8") as stream:
                os.chmod(pending, 0o600)
                json.dump({"lease_id": lease_id, "selection": selection}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            request = "native-handoff " + json.dumps({"workspace": selection["workspace"],
                "address": selected["address"], "stableId": selected["stableId"]}, sort_keys=True)

            def operation():
                command = f"ghost-application-claim {selected['address']} {selected['stableId']} {lease_id}"
                raw = self.transport._exchange(command)
                if raw.startswith("refused:"):
                    raise SessionError("Application handoff " + raw[:300])
                reply = json.loads(raw)
                if (not isinstance(reply, dict) or reply.get("schema") != 1
                        or reply.get("lease_id") != lease_id or reply.get("status") != "claimed"
                        or reply.get("scope") != "entire-wayland-client"
                        or type(reply.get("windows")) is not int or not 1 <= reply["windows"] <= 64):
                    raise SessionError("Application handoff failed; retained identity needs cleanup")
                self.apps[lease_id] = SimpleNamespace(unit="lease-" + lease_id, profile=self.directory, closed=False)
                windows = self._owned_windows(lease_id)
                selected_window = next((window["windowId"] for window in windows
                    if self.windows[window["windowId"]]["key"][1] == selected["stableId"]), None)
                if selected_window is None:
                    raise SessionError("Selected window disappeared during application handoff")
                return {"appId": lease_id, "selectedWindowId": selected_window, "scope": reply["scope"], "windows": windows}

            return self.control.execute(request, operation)

    def _owned_windows(self, app_id):
        self._app(app_id)
        info = self._info()
        if info["status"] == "unavailable":
            raise SessionError("Application handoff is no longer live")
        clients = json.loads(self.transport._exchange("j/clients"))
        if not isinstance(clients, list) or len(clients) > 4096:
            raise SessionError("Invalid compositor window list")
        metadata = {(entry.get("address"), entry.get("stableId")): entry for entry in clients if isinstance(entry, dict)}
        result = []
        for window in info["windows"]:
            if not isinstance(window, dict):
                raise SessionError("Invalid leased window")
            address, stable = window.get("address"), window.get("stable")
            if (not isinstance(address, str) or not re.fullmatch(r"0x[0-9a-f]{1,16}", address)
                    or not isinstance(stable, str) or not re.fullmatch(r"[0-9a-f]{1,16}", stable)
                    or window.get("target") != f"{address}@{stable}@lease-{self.lease_id}"):
                raise SessionError("Invalid leased window target")
            client = metadata.get((address, stable))
            if client is None:
                raise SessionError("Leased window lifetime changed")
            size = client.get("size")
            if (not isinstance(size, list) or len(size) != 2
                    or any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in size)):
                raise SessionError("Invalid leased window size")
            key = (app_id, stable, self.lease_id)
            window_id = next((identity for identity, target in self.windows.items() if target["key"] == key), None)
            if window_id is None:
                window_id = uuid.uuid4().hex
                self.windows[window_id] = {"key": key, "address": address, "size": size, "pointer": None}
            elif self.windows[window_id]["address"] != address:
                raise SessionError("Leased window identity changed")
            self.windows[window_id]["size"] = size
            pointer = self.windows[window_id]["pointer"]
            if pointer is not None and (pointer["x"] >= size[0] or pointer["y"] >= size[1]):
                self.windows[window_id]["pointer"] = None
            result.append({"appId": app_id, "windowId": window_id,
                           "title": str(client.get("title", ""))[:160], "width": size[0], "height": size[1]})
        return result

    def execute(self, value):
        require_owner_handoff()
        with self.lock:
            return super().execute(value)

    def set_paused(self, paused):
        if not paused:
            require_owner_handoff()
        require_budget()
        with self.lock:
            if self.closed or self.lease_id is None:
                raise SessionError("Application handoff is unavailable")
            operation = "pause" if paused else "resume"
            request = f"ghost-application-control {self.lease_id} {operation}"
            action = lambda: action_response("application-control", self.transport._exchange(request))
            return self.control.cleanup(request, action) if paused else self.control.execute(request, action)

    def launch(self, *args, **kwargs):
        raise SessionError("An existing application session cannot launch applications")

    def close_application(self, app_id):
        identifier(app_id)
        if app_id != self.lease_id:
            raise SessionError("Application belongs to another handoff")
        self.close()

    def close(self):
        with self.lock:
            if self.closed:
                return
            if self.lease_id is not None:
                lease_id = self.lease_id

                def handback():
                    info = self._info()
                    if info["status"] != "unavailable":
                        action_response("application-control", self.transport._exchange(
                            f"ghost-application-control {lease_id} handback"))
                    action_response("application-reap", self.transport._exchange("ghost-application-reap " + lease_id))
                    return {"handedBack": True, "applicationClosed": False}

                self.control.cleanup("native-handoff-close " + lease_id, handback)
                (self.directory / "handoff.json").unlink(missing_ok=True)
                self.lease_id = None
            self.apps.clear()
            self.windows.clear()
            self.closed = True
