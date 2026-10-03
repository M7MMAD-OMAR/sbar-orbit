#!/usr/bin/python3
"""Measure two controlled toolkit workers and reap their private job helpers."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from action_control import ActionControl
from ghost import window_for
from lab import guard
from process_scope import processes, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
pids = [int(value) for value in sys.argv[1:3]]
assert len(pids) == 2
windows = [window_for(pid) for pid in pids]
directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
with ActionControl(directory) as control:
    offset = len(control.inspect()["events"])
baseline = processes()
actors = []
results = []
helpers = []
try:
    for name, pid in zip(("qt_task.py", "writer_task.py"), pids):
        started = time.monotonic()
        process = subprocess.Popen(["/usr/bin/python3", str(root / name), str(pid)],
                                   env=dict(os.environ, ORBIT_WRITER_CHUNK="16"),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        actors.append((process, started))
    for process, started in actors:
        output, error = process.communicate(timeout=30)
        assert process.returncode == 0, (process.returncode, output.decode(), error.decode())
        results.append({"started": started, "finished": time.monotonic(),
                        "exit": process.returncode, "result": json.loads(output)})
    with ActionControl(directory) as control:
        journal = control.inspect()
    assert not journal["unresolved"], journal
    events = journal["events"][offset:]
    finishes = {e["id"]: e for e in events if e["phase"] == "finish"}
    intervals = []
    for window in windows:
        begins = [e for e in events if e["phase"] == "begin" and
                  len(parts := e.get("request", "").split()) > 1 and parts[1] == window["address"]]
        assert begins, window
        assert all(finishes[e["id"]]["outcome"] == "success" for e in begins), begins
        intervals.append({"address": window["address"], "requests": len(begins),
                          "first": min(e["epoch_ns"] for e in begins),
                          "last": max(finishes[e["id"]]["epoch_ns"] for e in begins)})
    overlap = (min(i["last"] for i in intervals) - max(i["first"] for i in intervals)) / 1e9
    assert overlap > 0, intervals
finally:
    for process, _ in actors:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    leftovers = processes() - baseline
    for pid, started in sorted(leftovers):
        try:
            name = Path(f"/proc/{pid}/comm").read_text().strip()
        except (FileNotFoundError, ProcessLookupError):
            name = "already-exited"
        helpers.append({"pid": pid, "started": started, "name": name})
    terminate(leftovers)
print(json.dumps({"task": "controlled-qt-writer-pair", "pass": True, "actors": results,
                  "native_intervals": intervals, "native_overlap_seconds": overlap,
                  "reaped_private_helpers": helpers}))
