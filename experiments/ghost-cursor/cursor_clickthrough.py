#!/usr/bin/python3
"""Measure an actual lab pointer click through the rendered agent cursor."""
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from PIL import Image

from ghost import clients, hypr
from lab import guard
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl
from src.native.application import NativeLauncher
from src.native.host import inspect_host
from cursor_cost_probe import loaded_plugin

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
events = lab / "cursor-clickthrough-events.jsonl"
errors = lab / "cursor-clickthrough-stderr.log"
report = {"scope": "Private native lab click-through, not owner-session acceptance",
          "source_sha256": hashlib.sha256((root / "plugin/ghostinput.cpp").read_bytes()).hexdigest(),
          "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "fixture_sha256": hashlib.sha256((root / "canvas.py").read_bytes()).hexdigest(),
          "pointer_sha256": hashlib.sha256((root / "plugin/.deps/person-pointer").read_bytes()).hexdigest(),
          "pointer_source_sha256": hashlib.sha256((root / "person_pointer.c").read_bytes()).hexdigest(),
          "pass": False}
report["runtime_sha256"] = {name: hashlib.sha256((root.parents[1] / name).read_bytes()).hexdigest()
    for name in ["experiments/ghost-cursor/ghost.py", "experiments/ghost-cursor/action_control.py",
                 "experiments/ghost-cursor/lab.py", "experiments/ghost-cursor/cursor_cost_probe.py"]
    + [f"src/native/{name}.py" for name in ("application", "application_worker", "host", "lease", "control", "supervise")]}
address = None
other_address = None
process = None
parked_pointer = None
shown_here = False
failure = None
cleanup_errors = []
control_path = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
control = application = None
original_mode = None


def dispatch(value):
    answer = hypr("dispatch " + value).strip()
    assert answer == "ok", (value, answer)


