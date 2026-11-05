"""Bounded native helper protocol shared by macOS and owned provider fixtures.

No global pointer/key injection exists. Semantic mutations retain provider objects,
use current lease/pause checks and the ordinary owner action controller. Remote
execution after a lost acknowledgement remains uncertain and is never replayed.
"""
import base64
import hashlib
import json
import re
import sys
import time
import uuid

ID = re.compile(r"[0-9a-f]{32}\Z")
REF = re.compile(r"@([0-9a-f]{32}):e([0-9]{1,3})\Z")


class PlatformError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def exact(value, keys, required=()):
    if type(value) is not dict or set(value) - set(keys) or set(required) - set(value):
        raise PlatformError("INVALID_REQUEST")
    return value


def selected_workspace(value):
    if type(value) is not int or value != 1:
        # Public virtual-desktop/Spaces placement is not invented from a label.
        raise PlatformError("UNSUPPORTED")


class PlatformSession:
    def __init__(self, provider, control, clock=time.monotonic):
        self.provider, self.control, self.clock = provider, control, clock
        self.binding = self.window = self.app_id = self.window_id = None
        self.snapshots = {}
        self.paused = self.closed = False

    def _release_refs(self):
        for _, handles in self.snapshots.values():
            for handle in handles:
                self.provider.release_ref(handle)
        self.snapshots.clear()

    def close(self):
        self.closed = True
        self._release_refs()
        if self.binding is not None:
            self.provider.release(self.binding)
            self.binding = None

    def _target(self, params):
        if self.closed or self.binding is None:
            raise PlatformError("SESSION_CLOSED")
        if params.get("appId") != self.app_id or params.get("windowId") != self.window_id:
            raise PlatformError("INVALID_REQUEST")
        current = self.provider.current(self.binding)
        if current["stableId"] != self.window["stableId"]:
            self._release_refs()
            raise PlatformError("TARGET_CLOSED")
        self.window = dict(current)
        return current

    def _windows(self):
        current = self._target({"appId": self.app_id, "windowId": self.window_id})
        return [{"appId": self.app_id, "windowId": self.window_id, "title": current["title"], "width": current["width"], "height": current["height"]}]

    def _ref(self, value):
        match = REF.fullmatch(value) if type(value) is str else None
        if match is None:
            raise PlatformError("INVALID_REQUEST")
        entry = self.snapshots.get(match[1])
        if entry is None or self.clock() >= entry[0] or int(match[2]) >= len(entry[1]):
            raise PlatformError("STALE_REF")
        handle = entry[1][int(match[2])]
        try:
            current = self.provider.ref_current(self.binding, handle)
        except Exception:
            current = False
        if not current or self.clock() >= entry[0]:
            self._release_refs()
            raise PlatformError("STALE_REF")
        return handle

    def _mutate(self, params, operation):
        if not self.provider.indicator_ready() or not self.provider.window_lifetime_qualified():
            raise PlatformError("UNSUPPORTED")
        def admitted():
            self._target(params)
            if self.paused:
                raise PlatformError("SESSION_PAUSED")
            if self.provider.owner_input_recent():
                raise PlatformError("OWNER_BUSY")
            try:
                return operation()
            except PlatformError:
                raise
            except Exception:
                raise PlatformError("NATIVE_DELIVERY_UNCERTAIN") from None
        if self.paused:
            raise PlatformError("SESSION_PAUSED")
        # Neither private text nor provider return values enter the owner journal.
        digest = hashlib.sha256(json.dumps(params, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return self.control.execute("platform-action " + digest, admitted)

    def request(self, method, params):
        if self.closed:
            raise PlatformError("SESSION_CLOSED")
        if method == "status":
            exact(params, ())
            mutations = self.provider.indicator_ready() and self.provider.window_lifetime_qualified()
            return {"ready": self.provider.ready(), "platform": self.provider.platform,
                    "scope": "selected-platform-window", "workspaceKind": "current-visible-desktop",
                    "clipboard": "not-accessed",
                    "capabilities": ["windows", "state", "observe", "close-application", "pause", "resume", "stop"] + (["ref-click", "ref-set-value", "close-window"] if mutations else []),
                    "pointerInput": False, "keyInput": False, "indicator": "not-qualified", "nativeAcceptance": "unmeasured"}
        if method == "candidates":
            exact(params, ("workspace", "address", "stableId"), ("workspace",))
            selected_workspace(params["workspace"])
            rows = self.provider.candidates()
            if len(rows) > 256:
                raise PlatformError("LIMIT_REACHED")
            return {"workspace": 1, "workspaceKind": "current-visible-desktop", "candidates": [row for row in rows
                    if ("address" not in params or row["address"] == params["address"])
                    and ("stableId" not in params or row["stableId"] == params["stableId"])]}
        if method == "claim":
            exact(params, ("workspace", "address", "stableId"), ("workspace", "address", "stableId"))
            selected_workspace(params["workspace"])
            if not self.provider.window_lifetime_qualified():
                raise PlatformError("UNSUPPORTED")
            if self.binding is not None:
                raise PlatformError("APPLICATION_BUSY")
            rows = [row for row in self.provider.candidates() if row["address"] == params["address"] and row["stableId"] == params["stableId"]]
            if len(rows) != 1:
                raise PlatformError("TARGET_CLOSED")
            self.window = dict(rows[0])
            self.binding = self.provider.bind(self.window)
            self.app_id, self.window_id = uuid.uuid4().hex, uuid.uuid4().hex
            windows = self._windows()
            return {"appId": self.app_id, "selectedWindowId": self.window_id, "scope": "selected-platform-window", "clipboard": "not-accessed",
                    "windowEnrollment": "selected-window", "pointer": None, "windows": windows}
        if method in ("pause", "resume"):
            exact(params, ())
            self.paused = method == "pause"
            self._release_refs()
            return {"paused": self.paused}
        if method == "monitors":
            exact(params, ())
            return self.provider.monitors()
        if method == "present":
            raise PlatformError("UNSUPPORTED")
        if method == "open":
            if not self.provider.indicator_ready() or not self.provider.window_lifetime_qualified():
                raise PlatformError("UNSUPPORTED")
            exact(params, ("workspace", "registration", "window"), ("workspace", "registration"))
            selected_workspace(params["workspace"])
            if self.paused:
                raise PlatformError("SESSION_PAUSED")
            exact(params["registration"], ("applicationId", "executable", "bundlePath"), ("applicationId", "executable"))
            if "window" in params:
                window = exact(params["window"], ("width", "height"), ("width", "height"))
                if any(type(window[key]) is not int or not 200 <= window[key] <= 8192 for key in window):
                    raise PlatformError("INVALID_REQUEST")
            published = {}
            def opening():
                try:
                    if self.paused:
                        raise PlatformError("SESSION_PAUSED")
                    published["result"] = self.provider.open(params["registration"], params.get("window"))
                    return {"openingAttempted": True}
                except PlatformError:
                    raise
                except Exception:
                    raise PlatformError("OPENING_UNCERTAIN") from None
            self.control.execute("platform-open " + hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest(), opening)
            return published["result"]
        if method == "close-application":
            exact(params, ("appId",), ("appId",))
            if params["appId"] != self.app_id:
                raise PlatformError("INVALID_REQUEST")
            self.close()
            return {"handedBack": True}
        if method != "act":
            raise PlatformError("UNSUPPORTED")
        action = params.get("type")
        fields = {"windows": ("type", "appId"), "state": ("type", "appId", "windowId"),
                  "observe": ("type", "appId", "windowId", "format", "refs", "digestOnly", "observationTimeoutMs"),
                  "ref-click": ("type", "appId", "windowId", "ref", "button"),
                  "ref-set-value": ("type", "appId", "windowId", "ref", "text"), "close-window": ("type", "appId", "windowId")}
        if action not in fields:
            raise PlatformError("UNSUPPORTED")
        exact(params, fields[action], ("type", "appId"))
        if action == "windows":
            if params["appId"] != self.app_id:
                raise PlatformError("INVALID_REQUEST")
            return {"windows": self._windows()}
        current = self._target(params)
        if action == "state":
            return {"visible": True, "title": current["title"], "size": [current["width"], current["height"]]}
        if action == "close-window":
            return self._mutate(params, lambda: self.provider.close_window(self.binding))
        if action in ("ref-click", "ref-set-value"):
            if params.get("button", "left") != "left":
                raise PlatformError("UNSUPPORTED")
            if action == "ref-set-value" and (type(params.get("text")) is not str or len(params["text"].encode()) > 32768):
                raise PlatformError("INVALID_REQUEST")
            def mutation():
                handle = self._ref(params.get("ref"))
                if action == "ref-click": self.provider.invoke(self.binding, handle)
                else: self.provider.set_value(self.binding, handle, params["text"])
                return {"delivered": True, "mechanism": "native-semantic"}
            return self._mutate(params, mutation)
        return self.observe(params, current)

    def observe(self, params, current):
        format_ = params.get("format", "image")
        if format_ not in ("image", "text", "both") or ("refs" in params and type(params["refs"]) is not bool):
            raise PlatformError("INVALID_REQUEST")
        tree = None
        if format_ != "image":
            nodes, handles, truncated = self.provider.tree(self.binding, 256, self.clock() + 1.0)
            if len(nodes) != len(handles) or len(nodes) > 256:
                for handle in handles: self.provider.release_ref(handle)
                raise PlatformError("BACKEND_ERROR")
            snapshot = uuid.uuid4().hex
            if params.get("refs"):
                for index, node in enumerate(nodes): node["ref"] = "@" + snapshot + ":e" + str(index)
            while nodes and len(json.dumps(nodes, ensure_ascii=False).encode()) > 16000:
                nodes.pop(); self.provider.release_ref(handles.pop()); truncated = "bytes"
            if params.get("refs") and nodes:
                while len(self.snapshots) >= 4:
                    old = self.snapshots.pop(next(iter(self.snapshots)))
                    for handle in old[1]: self.provider.release_ref(handle)
                self.snapshots[snapshot] = (self.clock() + 30.0, handles)
            else:
                for handle in handles: self.provider.release_ref(handle)
            tree = {"status": "ok", "toolkit": self.provider.toolkit, "nodes": nodes, "truncated": truncated, "complete": truncated is None} if nodes else {"status": "unavailable", "reason": "native accessibility tree unavailable"}
        after_tree = self._target(params)
        if any(after_tree.get(key) != current.get(key) for key in ("x", "y", "width", "height")):
            raise PlatformError("CAPTURE_GEOMETRY_CHANGED")
        frame = {"appId": self.app_id, "windowId": self.window_id, "width": current["width"], "height": current["height"],
                 "surfaceWidth": current["width"], "surfaceHeight": current["height"], "capturedAt": time.time_ns() // 1_000_000,
                 "pointer": None, "cursorVariant": 0, "windows": self._windows()}
        if tree is not None: frame["tree"] = tree
        if format_ == "text" and tree["status"] == "ok":
            frame["mimeType"] = "text/x-orbit-a11y"
            return frame
        png = self.provider.capture(self.binding)
        if (type(png) is not bytes or len(png) > 16 * 1024 * 1024 or png[:8] != b"\x89PNG\r\n\x1a\n" or len(png) < 24):
            raise PlatformError("CAPTURE_UNAVAILABLE")
        width, height = int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
        if not 0 < width <= 8192 or not 0 < height <= 8192 or width * height > 16000000:
            raise PlatformError("CAPTURE_UNAVAILABLE")
        after = self._target(params)
        if any(after.get(key) != current.get(key) for key in ("x", "y", "width", "height")):
            raise PlatformError("CAPTURE_GEOMETRY_CHANGED")
        if params.get("digestOnly"):
            return {"sha256": hashlib.sha256(png).hexdigest()}
        return dict(frame, mimeType="image/png", image=base64.b64encode(png).decode(), width=width, height=height)


def serve(session, source=sys.stdin.buffer, output=sys.stdout):
    cache, metadata_bytes, image_id = {}, 0, None
    try:
        while True:
            line = source.readline(65537)
            if not line: break
            if len(line) > 65536 or not line.endswith(b"\n"): break
            request_id, fingerprint = None, None
            try:
                value = exact(json.loads(line), ("requestId", "method", "params"), ("requestId", "method", "params"))
                request_id = value["requestId"]
                if type(request_id) is not str or not ID.fullmatch(request_id): break
                fingerprint = hashlib.sha256(json.dumps([value["method"], value["params"]], sort_keys=True).encode()).hexdigest()
                previous = cache.get(request_id)
                if previous is not None:
                    if previous[0] != fingerprint:
                        raise PlatformError("INVALID_REQUEST")
                    reply = previous[1]
                else:
                    if len(cache) >= 1024 or metadata_bytes > 4 * 1024 * 1024 - 65536:
                        raise PlatformError("LIMIT_REACHED")
                    result = session.request(value["method"], value["params"])
                    reply = {"requestId": request_id, "ok": True, "result": result}
                    if isinstance(result, dict) and "image" in result:
                        if image_id is not None:
                            old = cache[image_id]
                            cache[image_id] = (old[0], {"requestId": image_id, "ok": False, "error": {"code": "REPLAY_EXPIRED", "message": "Older capture reply expired"}})
                        image_id = request_id
                    cache[request_id] = (fingerprint, reply)
                    metadata = {key: entry for key, entry in result.items() if key != "image"} if isinstance(result, dict) else result
                    metadata_bytes += len(json.dumps(metadata, ensure_ascii=True).encode())
            except Exception as error:
                code = error.code if isinstance(error, PlatformError) else "APPROVAL_REQUIRED" if str(error) == "Protected mode requires approval for this exact action" else "BACKEND_ERROR"
                reply = {"requestId": request_id, "ok": False, "error": {"code": code, "message": "Native platform request refused"}}
                if fingerprint is not None and request_id not in cache and len(cache) < 1024:
                    cache[request_id] = (fingerprint, reply)
                    metadata_bytes += 512
            encoded = json.dumps(reply, separators=(",", ":"), ensure_ascii=True)
            if len(encoded) > 24 * 1024 * 1024: break
            output.write(encoded + "\n"); output.flush()
    finally:
        session.close()
