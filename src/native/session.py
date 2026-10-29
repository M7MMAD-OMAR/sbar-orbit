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

from . import a11y
from .budget import require_budget
from .host import verify_host
from .transport import NativeTransport, action_response


class SessionError(RuntimeError):
    pass


class ApplicationControlEnded(SessionError):
    """A missing lease is not evidence that the application window disappeared."""


class OpeningDeliveryUncertain(SessionError):
    """A launch may have taken effect, so another request must not repeat it."""


class PresentationNotReady(SessionError):
    """The compositor rejected presentation before any display mutation."""


class ApplicationOwnerBusy(SessionError):
    """A client-wide handoff cannot displace the owner's real input focus."""


class ApplicationLeaseConflict(SessionError):
    """An existing lease or native capacity prevents a new client claim."""


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



    def _tree(self, target):
        """Accessibility tree of one window, or the reason there is none."""
        clients = json.loads(self.transport._exchange("j/clients"))
        identity = a11y.window_identity(clients, target["address"], target["key"][1]) if isinstance(clients, list) else None
        if identity is None:
            return {"status": "unavailable", "reason": "window process is unknown"}
        return a11y.read_tree(identity[0], identity[1], self.plan["runtime"])

    def _check_target(self, address):
        action_response("ghost-target-check", self.transport._exchange("ghost-target-check " + address))

    def _app(self, app_id):
        app = self.apps.get(identifier(app_id))
        if app is None or app.closed:
            raise SessionError("Native application is unavailable in this session")
        return app

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
        fields = {"windows": {"appId"}, "observe": {"appId", "windowId", "format"},
                  "close-window": {"appId", "windowId"}, "state": {"appId", "windowId"},
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
        if kind == "observe" and result.setdefault("format", "image") not in a11y.FORMATS:
            raise SessionError("Unknown observation format")
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
        if kind == "key":
            modifiers, separator, key = result["key"].rpartition("+")
            if key.lower() == "enter":
                result["key"] = modifiers + separator + "Return"
        return result

    def _ensure_pointer(self, target, address):
        """Visible render-only presence, with no pointer or keyboard input."""
        point = target["pointer"]
        if (point is None or not 0 <= point["x"] < target["size"][0]
                or not 0 <= point["y"] < target["size"][1]):
            point = {"x": target["size"][0] // 2, "y": target["size"][1] // 2}
        # Refresh the selected target after a sibling window or portal had the
        # latest cursor. This is render-only and cannot replay pointer input.
        self.transport._perform(f"ghost-cursor {address} {point['x']} {point['y']}")
        target["pointer"] = point
        return target["pointer"]

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
            if kind in ("key", "text", "state"):
                self._ensure_pointer(target, address)
            if kind == "observe":
                verify_host(self.plan)
                tree = None
                if action["format"] != "image":
                    tree = self._tree(target)
                    if action["format"] == "text" and tree["status"] == "ok":
                        # Text only: no pixels are captured. The surface size is the compositor's.
                        captured = int(time.time() * 1000)
                        width, height = target["size"]
                        return {"mimeType": "text/x-orbit-a11y", "capturedAt": captured,
                                "width": width, "height": height, "surfaceWidth": width, "surfaceHeight": height,
                                "cursorVariant": (int(target["address"], 16) >> 4) & 1,
                                "appId": app_id, "windowId": action["windowId"],
                                "pointer": copy.deepcopy(target["pointer"]), "tree": tree}
                environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                               "XDG_RUNTIME_DIR": self.plan["runtime"],
                               "WAYLAND_DISPLAY": str(Path(self.plan["runtime"]) / self.plan["display"])}
                for attempt in range(3):
                    self._ensure_pointer(target, address)
                    captured = int(time.time() * 1000)
                    surface_size = tuple(target["size"])
                    self._check_target(address)
                    image, width, height = bounded_capture(
                        ["/usr/bin/grim", "-T", target["key"][1], "-"], environment,
                        self._app(app_id).profile / ("capture-" + uuid.uuid4().hex + ".log"))
                    verify_host(self.plan)
                    self._target(app_id, action["windowId"])
                    self._check_target(address)
                    if tuple(target["size"]) == surface_size:
                        break
                    if attempt == 2:
                        raise SessionError("Native target keeps resizing; wait before observing again")
                    # Capture is read-only. Keep the exact lifetime-bound target
                    # and retry its new geometry, never any prior input action.
                    time.sleep(0.05)
                frame = {"mimeType": "image/png", "image": base64.b64encode(image).decode(),
                         "capturedAt": captured, "width": width, "height": height,
                         "surfaceWidth": surface_size[0], "surfaceHeight": surface_size[1],
                         "cursorVariant": (int(target["address"], 16) >> 4) & 1,
                         "appId": app_id, "windowId": action["windowId"], "pointer": copy.deepcopy(target["pointer"])}
                if tree is not None:
                    # Fallback or both: the tree status says which, including why no tree came back.
                    frame["tree"] = tree
                return {key: value for key, value in frame.items() if key != "image"} | {
                    "bytes": len(image), "sha256": hashlib.sha256(image).hexdigest()}
            if kind == "close-window":
                self.transport._perform("ghost-window-close " + address)
                return {"closeRequested": True}
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
            response = self.transport._perform(command + " " + arguments)
            if kind in ("cursor", "move", "click", "scroll"):
                target["pointer"] = {"x": action["x"], "y": action["y"]}
            return {"response": json.loads(response) if kind == "state" else response}

        result = self.control.execute(request, operation)
        return frame if frame is not None else result
