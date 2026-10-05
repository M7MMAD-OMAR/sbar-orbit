#!/usr/bin/python3
"""Current-session GTK4/Qt tasks in a guarded private lab, with AT-SPI readback."""
import argparse
import base64
import hashlib
from io import BytesIO
import json
import os
import select
from pathlib import Path
import shutil
import subprocess
import sys
import time
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.session import NativeSession
from lab import guard
from cursor_cost_probe import loaded_plugin

READ = '''import gi,json,sys
gi.require_version("Atspi","2.0")
from gi.repository import Atspi
pid=int(sys.argv[1]);query=sys.argv[2];stack=[Atspi.get_desktop(0)];count=0;found=None
while stack:
 node=stack.pop();count+=1
 if count>5000: raise RuntimeError("Accessibility tree limit exceeded")
 owned=node.get_process_id()==pid
 role=node.get_role_name();name=node.get_name();states=node.get_state_set()
 editable=owned and bool(node.get_text_iface()) and states.contains(Atspi.StateType.EDITABLE)
 match=(editable and query=="editor" and role=="text") or (editable and query=="location" and states.contains(Atspi.StateType.SHOWING)) or (owned and role=="list" and name==query) or (owned and role=="button" and name=="Back" and query=="back")
 if match:
  if query=="item": raise RuntimeError("Invalid item query")
  target=node
  if query=="applications":
   if node.get_child_count()==0: break
   target=node.get_child_at_index(0)
  rect=Atspi.Component.get_extents(target,Atspi.CoordType.WINDOW)
  found={"name":name,"children":node.get_child_count(),"rect":[rect.x,rect.y,rect.width,rect.height],"selected":target.get_state_set().contains(Atspi.StateType.SELECTED)}
  if editable:
   text=Atspi.Text.get_text(node,0,-1)
   if len(text)>10000: raise RuntimeError("Accessibility text limit exceeded")
   found.update(text=text,caret=Atspi.Text.get_caret_offset(node),selections=Atspi.Text.get_n_selections(node))
   if found["selections"]:
    selection=Atspi.Text.get_selection(node,0);found["selection"]=[selection.start_offset,selection.end_offset]
   if text:
    first=Atspi.Text.get_character_extents(node,0,Atspi.CoordType.WINDOW);found["first_y"]=first.y
  break
 for index in reversed(range(node.get_child_count())):
  child=node.get_child_at_index(index)
  if child: stack.append(child)
print(json.dumps(found))
'''


def wait(operation, label, seconds=5):
    deadline = time.monotonic() + seconds
    while True:
        value = operation()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        time.sleep(0.05)


