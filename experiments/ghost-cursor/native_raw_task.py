#!/usr/bin/python3
"""Measure scoped raw canvas input and fresh pixels inside a guarded lab."""
import argparse
import base64
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.session import NativeSession
from cursor_cost_probe import loaded_plugin
from lab import guard

READ = '''import gi,json,sys
gi.require_version("Atspi","2.0")
from gi.repository import Atspi
pid=int(sys.argv[1]);stack=[Atspi.get_desktop(0)];owned=[];count=0
while stack:
 node=stack.pop();count+=1
 if count>5000:raise RuntimeError("Accessibility tree exceeds bound")
 if node.get_process_id()==pid:
  editable=bool(node.get_text_iface()) and node.get_state_set().contains(Atspi.StateType.EDITABLE)
  owned.append({"role":node.get_role_name(),"editableText":editable})
 for index in range(node.get_child_count()):
  child=node.get_child_at_index(index)
  if child:stack.append(child)
print(json.dumps(owned))
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
    parser.add_argument("--label", default="agent-one")
    parser.add_argument("--barrier-fd", type=int)
    options = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", options.label):
        parser.error("Raw task label requires1 to32 ASCII letters, digits, underscores or hyphens")
    root = Path(__file__).resolve().parents[2]
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    report = {"complete": False, "label": options.label, "errors": [], "cleanupErrors": [],
              "ownerActivation": "not performed", "interference": "not measured by this task alone",
              "sourceSha256": {}}
    control = session = app = None
    work = retained = None
    launch_attempted = False
    try:
        work = Path(tempfile.mkdtemp(prefix="raw-task-", dir=lab))
        report["workDirectory"] = str(work)
        (work / "apps").mkdir(mode=0o700)
        retained = Path(tempfile.mkdtemp(prefix="native-raw-", dir=root / ".private"))
        sources = [Path(__file__), Path(__file__).with_name("canvas.py"), Path(__file__).with_name("lab.py"),
                   Path(__file__).with_name("cursor_cost_probe.py"), root / "experiments/ghost-cursor/plugin/ghostinput.cpp"]
        sources += [root / f"src/native/{name}.py" for name in
                    ("session", "application", "application_worker", "budget", "control", "transport", "host", "lease", "supervise")]
        report["sourceSha256"] = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
        plan = inspect_host(os.environ)
        binding = loaded_plugin(plan["compositor"][0], report["sourceSha256"]["experiments/ghost-cursor/plugin/ghostinput.cpp"])
        report["binding"] = binding
        control = ActionControl(work / "control")
        control.configure(mode="full")
        session = NativeSession(plan, work / "apps", control)
        launch_attempted = True
        launched = session.launch(["/usr/bin/python3", str(Path(__file__).with_name("canvas.py"))])
        app = session.apps[launched["appId"]]
        report.update(unit=app.unit, process=app.process, members=sorted(app.lease.members()),
                      cgroupDirectory=str(app.lease.directory))
        windows = wait(lambda: session.execute({"type": "windows", "appId": launched["appId"]})["windows"],
                       "Raw canvas did not map", 10)
        if len(windows) != 1:
            raise RuntimeError("Raw fixture must own exactly one window")
        target = {"appId": launched["appId"], "windowId": windows[0]["windowId"]}
        report["target"] = target

        def action(kind, **values):
            return session.execute({"type": kind, **target, **values})

        def read_state():
            def operation():
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Raw fixture escaped before readback")
                text = (app.profile / "worker.log").read_bytes()
                if len(text) > 65536:
                    raise RuntimeError("Raw fixture state log exceeds bound")
                states = []
                for line in text.decode().splitlines():
                    if not line.startswith('{"text":'):
                        continue
                    value = json.loads(line)
                    if (set(value) != {"text", "clicks", "scrolls", "x", "y"}
                            or not isinstance(value["text"], str)
                            or any(type(value[key]) is not int or value[key] < 0 for key in ("clicks", "scrolls"))
                            or any(type(value[key]) not in (int, float) or not math.isfinite(value[key]) for key in ("x", "y"))):
                        raise RuntimeError("Raw fixture state is malformed")
                    states.append(value)
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Raw fixture escaped during readback")
                return states[-1] if states else None
            return control.execute("native-raw-read " + launched["appId"], operation)

        def accessibility():
            def operation():
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Raw accessibility target escaped")
                env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                       "DBUS_SESSION_BUS_ADDRESS": f"unix:path={app.profile / 'session'}",
                       "AT_SPI_BUS_ADDRESS": f"unix:path={app.profile / 'run' / 'at-spi' / 'bus'}"}
                result = subprocess.run(["/usr/bin/python3", "-c", READ, str(app.process[0])], env=env,
                                        capture_output=True, text=True, timeout=5, check=True)
                if len(result.stdout) > 65536:
                    raise RuntimeError("Raw accessibility reply exceeds bound")
                app.lease.verify()
                if not app.lease.contains(app.process):
                    raise RuntimeError("Raw accessibility target escaped during readback")
                return json.loads(result.stdout)
            return control.execute("native-raw-accessibility " + launched["appId"], operation)

        tree = wait(accessibility, "Raw accessibility application did not register")
        if not any(node["role"] == "drawing area" for node in tree) or any(node["editableText"] for node in tree):
            raise RuntimeError("Raw fixture must expose a drawing area without editable text")
        report["accessibility"] = tree
        initial = wait(read_state, "Raw fixture initial state unavailable")
        if initial["text"] or initial["clicks"] or initial["scrolls"]:
            raise RuntimeError("Raw fixture was not fresh")

        def capture(name):
            from PIL import Image

            frame = action("observe")
            pixels = base64.b64decode(frame["image"], validate=True)
            (retained / (name + ".png")).write_bytes(pixels)
            with Image.open(BytesIO(pixels)) as image:
                image.load()
                rgba = image.convert("RGBA")
            if rgba.size != (frame["width"], frame["height"]) or rgba.width < 350 or rgba.height < 200:
                raise RuntimeError("Raw canvas capture dimensions differ")
            if rgba.getextrema()[3][0] != 255 or any(abs(actual - expected) > 1 for actual, expected in
                                                 zip(rgba.getpixel((10, 190)), (15, 23, 38, 255))):
                return None
            # Text baseline is100; the requested cursor starts at150, outside this region.
            region = rgba.crop((20, 65, rgba.width - 20, 120))
            return hashlib.sha256(region.tobytes()).hexdigest()

        before = wait(lambda: capture("before"), "Raw canvas initial pixels are not painted")
        if options.barrier_fd is not None:
            (work / "ready").write_text(options.label)
            print(json.dumps({"ready": str(work / "ready")}), flush=True)
            if not select.select([options.barrier_fd], [], [], 30)[0] or os.read(options.barrier_fd, 1) != b"1":
                raise RuntimeError("Raw input barrier was not released")
            os.close(options.barrier_fd)
        message = "Native raw " + options.label + " 0123 مرحبا"
        action("click", x=250, y=150)
        action("text", text=message)
        action("key", key="BackSpace")
        action("text", text=message[-1])
        action("scroll", x=250, y=150, dy=1)
        final = wait(lambda: (value if (value := read_state()) and value["text"] == message
                              and value["clicks"] == 1 and value["scrolls"] == 1 else None),
                     "Raw click, key, text and wheel readback differ")
        if abs(final["x"] - 250) > 1 or abs(final["y"] - 150) > 1:
            raise RuntimeError("Raw click did not land at the requested canvas coordinates")
        after = wait(lambda: (value if (value := capture("after")) and value != before else None),
                     "Raw input did not produce fresh changed canvas pixels")
        report.update(initialState=initial, finalState=final, messageSha256=hashlib.sha256(message.encode()).hexdigest(),
                      beforeRegionSha256=before, afterRegionSha256=after)
        if loaded_plugin(plan["compositor"][0], report["sourceSha256"]["experiments/ghost-cursor/plugin/ghostinput.cpp"]) != binding:
            raise RuntimeError("Raw task plugin binding changed")
        report["complete"] = True
    except BaseException as error:
        report["errors"].append(repr(error))
    finally:
        if session:
            try:
                session.close()
            except BaseException as error:
                report["cleanupErrors"].append(repr(error))
        if app:
            for name in ("application.json", "supervisor.json", "worker.log"):
                try:
                    source = app.profile / name
                    if source.is_file():
                        shutil.copyfile(source, retained / name)
                except BaseException as error:
                    report["cleanupErrors"].append(repr(error))
        if control:
            try:
                journal = control.inspect()
                report["journal"] = journal
                begins = {row["id"] for row in journal["events"] if row["phase"] == "begin"}
                finishes = {row["id"] for row in journal["events"] if row["phase"] == "finish"}
                if begins != finishes or journal["unresolved"]:
                    raise RuntimeError("Raw task has unmatched action outcomes")
                if report["complete"] and any(row.get("outcome") != "success" for row in journal["events"] if row["phase"] == "finish"):
                    raise RuntimeError("Raw task contains failed action outcomes")
            except BaseException as error:
                report["cleanupErrors"].append(repr(error))
            finally:
                try:
                    control.close()
                except BaseException as error:
                    report["cleanupErrors"].append(repr(error))
        if report["errors"] or report["cleanupErrors"]:
            report["complete"] = False
        if not launch_attempted and work is not None:
            try:
                shutil.rmtree(work)
            except BaseException as error:
                report["cleanupErrors"].append(repr(error))
                report["complete"] = False
        path = retained / "report.json" if retained is not None else None
        try:
            if path is None:
                raise RuntimeError("Raw task report directory is unavailable")
            path.write_text(json.dumps(report, indent=2) + "\n")
        except BaseException as error:
            report["errors"].append(repr(error))
            report["complete"] = False
            print(json.dumps({"reportRetentionFailed": True, "report": report}), file=sys.stderr, flush=True)
        print(json.dumps({"complete": report["complete"], "report": str(path) if path is not None else None}), flush=True)
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
