#!/usr/bin/python3
"""A failed native launch must clean its root even without the launch tag."""
import json
import argparse
import os
from pathlib import Path
import subprocess

from action_control import ActionControl
from lab import guard
from process_scope import processes, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--ghost", type=Path, default=root / "ghost.py")
args = parser.parse_args()
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
before = processes()
markers = set(lab.glob("raw-launch-*"))
directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
with ActionControl(directory) as control:
    offset = len(control.inspect()["events"])
try:
    result = subprocess.run(["/usr/bin/python3", str(args.ghost), "launch", "--",
                             "/usr/bin/env", "-u", "ORBIT_AGENT_LAUNCH_ID", "/usr/bin/sleep", "30"],
                            text=True, capture_output=True, timeout=25)
    assert result.returncode != 0 and "no matching window" in result.stderr, result
    leftovers = processes() - before
    assert not leftovers, leftovers
    assert set(lab.glob("raw-launch-*")) == markers
    with ActionControl(directory) as control:
        journal = control.inspect()
    assert not journal["unresolved"]
    events = journal["events"][offset:]
    assert len(events) == 2 and events[0]["phase"] == "begin" and events[1]["outcome"] == "error", events
    print(json.dumps({"task": "stripped-environment-failed-launch", "pass": True,
                      "leftovers": 0, "markers_left": 0, "logged_outcome": "error"}))
finally:
    terminate(processes() - before)