def wait_for(predicate, label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        if process.poll() is not None:
            raise RuntimeError(f"Fixture exited {process.returncode}: {errors.read_text()}")
        time.sleep(0.05)
    raise TimeoutError(label)


def state():
    lines = events.read_text().splitlines()
    return json.loads(lines[-1]) if lines else None


def park_pointer():
    global parked_pointer
    if parked_pointer is None:
        with (lab / "cursor-parked-pointer.stderr").open("ab") as err:
            parked_pointer = subprocess.Popen([str(root / "plugin/.deps/person-pointer"),
                "100", "100", "1920", "1200", "hold"], stdout=subprocess.DEVNULL, stderr=err)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if parked_pointer.poll() is not None:
            raise RuntimeError("Private parked pointer exited")
        if json.loads(hypr("j/cursorpos")) == {"x": 100, "y": 100}:
            assert not (lab / "cursor-parked-pointer.stderr").stat().st_size, "Private parked pointer emitted stderr"
            return
        time.sleep(0.05)
    raise TimeoutError("Private pointer did not park outside the target")


try:
    control = ActionControl(control_path)
    original_mode = control.inspect()["settings"]["mode"]
    control.configure(mode="full")
    plan = inspect_host(os.environ)
    binding = loaded_plugin(plan["compositor"][0], report["source_sha256"])
    report["loaded_plugin"] = binding
    events.write_text("")
    errors.write_text("")
    parent = lab / "cursor-clickthrough-apps"
    parent.mkdir(mode=0o700, exist_ok=True)
    code = "import runpy,sys;sys.stdout=open(" + repr(str(events)) + ", 'w');runpy.run_path(" + repr(str(root / "canvas.py")) + ",run_name='__main__')"
    application = NativeLauncher(plan, parent, control).launch(["/usr/bin/python3", "-c", code])
    process = application.supervisor
    report["application_unit"] = application.unit
    window = wait_for(lambda: next((c for c in clients() if c["pid"] == application.process[0]), None), "fixture mapping")
    address = window["address"]
    dispatch("movetoworkspacesilent special:ghost,address:" + address)
    dispatch("setfloating address:" + address)
    dispatch("resizewindowpixel exact 720 420,address:" + address)
    dispatch("movewindowpixel exact 600 350,address:" + address)
    monitors = json.loads(hypr("j/monitors"))
    if not monitors[0]["specialWorkspace"]["name"]:
        dispatch("togglespecialworkspace ghost")
        shown_here = True
    dispatch("focuswindow address:" + address)
    # Place the rendered cursor while another client holds the real seat focus.
    other = next(c for c in clients() if c["address"] != address and c["workspace"]["name"] == "special:ghost")
    other_address = other["address"]
    dispatch("focuswindow address:" + other["address"])
    answer = hypr(f"ghost-cursor {address} 250 150").strip()
    assert answer == "ok", answer
    dispatch("focuswindow address:" + address)
    time.sleep(0.2)
    window = next(c for c in clients() if c["address"] == address)
    before = wait_for(state, "initial event state")
    report["window_before_click"] = window
    x, y = window["at"][0] + 253, window["at"][1] + 155
    visible_path = lab / "cursor-clickthrough-visible.png"
    subprocess.run(["grim", str(visible_path)], check=True, timeout=10)
    with Image.open(visible_path) as image:
        visible_pixel = image.convert("RGB").getpixel((x, y))
    assert all(abs(actual - expected) <= 3 for actual, expected in zip(visible_pixel, (26, 36, 51))), visible_pixel
    subprocess.run([str(root / "plugin/.deps/person-pointer"), str(x), str(y), "1920", "1200"],
                   check=True, capture_output=True, timeout=5)
    report["pointer_after_helper"] = json.loads(hypr("j/cursorpos"))
    report["focus_after_helper"] = json.loads(hypr("j/activewindow"))
    report["canvas_after_helper"] = state()
    after = wait_for(lambda: (v if (v := state())["clicks"] == before["clicks"] + 1 else None), "click reception")
    assert abs(after["x"] - 253) < 1 and abs(after["y"] - 155) < 1, after
    subprocess.run(["grim", str(lab / "cursor-clickthrough.png")], check=True, timeout=10)
    park_pointer()
    dispatch("focuswindow address:" + other_address)
    report["hide_proof_reply"] = hypr(f"ghost-hide-cursor {address}").strip()
    assert report["hide_proof_reply"] == "ok"
    dispatch("focuswindow address:" + address)
    time.sleep(0.2)
    hidden_path = lab / "cursor-clickthrough-hidden.png"
    subprocess.run(["grim", str(hidden_path)], check=True, timeout=10)
    with Image.open(hidden_path) as image:
        hidden_pixel = image.convert("RGB").getpixel((x, y))
    assert hidden_pixel != visible_pixel, (visible_pixel, hidden_pixel)
    report.update({"pass": True, "before": before, "after": after,
                   "screen_click": [x, y], "cursor_local_hotspot": [250, 150],
                   "click_inside_arrow": True, "fixture_pid": application.process[0]})
    report.update(visible_pixel=visible_pixel, hidden_pixel=hidden_pixel, overlay_pixel_changed=True)
    assert loaded_plugin(plan["compositor"][0], report["source_sha256"]) == binding
except BaseException as error:
    failure = error
    report["error"] = repr(error)
finally:
    def attempt(operation):
        try:
            operation()
        except BaseException as error:
            cleanup_errors.append(error)

    def hide():
        if other_address:
            park_pointer()
            dispatch("focuswindow address:" + other_address)
        report["hide_reply"] = hypr(f"ghost-hide-cursor {address}").strip()
        assert report["hide_reply"] == "ok"

    if address and report.get("hide_proof_reply") != "ok":
        attempt(hide)
    if application:
        attempt(application.close)
    if parked_pointer:
        attempt(parked_pointer.terminate)
        attempt(lambda: parked_pointer.wait(timeout=3))
        if parked_pointer.poll() is None:
            attempt(parked_pointer.kill)
            attempt(lambda: parked_pointer.wait(timeout=3))
    if shown_here:
        attempt(lambda: dispatch("togglespecialworkspace ghost"))

    def restore_mode():
        control.configure(mode=original_mode)

    if original_mode is not None:
        attempt(restore_mode)
    if control:
        attempt(control.close)
    report["cleanup_errors"] = [repr(error) for error in cleanup_errors]
    if failure or cleanup_errors:
        report["pass"] = False
    attempt(lambda: (lab / "cursor-clickthrough-report.json").write_text(
        json.dumps(report, ensure_ascii=True, indent=2) + "\n"))
    if cleanup_errors:
        report["pass"] = False
        report["cleanup_errors"] = [repr(error) for error in cleanup_errors]
    print(json.dumps(report, ensure_ascii=True))
    failures = ([failure] if failure else []) + cleanup_errors
    if failures:
        print(json.dumps({"errors": [repr(error) for error in failures]}), file=sys.stderr)
        raise BaseExceptionGroup("Cursor proof or cleanup failed", failures)
