#!/usr/bin/python3
"""Measure an actual Chromium Wayland window in the private background lab."""
import hashlib
from io import BytesIO
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid
from PIL import Image

from action_control import ActionControl
from ghost import Atspi, app, hypr, window_for
from lab import guard
from process_scope import processes, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
state = {}
state_lock = threading.Lock()
route = "/" + uuid.uuid4().hex + "/"
page = (root / "browser_fixture.html").read_bytes()


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != route:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if self.path != route + "state" or not 0 < length <= 65536:
            self.send_error(400)
            return
        received = json.loads(self.rfile.read(length))
        with state_lock:
            if received["sequence"] > state.get("sequence", 0):
                state.clear()
                state.update(received)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        pass


def wait(check, label):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(f"{label}: {json.dumps(observed(), ensure_ascii=False)}")


def observed():
    with state_lock:
        return dict(state)


def tree(node):
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            yield from tree(child)


def main():
    baseline = processes()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with ActionControl(directory) as control:
        offset = len(control.inspect()["events"])
    try:
        with ExitStack() as stack:
            profile = stack.enter_context(tempfile.TemporaryDirectory(prefix="chromium-native-", dir=os.environ["XDG_STATE_HOME"]))
            stack.callback(lambda: terminate(processes() - baseline))
            url = f"http://127.0.0.1:{server.server_port}{route}"
            argv = ["/usr/bin/chromium-browser", "--ozone-platform=wayland", "--no-first-run",
                    "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
                    "--disable-component-update", "--password-store=basic", "--force-renderer-accessibility",
                    "--user-data-dir=" + profile, "--app=" + url]
            output = subprocess.check_output(["/usr/bin/python3", str(root / "ghost.py"), "launch", "--", *argv],
                                             text=True, timeout=25)
            launched = json.loads(output)
            window = window_for(launched["pid"])
            address = window["address"]
            wait(lambda: observed().get("text") == "Initial state", "Fixture did not load")
            application = app(window["pid"])
            field = wait(lambda: next((item for item in tree(application) if item.get_name() == "Agent editor"
                                       and item.get_state_set().contains(Atspi.StateType.EDITABLE)
                                       and item.get_text_iface()), None),
                         "Native accessibility text field not found")
            initial = Atspi.Text.get_text(field, 0, -1)
            assert initial == "Initial state", repr(initial)
            before_pixels = subprocess.check_output(["grim", "-T", window["stableId"], "-"], timeout=10)

            def command(name, *args):
                return hypr(" ".join([name, address, *map(str, args)]))

            # App mode removes browser navigation chrome. Use native accessible
            # bounds for the editor; DOM coordinates are a second measurement.
            extent = Atspi.Component.get_extents(field, Atspi.CoordType.WINDOW)
            data = observed()
            editor_x, editor_y, _, _ = data["field"]
            offset_x, offset_y = extent.x - editor_x, extent.y - editor_y
            button_x, button_y, button_width, button_height = data["button"]
            command("ghost-click", int(button_x + offset_x + button_width / 2), int(button_y + offset_y + button_height / 2))
            wait(lambda: observed()["presses"] == 1, "Native button press missing")
            x, y = extent.x + 30, extent.y + 30
            command("ghost-click", x, y)
            command("ghost-key", "ctrl+a")
            message = "Native Chromium 0123\n" + "\u0645\u0631\u062d\u0628\u0627\n" + "".join(f"Agent line {i:03d}\n" for i in range(60))
            command("ghost-texthex", message.encode().hex())
            try:
                wait(lambda: observed()["text"] == message, "Native text readback mismatch")
            except AssertionError as error:
                raise AssertionError(f"{error}; native accessibility text: {Atspi.Text.get_text(field, 0, -1)!r}") from error
            assert Atspi.Text.get_text(field, 0, -1) == message
            command("ghost-key", "ctrl+a")
            wait(lambda: observed()["selection"] == [0, len(message)], "Selection mismatch")
            command("ghost-key", "Left")
            wait(lambda: observed()["selection"] == [0, 0], "Caret reset missing")
            first_character = Atspi.Text.get_character_extents(field, 0, Atspi.CoordType.WINDOW)
            assert extent.y <= first_character.y < extent.y + extent.height, first_character
            scroll_before = observed()["scroll"]
            region = (extent.x + 90, extent.y + 60, extent.x + 260, extent.y + extent.height - 20)
            marker_x, marker_y, marker_width, marker_height = observed()["marker"]
            marker_point = (int(marker_x + offset_x + marker_width / 2), int(marker_y + offset_y + marker_height / 2))

            def capture(deadline):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError("Background pixel observation deadline expired")
                return subprocess.check_output(["grim", "-T", window["stableId"], "-"], timeout=min(10, remaining))

            # Red means the fixture painted an unselected top viewport. Require
            # that state and stable text rows before measuring a wheel frame.
            deadline = time.monotonic() + 2
            previous_region = None
            while True:
                before_wheel = capture(deadline)
                frame = Image.open(BytesIO(before_wheel)).convert("RGBA")
                before_region = frame.crop(region).tobytes()
                if frame.getpixel(marker_point)[:3] == (255, 0, 0) and before_region == previous_region:
                    break
                previous_region = before_region
                time.sleep(0.05)
            wheel_start = time.monotonic()
            command("ghost-scroll", x, y, 10)
            wait(lambda: observed()["scroll"] > scroll_before and observed()["wheelEvents"] > 0, "Native wheel scroll missing")
            after_pixels = capture(wheel_start + 2)
            assert before_pixels != after_pixels, "Background pixels did not change"
            # Measure text rows away from the first-line caret and the arrow
            # at (extent.x + 30, extent.y + 30). No image is edited or exported.
            after_frame = Image.open(BytesIO(after_pixels)).convert("RGBA")
            after_region = after_frame.crop(region).tobytes()
            deadline = wheel_start + 2
            captures = 1
            while (before_region == after_region or after_frame.getpixel(marker_point)[:3] != (0, 255, 0)) and time.monotonic() < deadline:
                time.sleep(0.05)
                after_pixels = capture(deadline)
                after_frame = Image.open(BytesIO(after_pixels)).convert("RGBA")
                after_region = after_frame.crop(region).tobytes()
                captures += 1
            pixel_lag = time.monotonic() - wheel_start
            if before_region == after_region:
                evidence = Path(os.environ["XDG_RUNTIME_DIR"]).parent
                (evidence / "chromium-before-wheel.png").write_bytes(before_wheel)
                (evidence / "chromium-after-wheel.png").write_bytes(after_pixels)
                (evidence / "chromium-wheel-state.json").write_text(json.dumps({"extent": [extent.x, extent.y, extent.width, extent.height], "region": region, "state": observed()}))
            assert before_region != after_region, "Text-row pixels did not change after wheel input"
            assert after_frame.getpixel(marker_point)[:3] == (0, 255, 0) and pixel_lag <= 2, "Fresh wheel frame was not observed within two seconds"
            assert observed()["text"] == message and Atspi.Text.get_text(field, 0, -1) == message
            command("ghost-release")
            with ActionControl(directory) as control:
                journal = control.inspect()
            assert not journal["unresolved"]
            events = journal["events"][offset:]
            outcomes = {event["id"]: event for event in events if event["phase"] == "finish"}
            native = [event for event in events if event["phase"] == "begin" and event.get("request", "").startswith("ghost-")
                      and not event["request"].startswith("ghost-cli ")]
            assert len(native) == 8 and all(outcomes[event["id"]]["outcome"] == "success" for event in native)
            print(json.dumps({"task": "native-chromium", "pass": True, "pid": window["pid"],
                              "class": window["class"], "native_requests": len(native), "characters": len(message),
                              "presses": observed()["presses"], "selection": [0, len(message)],
                              "scroll": [scroll_before, observed()["scroll"]], "wheel_events": observed()["wheelEvents"],
                              "wheel_text_pixels_sha256": [hashlib.sha256(before_region).hexdigest(), hashlib.sha256(after_region).hexdigest()],
                              "wheel_pixel_observation_seconds": pixel_lag, "wheel_captures": captures,
                              "pixels_sha256": [hashlib.sha256(before_pixels).hexdigest(), hashlib.sha256(after_pixels).hexdigest()]}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        # Whole-lab census is confined to this exclusive test job. It is not
        # the owner-session production process ownership mechanism.
        terminate(processes() - baseline)


if __name__ == "__main__":
    main()
