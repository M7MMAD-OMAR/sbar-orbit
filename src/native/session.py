"""Cooperative native session routing through owned applications and windows."""
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import struct
import subprocess
import time
import uuid

from .application import NativeLauncher, private_directory
from .budget import require_budget
from .host import verify_host
from .lease import process_identity
from .transport import NativeTransport, action_response


class SessionError(RuntimeError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise SessionError("Invalid generated native identifier")
    return value


def coordinate(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 32768:
        raise SessionError("Native coordinates must be finite surface-local numbers")
    return value


def bounded_capture(argv, environment, diagnostics):
    """Retain one bounded PNG and private stderr, with bounded reap attempts."""
    child = subprocess.Popen(argv, env=environment, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    data, stderr, errors = bytearray(), bytearray(), []
    result = None
    try:
        deadline = time.monotonic() + 10
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ, data)
            ready.register(child.stderr, selectors.EVENT_READ, stderr)
            while ready.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Native window capture exceeded its deadline")
                events = ready.select(remaining)
                if not events:
                    raise TimeoutError("Native window capture exceeded its deadline")
                for key, _ in events:
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        ready.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(data) > 16 * 1024 * 1024 or len(stderr) > 65536:
                        raise SessionError("Native window capture output is too large")
        child.wait(timeout=max(0.01, deadline - time.monotonic()))
        if child.returncode != 0:
            raise SessionError("Native window capture failed")
        if len(data) < 24 or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
            raise SessionError("Native window capture did not return PNG")
        width, height = struct.unpack(">II", data[16:24])
        if not 1 <= width <= 16384 or not 1 <= height <= 16384:
            raise SessionError("Native window capture has invalid dimensions")
        result = bytes(data), width, height
    except BaseException as error:
        errors.append(error)
    finally:
        try:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
        except BaseException as error:
            errors.append(error)
        finally:
            child.stdout.close()
            child.stderr.close()
        try:
            with open(diagnostics, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as log:
                log.write(stderr)
        except BaseException as error:
            errors.append(error)
    if errors:
        raise BaseExceptionGroup("Native capture or cleanup failed", errors)
    return result


class NativeSession:
    """A fixed host and controller, with no agent-facing settings mutation."""
    def __init__(self, plan, directory, control):
        self.plan = copy.deepcopy(plan)
        self.directory = private_directory(directory)
        self.control = control
        self.transport = NativeTransport(self.plan)
        self.launcher = NativeLauncher(self.plan, self.directory, control)
        self.apps, self.windows = {}, {}
        self.closed = False

    def _app(self, app_id):
        app = self.apps.get(identifier(app_id))
        if app is None or app.closed:
            raise SessionError("Native application is unavailable in this session")
        return app

    def _owned_windows(self, app_id):
        app = self._app(app_id)
        members = app.lease.members()
        clients = json.loads(self.transport._exchange("j/clients"))
        if not isinstance(clients, list):
            raise SessionError("Compositor returned invalid window data")
        result = []
        for client in clients:
            if not isinstance(client, dict) or type(client.get("pid")) is not int:
                raise SessionError("Compositor returned invalid window identity")
            process = process_identity(client["pid"])
            if process not in members or not app.lease._contains(process):
                continue
            if (not isinstance(client.get("workspace"), dict)
                    or client["workspace"].get("name") != "special:ghost"):
                raise SessionError("Owned native window left the agent workspace")
            if (not re.fullmatch(r"0x[0-9a-fA-F]+", str(client.get("address", "")))
                    or not isinstance(client.get("stableId"), str)
                    or not re.fullmatch(r"[0-9a-f]{1,16}", client["stableId"])):
                raise SessionError("Compositor returned invalid target identifiers")
            size = client.get("size")
            if (not isinstance(size, list) or len(size) != 2
                    or any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in size)):
                raise SessionError("Native target has invalid surface size")
            self._check_target(client["address"] + "@" + client["stableId"] + "@" + app.unit)
            key = (app_id, client["stableId"], process)
            window_id = next((value for value, target in self.windows.items() if target["key"] == key), None)
            if window_id is None:
                window_id = uuid.uuid4().hex
                self.windows[window_id] = {"key": key, "address": client["address"], "size": size, "pointer": None}
            elif self.windows[window_id]["address"] != client["address"]:
                raise SessionError("Native target address changed for a retained identity")
            self.windows[window_id]["size"] = size
            pointer = self.windows[window_id]["pointer"]
            if pointer is not None and (pointer["x"] >= size[0] or pointer["y"] >= size[1]):
                self.windows[window_id]["pointer"] = None
            result.append({"windowId": window_id, "appId": app_id, "title": str(client.get("title", ""))[:160],
                           "width": size[0], "height": size[1]})
        app.lease.verify()
        return result

    def _check_target(self, address):
        action_response("ghost-target-check", self.transport._exchange("ghost-target-check " + address))

    def _target(self, app_id, window_id):
        window_id = identifier(window_id)
        target = self.windows.get(window_id)
        if target is None or target["key"][0] != app_id:
            raise SessionError("Window does not belong to the requested native application")
        if not any(window["windowId"] == window_id for window in self._owned_windows(app_id)):
            raise SessionError("Native window identity is no longer live")
        return target

    @staticmethod
    def parse(value):
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise SessionError("Native action must be an object with a type")
        fields = {"windows": {"appId"}, "observe": {"appId", "windowId"},
                  "state": {"appId", "windowId"}, "hide-cursor": {"appId", "windowId"},
                  "cursor": {"appId", "windowId", "x", "y"}, "move": {"appId", "windowId", "x", "y"},
                  "click": {"appId", "windowId", "x", "y", "button"},
                  "scroll": {"appId", "windowId", "x", "y", "dy"},
                  "text": {"appId", "windowId", "text"}, "key": {"appId", "windowId", "key"}}
        kind = value["type"]
        if kind not in fields or set(value) - (fields[kind] | {"type"}):
            raise SessionError("Unknown native action or unexpected fields")
        result = dict(value)
        identifier(result.get("appId"))
        if kind != "windows":
            identifier(result.get("windowId"))
        for field in ("x", "y"):
            if field in fields[kind]:
                coordinate(result.get(field))
        if kind == "click":
            result.setdefault("button", "left")
            if result["button"] not in ("left", "middle", "right"):
                raise SessionError("Unknown native pointer button")
        if kind == "scroll":
            dy = result.get("dy")
            if type(dy) is not int or dy == 0 or not -1000 <= dy <= 1000:
                raise SessionError("Invalid native scroll distance")
        if kind == "text":
            text = result.get("text")
            if not isinstance(text, str) or "\0" in text or not 1 <= len(text.encode()) <= 16000:
                raise SessionError("Native text requires 1 to 16000 UTF-8 bytes")
        if kind == "key" and (not isinstance(result.get("key"), str)
                              or not re.fullmatch(r"[A-Za-z0-9_+.-]{1,80}", result["key"])):
            raise SessionError("Invalid native key combination")
        return result

    def execute(self, value):
        require_budget()
        if self.closed:
            raise SessionError("Native session is closed")
        action = self.parse(value)
        request = "native-session " + json.dumps(action, sort_keys=True, ensure_ascii=True)
        frame = None

        def operation():
            nonlocal frame
            app_id, kind = action["appId"], action["type"]
            if kind == "windows":
                return {"windows": self._owned_windows(app_id)}
            target = self._target(app_id, action["windowId"])
            address = target["address"] + "@" + target["key"][1] + "@" + self._app(app_id).unit
            if kind == "observe":
                verify_host(self.plan)
                environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                               "XDG_RUNTIME_DIR": self.plan["runtime"],
                               "WAYLAND_DISPLAY": str(Path(self.plan["runtime"]) / self.plan["display"])}
                captured = int(time.time() * 1000)
                surface_size = tuple(target["size"])
                self._check_target(address)
                image, width, height = bounded_capture(
                    ["/usr/bin/grim", "-T", target["key"][1], "-"], environment,
                    self._app(app_id).profile / ("capture-" + uuid.uuid4().hex + ".log"))
                verify_host(self.plan)
                self._target(app_id, action["windowId"])
                self._check_target(address)
                if tuple(target["size"]) != surface_size:
                    raise SessionError("Native target resized during capture")
                frame = {"mimeType": "image/png", "image": base64.b64encode(image).decode(),
                         "capturedAt": captured, "width": width, "height": height,
                         "surfaceWidth": surface_size[0], "surfaceHeight": surface_size[1],
                         "cursorVariant": (int(target["address"], 16) >> 4) & 1,
                         "appId": app_id, "windowId": action["windowId"], "pointer": copy.deepcopy(target["pointer"])}
                return {key: value for key, value in frame.items() if key != "image"} | {
                    "bytes": len(image), "sha256": hashlib.sha256(image).hexdigest()}
            if kind in ("cursor", "move", "click", "scroll"):
                if action["x"] >= target["size"][0] or action["y"] >= target["size"][1]:
                    raise SessionError("Native coordinates lie outside the target surface")
                arguments = f"{address} {action['x']} {action['y']}"
                if kind == "click":
                    arguments += " " + str({"left": 1, "right": 2, "middle": 3}[action["button"]])
                elif kind == "scroll":
                    arguments += " " + str(action["dy"])
                command = "ghost-" + kind
            elif kind == "text":
                command, arguments = "ghost-texthex", address + " " + action["text"].encode().hex()
            elif kind == "key":
                command, arguments = "ghost-key", address + " " + action["key"]
            else:
                command, arguments = "ghost-" + kind, address
            response = action_response(command, self.transport._exchange(command + " " + arguments))
            if kind in ("cursor", "move", "click", "scroll"):
                target["pointer"] = {"x": action["x"], "y": action["y"]}
            elif kind == "hide-cursor":
                target["pointer"] = None
            return {"response": json.loads(response) if kind == "state" else response}

        result = self.control.execute(request, operation)
        return frame if frame is not None else result

    def launch(self, argv, configuration=None):
        if self.closed:
            raise SessionError("Native session is closed")
        if len(self.apps) >= 32:
            raise SessionError("Native session application limit reached")
        app = self.launcher.launch(argv, configuration)
        app_id = uuid.uuid4().hex
        self.apps[app_id] = app
        return {"appId": app_id, "unit": app.unit}

    def close_application(self, app_id):
        self._app(app_id).close()

    def close(self):
        errors = []
        for app in reversed(list(self.apps.values())):
            try:
                app.close()
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("Native session cleanup failed", errors)
        self.closed = True
