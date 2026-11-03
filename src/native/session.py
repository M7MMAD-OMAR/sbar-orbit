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
import zlib

from . import a11y
from .budget import require_budget
from .host import HostError, TargetClosed, UnsupportedText, verify_host
from .paste import paste_text
from .transport import NativeTransport, action_response


class SessionError(RuntimeError):
    pass


CAPTURE_TIMEOUT_SECONDS = 10
CAPTURE_CLEANUP_SECONDS = 3


class CaptureUnavailable(SessionError):
    def __init__(self):
        super().__init__("Native window capture is unavailable; inspect the current target before another observation")


class CaptureDeadlineExceeded(SessionError):
    def __init__(self):
        super().__init__("Native observation exceeded its capture deadline; inspect the current target before another observation")


class CaptureGeometryChanged(SessionError):
    def __init__(self):
        super().__init__("Native target geometry changed during capture; inspect the current target before another observation")


def capture_remaining(deadline):
    """Cooperative absolute budget, never a fresh per-frame wait. Blocking native/FS calls are not preempted."""
    if type(deadline) not in (int, float) or not 0 < deadline < 1e100 or not math.isfinite(deadline):
        raise CaptureDeadlineExceeded()
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CaptureDeadlineExceeded()
    return remaining


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


def raster_header(data):
    """Width, height and the offset of the pixels of a binary 8 bit PPM, strictly."""
    match = re.match(rb"P6\n([0-9]{1,5}) ([0-9]{1,5})\n255\n", bytes(data[:32]))
    if match is None:
        raise SessionError("Native window capture did not return a PPM raster")
    width, height = int(match[1]), int(match[2])
    if not 1 <= width <= 16384 or not 1 <= height <= 16384 or len(data) != match.end() + width * height * 3:
        raise SessionError("Native window capture has invalid dimensions")
    return width, height, match.end()


def cropped_png(raster, left, top, width, height):
    """A PNG of one rectangle of a PPM raster, from the standard library only."""
    full, _, offset = raster_header(raster)
    if not (0 <= left and 0 <= top and 1 <= width and 1 <= height and left + width <= full
            and top + height <= (len(raster) - offset) // (full * 3)):
        raise SessionError("Capture crop lies outside the frame")
    stride = full * 3
    rows = b"".join(b"\0" + raster[offset + y * stride + left * 3:offset + y * stride + (left + width) * 3]
                    for y in range(top, top + height))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b""))


def visible_crop(image_size, surface_size, geometry):
    """Pixel rectangle of the window geometry inside a capture that starts at the surface origin.

    Input coordinates are mapped into the geometry, so the image must start there too, or every point
    read off it lands by the client side margin away from where a click goes. The capture is only as
    large as the window, so the margin at the far edges is not in it; the crop is the part of the
    geometry the capture holds. None when the geometry starts at the origin and nothing needs cropping.
    """
    (width, height), (goal_w, goal_h), (gx, gy, gw, gh) = image_size, surface_size, geometry
    if gx == 0 and gy == 0:
        return None
    scale_x, scale_y = width / goal_w, height / goal_h
    left, top = round(gx * scale_x), round(gy * scale_y)
    crop_w, crop_h = min(round(gw * scale_x), width - left), min(round(gh * scale_y), height - top)
    if gx < 0 or gy < 0 or crop_w < 1 or crop_h < 1:
        raise SessionError("Window geometry lies outside the captured frame")
    return left, top, crop_w, crop_h


