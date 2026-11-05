"""Original macOS window observation and AX semantic operations.

Requires the normal macOS Accessibility and Screen Recording grants. No private
Spaces API, global input injection, owner activation or copied profile is used.
The current visible Space is the only workspace this first adapter can address.
"""
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.platform_protocol import PlatformError, PlatformSession, serve
from src.native.control import ActionControl


class Point(C.Structure):
    _fields_ = [("x", C.c_double), ("y", C.c_double)]


class Size(C.Structure):
    _fields_ = [("width", C.c_double), ("height", C.c_double)]


class BsdInfo(C.Structure):
    _fields_ = [("head", C.c_uint32 * 12), ("comm", C.c_char * 16), ("name", C.c_char * 32),
                ("tail", C.c_uint32 * 6), ("start_sec", C.c_uint64), ("start_usec", C.c_uint64)]


def function(library, name, result, *arguments):
    value = getattr(library, name)
    value.restype, value.argtypes = result, list(arguments)
    return value


class MacProvider:
    platform, toolkit = "darwin", "AX"

    def __init__(self):
        if sys.platform != "darwin":
            raise PlatformError("UNSUPPORTED")
        cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        ax = C.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        cg = C.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        proc = C.CDLL("/usr/lib/libproc.dylib")
        ptr, integer, boolean = C.c_void_p, C.c_int32, C.c_bool
        self.release_cf = function(cf, "CFRelease", None, ptr)
        self.retain_cf = function(cf, "CFRetain", ptr, ptr)
        self.type_id = function(cf, "CFGetTypeID", C.c_ulong, ptr)
        self.string_id = function(cf, "CFStringGetTypeID", C.c_ulong)()
        self.number_id = function(cf, "CFNumberGetTypeID", C.c_ulong)()
        self.bool_id = function(cf, "CFBooleanGetTypeID", C.c_ulong)()
        self.string_create = function(cf, "CFStringCreateWithCString", ptr, ptr, C.c_char_p, C.c_uint32)
        self.string_read = function(cf, "CFStringGetCString", boolean, ptr, C.c_char_p, C.c_long, C.c_uint32)
        self.number_read = function(cf, "CFNumberGetValue", boolean, ptr, integer, ptr)
        self.boolean_read = function(cf, "CFBooleanGetValue", boolean, ptr)
        self.array_count = function(cf, "CFArrayGetCount", C.c_long, ptr)
        self.array_item = function(cf, "CFArrayGetValueAtIndex", ptr, ptr, C.c_long)
        self.dictionary_item = function(cf, "CFDictionaryGetValue", ptr, ptr, ptr)
        self.ax_app = function(ax, "AXUIElementCreateApplication", ptr, integer)
        self.ax_copy = function(ax, "AXUIElementCopyAttributeValue", integer, ptr, ptr, C.POINTER(ptr))
        self.ax_action = function(ax, "AXUIElementPerformAction", integer, ptr, ptr)
        self.ax_set = function(ax, "AXUIElementSetAttributeValue", integer, ptr, ptr, ptr)
        self.ax_settable = function(ax, "AXUIElementIsAttributeSettable", integer, ptr, ptr, C.POINTER(boolean))
        self.ax_pid = function(ax, "AXUIElementGetPid", integer, ptr, C.POINTER(integer))
        self.ax_value = function(ax, "AXValueGetValue", boolean, ptr, integer, ptr)
        self.ax_timeout = function(ax, "AXUIElementSetMessagingTimeout", integer, ptr, C.c_float)
        self.ax_trusted = function(ax, "AXIsProcessTrusted", boolean)
        self.windows_copy = function(cg, "CGWindowListCopyWindowInfo", ptr, C.c_uint32, C.c_uint32)
        self.screen_allowed = function(cg, "CGPreflightScreenCaptureAccess", boolean)
        self.idle_seconds = function(cg, "CGEventSourceSecondsSinceLastEventType", C.c_double, integer, C.c_uint32)
        self.pidinfo = function(proc, "proc_pidinfo", integer, integer, integer, C.c_uint64, ptr, integer)

    def string(self, value):
        return self.string_create(None, value.encode("utf-8"), 0x08000100)

    def scalar(self, value):
        if not value: return None
        type_id = self.type_id(value)
        if type_id == self.string_id:
            buffer = C.create_string_buffer(32768)
            return buffer.value.decode("utf-8", "replace") if self.string_read(value, buffer, len(buffer), 0x08000100) else ""
        if type_id == self.number_id:
            number = C.c_double()
            return number.value if self.number_read(value, 6, C.byref(number)) else None
        if type_id == self.bool_id: return bool(self.boolean_read(value))
        return None

    def attribute(self, element, name):
        key, value = self.string(name), C.c_void_p()
        try:
            return value.value if self.ax_copy(element, key, C.byref(value)) == 0 else None
        finally: self.release_cf(key)

    def scalar_attribute(self, element, name):
        value = self.attribute(element, name)
        try: return self.scalar(value)
        finally:
            if value: self.release_cf(value)

    def dictionary(self, dictionary, name):
        key = self.string(name)
        try: return self.dictionary_item(dictionary, key)
        finally: self.release_cf(key)

    def birth(self, pid):
        info = BsdInfo()
        if self.pidinfo(pid, 3, 0, C.byref(info), C.sizeof(info)) != C.sizeof(info) or info.head[3] != pid or info.head[5] != os.getuid():
            raise PlatformError("TARGET_CLOSED")
        return str(info.start_sec) + ":" + str(info.start_usec)

    def ready(self):
        if not self.ax_trusted(): raise PlatformError("ACCESSIBILITY_PERMISSION_REQUIRED")
        return True

    def indicator_ready(self):
        # Native background mutation stays unavailable until this adapter has
        # an actually rendered owner-visible activity indicator and acceptance.
        return False

    def window_lifetime_qualified(self):
        # A numeric CGWindowID can be reused between the separate candidate and
        # claim workers. Retained AX validation below protects an existing
        # binding, but does not establish that missing initial lifetime proof.
        return False

    def candidates(self):
        self.ready()
        array = self.windows_copy(1 | 16, 0)
        if not array: raise PlatformError("CAPTURE_UNAVAILABLE")
        rows = []
        try:
            count = self.array_count(array)
            if count > 4096: raise PlatformError("LIMIT_REACHED")
            for index in range(count):
                row = self.array_item(array, index)
                if self.scalar(self.dictionary(row, "kCGWindowLayer")) != 0: continue
                pid = int(self.scalar(self.dictionary(row, "kCGWindowOwnerPID")) or 0)
                window_id = int(self.scalar(self.dictionary(row, "kCGWindowNumber")) or 0)
                if pid <= 0 or window_id <= 0: continue
                try: birth = self.birth(pid)
                except PlatformError: continue
                bounds = self.dictionary(row, "kCGWindowBounds")
                if not bounds: continue
                width = self.scalar(self.dictionary(bounds, "Width"))
                height = self.scalar(self.dictionary(bounds, "Height"))
                if not width or not height or not 0 < width <= 8192 or not 0 < height <= 8192: continue
                title = self.scalar(self.dictionary(row, "kCGWindowName")) or ""
                rows.append({"address": hex(window_id), "stableId": hashlib.sha256((str(pid) + ":" + birth + ":" + str(window_id)).encode()).hexdigest()[:32],
                             "pid": pid, "title": str(title)[:512], "width": width, "height": height, "workspace": 1,
                             "windowProtocol": "cocoa", "nativeId": window_id, "birth": birth,
                             "x": self.scalar(self.dictionary(bounds, "X")), "y": self.scalar(self.dictionary(bounds, "Y"))})
                if len(rows) > 256: raise PlatformError("LIMIT_REACHED")
        finally: self.release_cf(array)
        return rows

    def bind(self, row):
        app = self.ax_app(row["pid"])
        self.ax_timeout(app, 0.25)
        windows = self.attribute(app, "AXWindows")
        root = None
        try:
            if windows:
                # AXWindowNumber is an optional runtime capability. Without an
                # exact CG/AX join, text/mutation is refused rather than guessed.
                for index in range(min(self.array_count(windows), 256)):
                    candidate = self.array_item(windows, index)
                    if self.scalar_attribute(candidate, "AXWindowNumber") == row["nativeId"]:
                        if root:
                            self.release_cf(root)
                            raise PlatformError("AMBIGUOUS_TARGET")
                        root = self.retain_cf(candidate)
        finally:
            if windows: self.release_cf(windows)
            self.release_cf(app)
        if root is None:
            raise PlatformError("UNSUPPORTED")
        return {"row": row, "root": root}

    def current(self, binding):
        target = binding["row"]
        if self.birth(target["pid"]) != target["birth"]: raise PlatformError("TARGET_CLOSED")
        root, pid = binding["root"], C.c_int32()
        if (not root or self.ax_pid(root, C.byref(pid)) != 0 or pid.value != target["pid"]
                or self.scalar_attribute(root, "AXWindowNumber") != target["nativeId"]):
            raise PlatformError("TARGET_CLOSED")
        rows = [row for row in self.candidates() if row["address"] == target["address"] and row["stableId"] == target["stableId"]]
        if len(rows) != 1: raise PlatformError("TARGET_CLOSED")
        binding["row"] = dict(rows[0])
        return rows[0]

    def release(self, binding):
        if binding["root"]: self.release_cf(binding["root"])
        binding["root"] = None

    def release_ref(self, handle):
        if handle: self.release_cf(handle)

    def ref_current(self, binding, handle):
        try:
            self.current(binding)
            if not binding["root"]: return False
            pid = C.c_int32()
            if self.ax_pid(handle, C.byref(pid)) != 0 or pid.value != binding["row"]["pid"]: return False
            window = self.attribute(handle, "AXWindow")
            try:
                root = window or handle
                return self.scalar_attribute(root, "AXWindowNumber") == binding["row"]["nativeId"]
            finally:
                if window: self.release_cf(window)
        except Exception: return False

    def owner_input_recent(self):
        seconds = self.idle_seconds(0, 0xffffffff)
        return not 2.0 <= seconds < 1e10

    def tree(self, binding, maximum, deadline):
        if not binding["root"]: return [], [], None
        root = binding["root"]
        self.ax_timeout(root, 0.25)
        stack, nodes, handles = [(self.retain_cf(root), 0)], [], []
        truncated = None
        try:
            while stack and len(nodes) < maximum and time.monotonic() < deadline:
                element, depth = stack.pop()
                try:
                    if self.scalar_attribute(element, "AXHidden") is True: continue
                    role = str(self.scalar_attribute(element, "AXRole") or "unknown")
                    password = role == "AXSecureTextField" or self.scalar_attribute(element, "AXSubrole") == "AXSecureTextField"
                    point_value, size_value = self.attribute(element, "AXPosition"), self.attribute(element, "AXSize")
                    point, size = Point(), Size()
                    try:
                        have_box = bool(point_value and size_value and self.ax_value(point_value, 1, C.byref(point)) and self.ax_value(size_value, 2, C.byref(size)))
                    finally:
                        if point_value: self.release_cf(point_value)
                        if size_value: self.release_cf(size_value)
                    if have_box and size.width > 0 and size.height > 0:
                        row = binding["row"]
                        node = {"role": role[2:].lower()[:32], "box": [round(point.x - row["x"]), round(point.y - row["y"]), round(size.width), round(size.height)]}
                        if not password:
                            name = self.scalar_attribute(element, "AXTitle") or self.scalar_attribute(element, "AXDescription")
                            value = self.scalar_attribute(element, "AXValue")
                            if isinstance(name, str) and name: node["name"] = " ".join(name.split())[:180]
                            if isinstance(value, str) and value: node["text"] = " ".join(value.split())[:120]
                        nodes.append(node); handles.append(self.retain_cf(element))
                    if password: continue
                    children = self.attribute(element, "AXChildren")
                    if children:
                        try:
                            count = self.array_count(children)
                            if depth >= 10:
                                if count: truncated = "depth"
                                continue
                            if count > 256: truncated = "children"
                            for index in range(min(count, 256) - 1, -1, -1):
                                stack.append((self.retain_cf(self.array_item(children, index)), depth + 1))
                        finally: self.release_cf(children)
                finally: self.release_cf(element)
            if stack: truncated = truncated or ("time" if time.monotonic() >= deadline else "nodes")
            return nodes, handles, truncated
        except BaseException:
            for handle in handles: self.release_cf(handle)
            raise
        finally:
            for handle, _ in stack: self.release_cf(handle)

    def invoke(self, binding, handle):
        if not self.ref_current(binding, handle): raise PlatformError("STALE_REF")
        action = self.string("AXPress")
        try:
            if self.ax_action(handle, action) != 0: raise PlatformError("NATIVE_DELIVERY_UNCERTAIN")
        finally: self.release_cf(action)

    def set_value(self, binding, handle, text):
        if not self.ref_current(binding, handle): raise PlatformError("STALE_REF")
        if self.scalar_attribute(handle, "AXSubrole") == "AXSecureTextField": raise PlatformError("UNSUPPORTED")
        key, value, allowed = self.string("AXValue"), self.string(text), C.c_bool()
        try:
            if self.ax_settable(handle, key, C.byref(allowed)) != 0 or not allowed.value: raise PlatformError("UNSUPPORTED")
            if self.ax_set(handle, key, value) != 0: raise PlatformError("NATIVE_DELIVERY_UNCERTAIN")
        finally: self.release_cf(key); self.release_cf(value)

    def close_window(self, binding):
        self.current(binding)
        if not binding["root"]: raise PlatformError("UNSUPPORTED")
        close = self.attribute(binding["root"], "AXCloseButton")
        if not close: raise PlatformError("UNSUPPORTED")
        try: self.invoke(binding, close)
        finally: self.release_cf(close)
        return {"closeRequested": True}

    def capture(self, binding):
        self.current(binding)
        if not self.screen_allowed(): raise PlatformError("SCREEN_RECORDING_PERMISSION_REQUIRED")
        with tempfile.TemporaryDirectory(prefix="orbit-macos-capture-") as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / "window.png"
            result = subprocess.run(["/usr/sbin/screencapture", "-x", "-o", "-l", str(binding["row"]["nativeId"]), str(path)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
            if result.returncode != 0 or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024: raise PlatformError("CAPTURE_UNAVAILABLE")
            return path.read_bytes()

    def open(self, registration, window):
        bundle = registration.get("bundlePath")
        if type(bundle) is not str or not os.path.isabs(bundle) or not bundle.endswith(".app") or not Path(bundle).is_dir():
            raise PlatformError("INVALID_REQUEST")
        # The public open utility can forward through LaunchServices. It cannot
        # prove request-specific new-window ancestry, so never claim opened:true.
        before = {(row["address"], row["stableId"]) for row in self.candidates()}
        done = subprocess.run(["/usr/bin/open", "-g", "-a", bundle], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
        if done.returncode != 0: raise PlatformError("OPENING_UNCERTAIN")
        after = [row for row in self.candidates() if (row["address"], row["stableId"]) not in before]
        return {"opened": False, "openingStatus": "uncertain", "candidateReason": "launchservices-request-identity-unproven", "workspace": 1, "workspaceKind": "current-visible-desktop", "candidates": after}

    def monitors(self):
        return {"monitors": [], "workspaceKind": "current-visible-desktop", "presentation": "unsupported", "sampled": "native-adapter-capabilities"}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4: raise PlatformError("INVALID_REQUEST")
        with ActionControl(sys.argv[2]) as control:
            serve(PlatformSession(MacProvider(), control))
    except Exception:
        print("ORBIT-WORKER-FATAL {\"type\":\"PlatformStartupError\",\"message\":\"macOS native helper or permissions unavailable\"}", file=sys.stderr)
        raise SystemExit(1)
