#!/usr/bin/python3
"""Measure two controlled raw canvases without an editable accessibility path."""
import json
import os
from pathlib import Path
import shlex
import subprocess

from action_control import ActionControl
from lab import guard
from process_scope import identity, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
owned = set()
windows = []
paths = []
directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
with ActionControl(directory) as control:
    offset = len(control.inspect()["events"])
try:
    for index in range(2):
        events = lab / f"controlled-canvas-{os.getpid()}-{index}.jsonl"
        line = "exec " + shlex.join(["/usr/bin/python3", str(root / "canvas.py")]) + " > " + shlex.quote(str(events))
        output = subprocess.check_output(["/usr/bin/python3", str(root / "ghost.py"), "launch", "--raw", "--",
                                          "/bin/sh", "-c", line], text=True, timeout=25)
        window = json.loads(output)
        item = identity(window["pid"])
        assert item, window
        owned.add(item)
        windows.append(window)
        paths.append(events)
    arguments = [value for window, events in zip(windows, paths) for value in (window["address"], str(events))]
    output = subprocess.check_output(["/usr/bin/python3", str(root / "two_tasks.py"), *arguments],
                                     text=True, timeout=20)
    result = json.loads(output)
    with ActionControl(directory) as control:
        journal = control.inspect()
    assert not journal["unresolved"], journal
    entries = journal["events"][offset:]
    finishes = {e["id"]: e for e in entries if e["phase"] == "finish"}
    begins = [e for e in entries if e["phase"] == "begin" and e.get("request", "").startswith("ghost-")
              and not e["request"].startswith("ghost-cli ")]
    assert len(begins) == 12, begins
    assert all(finishes[e["id"]]["outcome"] == "success" for e in begins), begins
    for window in windows:
        assert any(e["request"].startswith("ghost-click " + window["address"]) for e in begins)
    print(json.dumps({"task": "two-controlled-raw-canvases", "pass": True,
                      "native_requests": len(begins), "workers": result}))
finally:
    terminate(owned)