def main():
    guard(os.environ)
    require_budget()
    parser = argparse.ArgumentParser()
    parser.add_argument("toolkit", choices=("gtk4", "qt"))
    parser.add_argument("--barrier-fd", type=int)
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    work = lab / ("tk-" + options.toolkit)
    work.mkdir(mode=0o700)
    (work / "apps").mkdir(mode=0o700)
    retained = root / ".private" / ("native-toolkit-" + str(os.getpid()))
    retained.mkdir(mode=0o700)
    report = {"complete": False, "toolkit": options.toolkit, "errors": [], "cleanup_errors": [],
              "owner_activation": "not performed", "retained": str(retained), "source_sha256": {}}
    for path in [Path(__file__), root / "experiments/ghost-cursor/plugin/ghostinput.cpp"] + [
            root / ("src/native/" + name + ".py") for name in
            ("session", "application", "application_worker", "control", "transport", "host", "lease", "supervise")]:
        report["source_sha256"][str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    session = control = None
    try:
        plan = inspect_host(os.environ)
        source_hash = report["source_sha256"]["experiments/ghost-cursor/plugin/ghostinput.cpp"]
        report["binding"] = loaded_plugin(plan["compositor"][0], source_hash)
        control = ActionControl(work / "control")
        control.configure(mode="full")
        session = NativeSession(plan, work / "apps", control)
        argv = (["/usr/bin/gnome-text-editor", "--standalone"] if options.toolkit == "gtk4" else
                ["/usr/bin/dolphin", "--new-window", "/usr/share"])
        launched = session.launch(argv)
        app = session.apps[launched["appId"]]
        report.update(unit=app.unit, process=app.process)
        windows = wait(lambda: session.execute({"type": "windows", "appId": launched["appId"]})["windows"],
                       "Toolkit did not map", 10)
        target = {"appId": launched["appId"], "windowId": windows[0]["windowId"]}
        address = session.windows[target["windowId"]]["address"]
        for command in ("setfloating address:" + address,
                        "resizewindowpixel exact 850 650,address:" + address):
            if session.transport._exchange("dispatch " + command).strip() != "ok":
                raise RuntimeError("Private fixture layout failed")

        def action(kind, **values):
            return session.execute({"type": kind, **target, **values})

        def read(query):
            def operation():
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Application left its retained scope before readback")
                env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                       "DBUS_SESSION_BUS_ADDRESS": f"unix:path={app.profile / 'session'}",
                       "AT_SPI_BUS_ADDRESS": f"unix:path={app.profile / 'run' / 'at-spi' / 'bus'}"}
                result = subprocess.run(["/usr/bin/python3", "-c", READ, str(app.process[0]), query],
                                        env=env, capture_output=True, text=True, timeout=5, check=True)
                if len(result.stdout) > 65536:
                    raise RuntimeError("Accessibility reply exceeds bound")
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Application left its retained scope during readback")
                return json.loads(result.stdout)
            return control.execute("native-toolkit-read " + launched["appId"] + " " + query, operation)

        def capture(name, region=None):
            frame = action("observe")
            pixels = base64.b64decode(frame["image"], validate=True)
            (retained / (name + ".png")).write_bytes(pixels)
            with Image.open(BytesIO(pixels)) as image:
                rgba = image.convert("RGBA")
                if rgba.getextrema()[3][1] == 0:
                    raise RuntimeError("Toolkit frame is fully transparent")
                if region:
                    left, top, right, bottom = region
                    if not 0 <= left < right <= rgba.width or not 0 <= top < bottom <= rgba.height:
                        raise RuntimeError("Wheel pixel region is outside capture")
                    rgba = rgba.crop(region)
                return hashlib.sha256(rgba.tobytes()).hexdigest()

        def point(value):
            x, y, width, height = value["rect"]
            if width <= 0 or height <= 0:
                raise RuntimeError("Invalid accessibility geometry")
            return {"x": x + min(100, width // 2), "y": y + min(100, height // 2)}

        def stable_pixels(region):
            previous = None
            stable = 0

            def sample():
                nonlocal previous, stable
                value = capture("wheel-before", region)
                stable = stable + 1 if value == previous else 0
                previous = value
                return value if stable >= 2 else None

            return wait(sample, "Wheel baseline pixels did not settle")

        first = wait(lambda: read("editor" if options.toolkit == "gtk4" else "share"), "Private tree not ready")
        report["before"] = first
        report["pixels_before"] = capture("before")
        (work / "ready").write_text("ready")
        if options.barrier_fd is not None:
            try:
                if not select.select([options.barrier_fd], [], [], 15)[0]:
                    raise TimeoutError("Input barrier did not release within15 seconds")
                if os.read(options.barrier_fd, 1) != b"1":
                    raise RuntimeError("Input barrier closed")
            finally:
                os.close(options.barrier_fd)
        if options.toolkit == "gtk4":
            pos = point(first)
            action("cursor", **pos)
            action("click", button="left", **pos)
            action("key", key="ctrl+a")
            message = "Native pair GTK4 مرحبا\n" + "".join(f"Agent line {index:03d}\n" for index in range(100))
            action("text", text=message)
            typed = wait(lambda: (value if (value := read("editor"))["text"] == message else None), "GTK text mismatch")
            action("key", key="ctrl+a")
            selected = wait(lambda: (value if (value := read("editor"))["selections"] == 1 else None), "GTK selection missing")
            assert selected["selection"] == [0, len(message)], selected
            action("key", key="Left")
            previous = None
            stable = 0

            def settled():
                nonlocal previous, stable
                value = read("editor")
                stable = stable + 1 if value["first_y"] == previous and value["caret"] == 0 and not value["selections"] else 0
                previous = value["first_y"]
                return value if stable >= 3 else None

            top = wait(settled, "GTK caret scroll did not settle")
            wheel_region = (20, 200, 180, 550)
            wheel_before = stable_pixels(wheel_region)
            action("scroll", dy=10, **pos)
            after = wait(lambda: (value if (value := read("editor"))["first_y"] < top["first_y"] else None), "GTK did not scroll")
            wheel_after = wait(lambda: (value if (value := capture("wheel-after", wheel_region)) != wheel_before else None), "GTK wheel pixels did not change")
            assert after["text"] == message
            report.update(text_characters=len(message), text_sha256=hashlib.sha256(message.encode()).hexdigest(),
                          selection=selected["selection"], scroll_y=[top["first_y"], after["first_y"]],
                          wheel_region=wheel_region, wheel_pixels=[wheel_before, wheel_after])
        else:
            assert first["children"] > 100, first
            action("cursor", x=500, y=23)
            action("click", button="left", x=500, y=23)
            wait(lambda: read("location"), "Qt location not editable")
            action("key", key="ctrl+a")
            action("text", text="/usr/share/applications")
            typed = wait(lambda: (value if (value := read("location"))["text"].rstrip("/") == "/usr/share/applications" else None), "Qt location mismatch")
            action("key", key="Return")
            item = wait(lambda: read("applications"), "Qt navigation failed")
            pos = point(item)
            action("click", button="left", **pos)
            selected = wait(lambda: (value if (value := read("applications"))["selected"] else None), "Qt selection failed")
            wheel_region = (250, 250, 700, 550)
            wheel_before = stable_pixels(wheel_region)
            action("scroll", dy=10, **pos)
            after = wait(lambda: (value if (value := read("applications"))["rect"][1] < selected["rect"][1] else None), "Qt scroll failed")
            wheel_after = wait(lambda: (value if (value := capture("wheel-after", wheel_region)) != wheel_before else None), "Qt wheel pixels did not change")
            back = read("back")
            assert back
            action("click", button="left", **point(back))
            restored = wait(lambda: read("share"), "Qt Back failed")
            assert restored["children"] > 100
            report.update(typed=typed["text"], selection=True,
                          scroll_y=[selected["rect"][1], after["rect"][1]], final_list=restored["name"],
                          wheel_region=wheel_region, wheel_pixels=[wheel_before, wheel_after])
        report["pixels_after"] = capture("after")
        assert report["pixels_before"] != report["pixels_after"]
        action("hide-cursor")
        assert loaded_plugin(plan["compositor"][0], source_hash) == report["binding"]
        report["target"] = target
        report["complete"] = True
    except BaseException as error:
        report["errors"].append(repr(error))
    finally:
        if session:
            try:
                for app in session.apps.values():
                    shutil.copytree(app.profile, retained / app.profile.name,
                                    ignore=shutil.ignore_patterns("run", "session"))
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
            try:
                session.close()
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        if control:
            try:
                report["journal"] = control.inspect()
                assert not report["journal"]["unresolved"]
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
            try:
                control.close()
            except BaseException as error:
                report["cleanup_errors"].append(repr(error))
        if report["errors"] or report["cleanup_errors"]:
            report["complete"] = False
        try:
            (retained / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        except BaseException as error:
            report["complete"] = False
            report["cleanup_errors"].append("Report retention failed: " + repr(error))
            print(json.dumps(report), file=sys.stderr)
        print(json.dumps({"complete": report["complete"], "report": str(retained / "report.json")}))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
