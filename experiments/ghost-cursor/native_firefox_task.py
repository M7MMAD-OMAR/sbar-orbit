#!/usr/bin/python3
"""Scoped Firefox native input/readback in the private lab, never owner UI."""
import argparse
import base64
import hashlib
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.session import NativeSession
from lab import guard
import browser_task as fixture
from PIL import Image, ImageChops

READ_FIELD = '''import gi,json
from gi.repository import Atspi
import sys
expected=int(sys.argv[1])
stack=[Atspi.get_desktop(0)];count=0;found=None
while stack:
 node=stack.pop();count+=1
 if count>5000: raise RuntimeError("Accessibility tree limit exceeded")
 if node.get_name()=="Agent editor" and node.get_process_id()==expected:
  text=Atspi.Text.get_text(node,0,-1)
  extent=Atspi.Component.get_extents(node,Atspi.CoordType.WINDOW)
  found={"text":text,"extent":[extent.x,extent.y,extent.width,extent.height]}
  break
 for index in range(node.get_child_count()):
  child=node.get_child_at_index(index)
  if child: stack.append(child)
print(json.dumps(found))
'''


def main():
    guard(os.environ)
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    options = parser.parse_args()
    executable = Path(options.firefox).resolve(strict=True)
    root = Path(__file__).resolve().parents[2]
    retained = root / ".private" / f"native-firefox-{os.getpid()}"
    retained.mkdir(mode=0o700)
    work = Path(os.environ["XDG_RUNTIME_DIR"]).parent / f"firefox-task-{os.getpid()}"
    work.mkdir(mode=0o700)
    for name in ("apps", "profile"):
        (work / name).mkdir(mode=0o700)
    (work / "profile" / "user.js").write_text(
        'user_pref("termsofuse.bypassNotification", true);\n')
    report = {"complete": False, "interference_bar": "not measured", "errors": [],
              "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
              "source_sha256": {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in [Path(__file__), Path(fixture.__file__), root / "experiments/ghost-cursor/browser_fixture.html"]
                + [root / f"src/native/{name}.py" for name in ("session", "application", "application_worker", "control", "transport", "host", "lease")]
                + [root / "experiments/ghost-cursor/plugin/ghostinput.cpp"]}}
    server = thread = None
    session = None
    failures = []
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 0), fixture.FixtureHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with ActionControl(work / "control") as control:
            control.configure(mode="full")
            session = NativeSession(inspect_host(os.environ), work / "apps", control)
            try:
                launched = session.launch([str(executable), "--no-remote", "--profile", str(work / "profile"),
                    "--kiosk", f"http://127.0.0.1:{server.server_port}{fixture.route}"])
                windows = fixture.wait(lambda: session.execute({"type": "windows", "appId": launched["appId"]})["windows"],
                                       "Firefox scoped window did not map")
                target = {"appId": launched["appId"], "windowId": windows[0]["windowId"]}
                app = session.apps[launched["appId"]]
                fixture.wait(lambda: fixture.observed().get("text") == "Initial state", "Firefox fixture did not load")
                report["fixture_ready"] = fixture.observed()

                def capture(label):
                    frame = session.execute({"type": "observe", **target})
                    pixels = base64.b64decode(frame["image"])
                    (retained / f"{label}.png").write_bytes(pixels)
                    return Image.open(BytesIO(pixels)).convert("RGBA")

                def visible():
                    session.execute({"type": "state", **target})
                    image = capture("ready")
                    rgb = image.convert("RGB")
                    return image if image.getextrema()[3][1] > 0 and any(
                        color == (255, 0, 0) for count, color in rgb.getcolors(rgb.width * rgb.height)) else None

                ready_frame = fixture.wait(visible, "Firefox has no opaque fixture marker frame")

                def read():
                    def operation():
                        app.lease.verify()
                        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={app.profile / 'session'}",
                            "AT_SPI_BUS_ADDRESS": f"unix:path={app.profile / 'run' / 'at-spi' / 'bus'}"}
                        result = subprocess.run(["/usr/bin/python3", "-c", READ_FIELD, str(app.process[0])],
                            env=environment, capture_output=True, text=True, timeout=5, check=True)
                        if len(result.stdout) > 65536:
                            raise RuntimeError("Accessibility reply is too large")
                        app.lease.verify()
                        return json.loads(result.stdout)
                    return control.execute("native-firefox-a11y-read " + launched["appId"], operation)

                field = fixture.wait(read, "Firefox accessible editor missing")
                assert field["text"] == "Initial state"
                report["accessibility_initial"] = field
                state = fixture.observed()
                red, green, blue = ready_frame.convert("RGB").split()
                mask = ImageChops.multiply(red.point(lambda value: 255 if value == 255 else 0),
                    ImageChops.multiply(green.point(lambda value: 255 if value == 0 else 0),
                                        blue.point(lambda value: 255 if value == 0 else 0)))
                painted_marker = mask.getbbox()
                assert painted_marker is not None and painted_marker[2]-painted_marker[0] == 40 and painted_marker[3]-painted_marker[1] == 40
                offset = [painted_marker[index] - round(state["marker"][index]) for index in range(2)]
                report["fixture_pixel_offset"] = offset
                extent = [int(state["field"][0]+offset[0]), int(state["field"][1]+offset[1]),
                          int(state["field"][2]), int(state["field"][3])]
                bx, by, bw, bh = state["button"]
                session.execute({"type": "click", "button": "left", "x": int(bx + offset[0] + bw/2),
                                 "y": int(by + offset[1] + bh/2), **target})
                fixture.wait(lambda: fixture.observed()["presses"] == 1, "Firefox native press missing")
                x, y = extent[0] + 30, extent[1] + 30
                session.execute({"type": "click", "button": "left", "x": x, "y": y, **target})
                session.execute({"type": "key", "key": "ctrl+a", **target})
                message = "Native Firefox 0123\n\u0645\u0631\u062d\u0628\u0627\n" + "".join(f"Agent line {i:03d}\n" for i in range(60))
                session.execute({"type": "text", "text": message, **target})
                fixture.wait(lambda: fixture.observed()["text"] == message, "Firefox native text mismatch")
                assert read()["text"] == message
                session.execute({"type": "key", "key": "ctrl+a", **target})
                fixture.wait(lambda: fixture.observed()["selection"] == [0, len(message)], "Firefox selection missing")
                session.execute({"type": "key", "key": "Left", **target})
                fixture.wait(lambda: fixture.observed()["selection"] == [0, 0], "Firefox selection reset missing")
                region = (extent[0]+90, extent[1]+60, extent[0]+260, extent[1]+extent[3]-20)
                mx, my, mw, mh = fixture.observed()["marker"]
                marker = (int(mx+offset[0]+mw/2), int(my+offset[1]+mh/2))
                previous_rows = None

                def stable_before():
                    nonlocal previous_rows
                    image = capture("before-wheel")
                    rows = image.crop(region).tobytes()
                    ready = image.getpixel(marker)[:3] == (255, 0, 0) and rows == previous_rows
                    previous_rows = rows
                    return image if ready else None

                before = fixture.wait(stable_before, "Firefox unselected baseline did not paint stably")
                scroll = fixture.observed()["scroll"]
                session.execute({"type": "scroll", "x": x, "y": y, "dy": 10, **target})
                fixture.wait(lambda: fixture.observed()["scroll"] > scroll and fixture.observed()["wheelEvents"] > 0,
                             "Firefox native wheel missing")
                before_rows = before.crop(region).tobytes()
                def scrolled_frame():
                    image = capture("after-wheel")
                    return image if image.getpixel(marker)[:3] == (0, 255, 0) and image.crop(region).tobytes() != before_rows else None
                fixture.wait(scrolled_frame, "Firefox scrolled marker/text pixels unchanged")
                assert read()["text"] == message
                report.update(complete=True, characters=len(message), final_state=fixture.observed(),
                              accessibility_readback="pass", window=windows[0])
            except BaseException as error:
                failures.append(error)
            finally:
                for app_id, application in session.apps.items():
                    try:
                        diagnostic = retained / f"diagnostics-{app_id}"
                        diagnostic.mkdir(mode=0o700)
                        for name in ("worker.log", "application.json", "supervisor.json", "launch.json"):
                            path = application.profile / name
                            if path.is_file():
                                shutil.copyfile(path, diagnostic / name)
                    except BaseException as error:
                        failures.append(error)
                try:
                    session.close()
                except BaseException as error:
                    failures.append(error)
                try:
                    shutil.copytree(work / "control", retained / "control")
                except BaseException as error:
                    failures.append(error)
    except BaseException as error:
        failures.append(error)
    finally:
        cleanup = []
        if server is not None:
            if thread is not None and thread.is_alive():
                cleanup.append(server.shutdown)
            cleanup.append(server.server_close)
        if thread is not None and thread.ident is not None:
            cleanup.append(lambda: thread.join(timeout=2))
        for operation in cleanup:
            try:
                operation()
            except BaseException as error:
                failures.append(error)
        if thread is not None and thread.is_alive():
            failures.append(RuntimeError("Fixture server did not terminate"))
        report["errors"] = [repr(error) for error in failures]
        try:
            (retained / "report.json").write_text(json.dumps(report, indent=2))
        except BaseException as error:
            failures.append(error)
    print(retained / "report.json")
    if failures:
        raise BaseExceptionGroup("Native Firefox task or cleanup failed", failures)


if __name__ == "__main__":
    main()
