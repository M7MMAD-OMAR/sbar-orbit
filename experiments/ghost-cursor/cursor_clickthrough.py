#!/usr/bin/python3
"""Measure an actual lab pointer click through the rendered agent cursor."""
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

from ghost import clients, hypr
from lab import guard

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
events = lab / "cursor-clickthrough-events.jsonl"
errors = lab / "cursor-clickthrough-stderr.log"
report = {"scope": "Private native lab click-through, not owner-session acceptance",
          "source_sha256": hashlib.sha256((root / "plugin/ghostinput.cpp").read_bytes()).hexdigest(),
          "pass": False}
address = None
process = None
shown_here = False


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


try:
    with events.open("w") as out, errors.open("w") as err:
        process = subprocess.Popen(["/usr/bin/python3", str(root / "canvas.py")], stdout=out, stderr=err)
    window = wait_for(lambda: next((c for c in clients() if c["pid"] == process.pid), None), "fixture mapping")
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
    dispatch("focuswindow address:" + other["address"])
    answer = hypr(f"ghost-cursor {address} 250 150").strip()
    assert answer == "ok", answer
    dispatch("focuswindow address:" + address)
    time.sleep(0.2)
    window = next(c for c in clients() if c["address"] == address)
    before = wait_for(state, "initial event state")
    x, y = window["at"][0] + 253, window["at"][1] + 155
    subprocess.run([str(root / "plugin/.deps/person-pointer"), str(x), str(y), "1920", "1200"],
                   check=True, capture_output=True, timeout=5)
    after = wait_for(lambda: (v if (v := state())["clicks"] == before["clicks"] + 1 else None), "click reception")
    assert abs(after["x"] - 253) < 1 and abs(after["y"] - 155) < 1, after
    subprocess.run(["grim", str(lab / "cursor-clickthrough.png")], check=True, timeout=10)
    report.update({"pass": True, "before": before, "after": after,
                   "screen_click": [x, y], "cursor_local_hotspot": [250, 150],
                   "click_inside_arrow": True, "fixture_pid": process.pid})
except BaseException as error:
    report["error"] = repr(error)
    raise
finally:
    if address:
        report["hide_reply"] = hypr(f"ghost-hide-cursor {address}").strip()
    if process and process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    if shown_here:
        dispatch("togglespecialworkspace ghost")
    (lab / "cursor-clickthrough-report.json").write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=True))