def bounded_capture(argv, environment, diagnostics, raster=False, deadline=None):
    """One absolute capture budget, plus at most 3 seconds for child kill/reap cleanup.

    The optional deadline preserves the old direct-call 10 second default. Native
    and filesystem syscalls cannot be forcibly preempted by these cooperative checks.
    """
    deadline = time.monotonic() + CAPTURE_TIMEOUT_SECONDS if deadline is None else deadline
    capture_remaining(deadline)  # Expired work must not start a child.
    child = None
    data, stderr, errors = bytearray(), bytearray(), []
    result = None
    try:
        child = subprocess.Popen(argv, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        capture_remaining(deadline)
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ, data)
            ready.register(child.stderr, selectors.EVENT_READ, stderr)
            while ready.get_map():
                events = ready.select(capture_remaining(deadline))
                if not events:
                    raise CaptureDeadlineExceeded()
                for key, _ in events:
                    capture_remaining(deadline)
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        ready.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(data) > (64 if raster else 16) * 1024 * 1024 or len(stderr) > 65536:
                        raise CaptureUnavailable()
        child.wait(timeout=capture_remaining(deadline))
        if child.returncode != 0:
            # Exit status, including empty stderr, does not identify visibility or geometry as the cause.
            raise CaptureUnavailable()
        if raster:
            width, height = raster_header(data)[:2]
        elif len(data) < 24 or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
            raise CaptureUnavailable()
        else:
            width, height = struct.unpack(">II", data[16:24])
        if not 1 <= width <= 16384 or not 1 <= height <= 16384:
            raise CaptureUnavailable()
        capture_remaining(deadline)
        result = bytes(data), width, height
    except (TimeoutError, subprocess.TimeoutExpired):
        errors.append(CaptureDeadlineExceeded())
    except (OSError, SessionError, ValueError, struct.error) as error:
        errors.append(error if isinstance(error, (CaptureUnavailable, CaptureDeadlineExceeded)) else CaptureUnavailable())
    except BaseException as error:
        errors.append(error)
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=CAPTURE_CLEANUP_SECONDS)
            except BaseException as error:
                errors.append(error)
            for stream in (child.stdout, child.stderr):
                try:
                    stream.close()
                except BaseException as error:
                    errors.append(error)
        try:
            with open(diagnostics, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as log:
                log.write(stderr)
        except BaseException as error:
            errors.append(error)
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup("Native capture or cleanup failed", errors)
    return result


class NativeSession:
    """A fixed host and controller, with no agent-facing settings mutation."""



    def _tree(self, target, deadline=None):
        """Accessibility tree of one window, or the reason there is none."""
        if deadline is not None:
            capture_remaining(deadline)
        clients = json.loads(self.transport._exchange("j/clients"))
        identity = a11y.window_identity(clients, target["address"], target["key"][1]) if isinstance(clients, list) else None
        if identity is None:
            return {"status": "unavailable", "reason": "window process is unknown"}
        host = getattr(self, "a11y_host", None)
        options = {"deadline": deadline} if deadline is not None else {}
        if host is not None:
            options["host"] = host
        tree = a11y.read_tree(identity[0], identity[1], self.plan["runtime"], **options)
        if deadline is not None:
            capture_remaining(deadline)
        current = json.loads(self.transport._exchange("j/clients"))
        after = a11y.window_identity(current, target["address"], target["key"][1]) if isinstance(current, list) else None
        if deadline is not None:
            capture_remaining(deadline)
        if after != identity:
            return {"status": "unavailable", "reason": "window identity or title changed during accessibility query"}
        return tree

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
            raise TargetClosed("The target window closed or was replaced")
        return target

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise SessionError("Native action must be an object with a type")
        fields = {"windows": {"appId"}, "observe": {"appId", "windowId", "format"},
                  "close-window": {"appId", "windowId"}, "state": {"appId", "windowId"},
                  "cursor": {"appId", "windowId", "x", "y"}, "move": {"appId", "windowId", "x", "y"},
                  "click": {"appId", "windowId", "x", "y", "button"},
                  "mouse-down": {"appId", "windowId", "x", "y", "button"},
                  "mouse-up": {"appId", "windowId", "x", "y", "button"},
                  "drag": {"appId", "windowId", "x", "y", "toX", "toY", "button"},
                  "scroll": {"appId", "windowId", "x", "y", "dy"},
                  "text": {"appId", "windowId", "text"}, "key": {"appId", "windowId", "key"}}
        fields["observe"] = fields["observe"] | {"since", "timeoutMs", "quietMs", "graceMs", "digestOnly", "observationTimeoutMs"}
        kind = value["type"]
        if kind not in fields or set(value) - (fields[kind] | {"type"}):
            raise SessionError("Unknown native action or unexpected fields")
        result = dict(value)
        identifier(result.get("appId"))
        if kind != "windows":
            identifier(result.get("windowId"))
        for field in ("x", "y", "toX", "toY"):
            if field in fields[kind]:
                coordinate(result.get(field))
        if kind == "observe" and result.setdefault("format", "image") not in a11y.FORMATS:
            raise SessionError("Unknown observation format")
        if kind == "observe":
            cls._settle_options(result)
        if kind in ("click", "mouse-down", "mouse-up", "drag"):
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

    @staticmethod
    def _settle_options(result):
        """Validate the optional settled-capture fields of an observe, and fill the defaults."""
        if "observationTimeoutMs" in result:
            if (type(result["observationTimeoutMs"]) is not int or not 100 <= result["observationTimeoutMs"] <= 3000 or
                    any(name in result for name in ("timeoutMs", "quietMs", "graceMs", "since", "digestOnly"))):
                raise SessionError("Nonsettling observation budget must be an integer from 100 to 3000 without settle options")
        if "digestOnly" in result and result["digestOnly"] is not True:
            raise SessionError("digestOnly must be true when present")
        if "since" in result and (not isinstance(result["since"], str) or not re.fullmatch(r"[0-9a-f]{64}", result["since"])):
            raise SessionError("Settled capture baseline must be a SHA-256 digest")
        for name, low, high in (("timeoutMs", 100, 3000), ("quietMs", 20, 1000), ("graceMs", 0, 2000)):
            if name in result and (type(result[name]) is not int or not low <= result[name] <= high):
                raise SessionError(f"{name} must be an integer from {low} to {high}")
        if "timeoutMs" in result:
            result.setdefault("quietMs", 100)
            result.setdefault("graceMs", 300)
        elif "since" in result or "quietMs" in result or "graceMs" in result:
            raise SessionError("Settle options require timeoutMs")

    @staticmethod
    def _settle(capture, first, action, deadline=None, started=None):
        """Re-capture until the window stops changing, bounded by timeoutMs.

        Two identical frames are not enough: a slow redraw leaves two identical OLD frames. With a
        baseline digest the frame must first differ from it and then hold still for quietMs. A frame
        that never leaves the baseline is returned after graceMs with changed false, which is what a
        move or a click on nothing really looks like. Every outcome is reported, never assumed.
        Frames are taken back to back: a capture itself takes 25 to 70 ms, so a pause between them
        only delays the answer.
        """
        since = action.get("since")
        started = time.monotonic() if started is None else started
        limit, quiet, grace = action["timeoutMs"] / 1000, action["quietMs"] / 1000, action["graceMs"] / 1000
        deadline = started + limit if deadline is None else deadline
        current, captures = first, 1
        digest = hashlib.sha256(current[0]).hexdigest()
        stable_since = time.monotonic()
        while True:
            now = time.monotonic()
            changed = None if since is None else digest != since
            if changed is False:
                ready = now - started >= grace
            else:
                ready = now - stable_since >= quiet
            if ready or now >= deadline:
                return (*current, {"settled": bool(ready), "changed": changed, "captures": captures,
                                   "waitedMs": int((now - started) * 1000)})
            current = capture()
            captures += 1
            latest = hashlib.sha256(current[0]).hexdigest()
            if latest != digest:
                digest, stable_since = latest, time.monotonic()

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

    def _geometry(self, address):
        """The window geometry rectangle inside its surface, or None when the compositor does not say."""
        try:
            geometry = json.loads(self.transport._perform("ghost-state " + address)).get("geometry")
        except TargetClosed:
            raise
        except (HostError, ValueError):
            return None  # not an XDG toplevel, or no readable state: capture it uncropped, as before
        if (not isinstance(geometry, list) or len(geometry) != 4
                or any(type(value) not in (int, float) for value in geometry) or geometry[2] <= 0 or geometry[3] <= 0):
            return None
        return tuple(geometry)

    def _await_drag(self, address):
        """The compositor times a click and runs a drag on its own loop; return once it is done."""
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            state = json.loads(self.transport._perform("ghost-state " + address))
            if not state.get("motion_active"):
                return
            time.sleep(min(max(state.get("motion_ms", 0), 10), 100) / 1000)
        raise SessionError("Native pointer action did not finish; a held button is released by the compositor timeout")

    def execute(self, value):
        started = time.monotonic()
        require_budget()
        if self.closed:
            raise SessionError("Native session is closed")
        action = self.parse(value)
        request = "native-session " + json.dumps(action, sort_keys=True, ensure_ascii=True)
        frame = None
        observation_deadline = (started + action.get("observationTimeoutMs", action.get("timeoutMs", CAPTURE_TIMEOUT_SECONDS * 1000)) / 1000
                                if action["type"] == "observe" else None)

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
                capture_remaining(observation_deadline)
                verify_host(self.plan)
                tree = None
                if action["format"] != "image":
                    tree_size = tuple(target["size"])
                    tree = self._tree(target, deadline=observation_deadline)
                    after_tree = self._target(app_id, action["windowId"])
                    capture_remaining(observation_deadline)
                    if tree.get("status") == "ok" and tuple(after_tree["size"]) != tree_size:
                        raise CaptureGeometryChanged()
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

                def begin():
                    """Everything before the pixels leave the compositor, then the capture itself."""
                    capture_remaining(observation_deadline)
                    self._ensure_pointer(target, address)
                    captured = int(time.time() * 1000)
                    surface_size = tuple(target["size"])
                    self._check_target(address)
                    log = self._app(app_id).profile / ("capture-" + uuid.uuid4().hex + ".log")
                    geometry = self._geometry(address)
                    # A window with a client side margin is cropped, so it needs raw pixels to cut from.
                    margin = geometry is not None and (geometry[0] != 0 or geometry[1] != 0)
                    arguments = (["/usr/bin/grim"] + (["-t", "ppm"] if margin else []) + ["-T", target["key"][1], "-"],
                                 environment, log, margin)
                    return bounded_capture(*arguments, deadline=observation_deadline), captured, surface_size, geometry

                def finish(handle):
                    """Verify target size and reliable crop geometry before using the captured frame."""
                    capture_remaining(observation_deadline)
                    pixels, captured, surface_size, geometry = handle
                    image, width, height = pixels
                    verify_host(self.plan)
                    self._target(app_id, action["windowId"])
                    self._check_target(address)
                    after_geometry = self._geometry(address)
                    capture_remaining(observation_deadline)
                    if (geometry is None) != (after_geometry is None):
                        # Availability changed, not reliable evidence of a geometry transition.
                        raise CaptureUnavailable()
                    if tuple(target["size"]) != surface_size or (geometry is not None and after_geometry != geometry):
                        return None
                    crop = visible_crop((width, height), surface_size, geometry) if geometry is not None else None
                    if crop is not None:
                        # Image pixel (x, y) is now input coordinate (x, y) divided by the scale, as on any window.
                        image = cropped_png(image, *crop)
                        scale = width / surface_size[0]
                        width, height = crop[2], crop[3]
                        surface_size = (round(width / scale, 3), round(height / scale, 3))
                    return image, width, height, captured, surface_size

                def capture():
                    for attempt in range(3):
                        frame = finish(begin())
                        if frame is not None:
                            return frame
                        if attempt == 2:
                            raise CaptureGeometryChanged()
                        # Capture is read-only. Keep the exact lifetime-bound target
                        # and retry its new geometry, never any prior input action.
                        time.sleep(min(0.05, capture_remaining(observation_deadline)))

                image, width, height, captured, surface_size = capture()
                if action.get("digestOnly"):
                    # A baseline for a later settled capture: a digest and no pixels leave the worker.
                    return {"appId": app_id, "windowId": action["windowId"], "width": width, "height": height,
                            "bytes": len(image), "sha256": hashlib.sha256(image).hexdigest()}
                settle = None
                if "timeoutMs" in action:
                    image, width, height, captured, surface_size, settle = self._settle(
                        capture, (image, width, height, captured, surface_size), action,
                        deadline=observation_deadline, started=started)
                frame = {"mimeType": "image/png", "image": base64.b64encode(image).decode(),
                         "capturedAt": captured, "width": width, "height": height,
                         "surfaceWidth": surface_size[0], "surfaceHeight": surface_size[1],
                         "cursorVariant": (int(target["address"], 16) >> 4) & 1,
                         "appId": app_id, "windowId": action["windowId"], "pointer": copy.deepcopy(target["pointer"])}
                if settle is not None:
                    frame["settle"] = settle
                if tree is not None:
                    # Fallback or both: the tree status says which, including why no tree came back.
                    frame["tree"] = tree
                return {key: value for key, value in frame.items() if key != "image"} | {
                    "bytes": len(image), "sha256": hashlib.sha256(image).hexdigest()}
            if kind == "close-window":
                self.transport._perform("ghost-window-close " + address)
                return {"closeRequested": True}
            if kind in ("cursor", "move", "click", "scroll", "mouse-down", "mouse-up", "drag"):
                if action["x"] >= target["size"][0] or action["y"] >= target["size"][1]:
                    raise SessionError("Native coordinates lie outside the target surface")
                arguments = f"{address} {action['x']} {action['y']}"
                if kind == "drag":
                    if action["toX"] >= target["size"][0] or action["toY"] >= target["size"][1]:
                        raise SessionError("Native coordinates lie outside the target surface")
                    arguments += f" {action['toX']} {action['toY']}"
                if kind in ("click", "mouse-down", "mouse-up", "drag"):
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
            try:
                response = self.transport._perform(command + " " + arguments)
            except UnsupportedText:
                if kind != "text":
                    raise
                response = paste_text(self.plan, action["text"], lambda: self.transport._perform("ghost-key " + address + " ctrl+v"))
            if kind in ("click", "mouse-up", "drag"):
                self._await_drag(address)
            if kind in ("cursor", "move", "click", "scroll", "mouse-down", "mouse-up", "drag"):
                target["pointer"] = ({"x": action["toX"], "y": action["toY"]} if kind == "drag"
                                     else {"x": action["x"], "y": action["y"]})
            return {"response": json.loads(response) if kind == "state" else response}

        def admitted_operation():
            result = operation()
            if action["type"] == "observe":
                capture_remaining(observation_deadline)
            if action["type"] == "observe" and not action.get("digestOnly"):
                # Same scoped post-capture refresh as the old separate windows request,
                # but under this read admission and without another worker round trip.
                acknowledged = frame if frame is not None else result
                acknowledged["windows"] = self._owned_windows(action["appId"])
                capture_remaining(observation_deadline)
            return result

        result = self.control.execute(request, admitted_operation)
        observed = frame if frame is not None else result
        if action["type"] == "observe":
            # Local worker cost only, not model latency or evidence of application acceptance.
            tree = observed.get("tree")
            nodes = tree.get("nodes", []) if isinstance(tree, dict) and tree.get("status") == "ok" else None
            encoded_image = observed.get("image", "")
            observed["observation"] = {
                "requestedFormat": action["format"],
                "returnedFormat": "text" if observed.get("mimeType") == "text/x-orbit-a11y" else "image",
                "workerMs": round((time.monotonic() - started) * 1000, 3),
                "imageBytes": len(encoded_image) * 3 // 4 - (len(encoded_image) - len(encoded_image.rstrip("="))),
                "treeBytes": len(json.dumps(nodes, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) if nodes is not None else 0,
                "treeNodes": len(nodes) if nodes is not None else 0,
                "treeComplete": tree.get("complete") is True if nodes is not None else None,
            }
        return observed
