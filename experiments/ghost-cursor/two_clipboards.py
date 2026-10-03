#!/usr/bin/python3
"""Measure distinct private clipboard text for two concurrent native clients."""
import json
import os
import subprocess
import time
from pathlib import Path
from lab import guard
from action_control import ActionControl

guard(os.environ)
root = Path(__file__).resolve().parent
messages = ["First agent clipboard 012345", "Second agent clipboard abcdef"]
actors = []
results = []
directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
with ActionControl(directory) as control:
    offset = len(control.inspect()["events"])
try:
    for message in messages:
        start = time.monotonic()
        process = subprocess.Popen(["/usr/bin/python3", str(root / "clipboard_task.py"), message],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        actors.append((process, start))
    assert all(process.poll() is None for process, _ in actors)
    for (process, start), expected in zip(actors, messages):
        output, error = process.communicate(timeout=25)
        end = time.monotonic()
        assert process.returncode == 0, (output.decode(), error.decode())
        result = json.loads(output)
        assert result["text"] == expected and result["pass"], result
        results.append({"text": result["text"], "address": result["address"], "started": start, "finished": end})
    overlap = min(r["finished"] for r in results) - max(r["started"] for r in results)
    assert overlap > 0, results
    with ActionControl(directory) as control:
        journal = control.inspect()
    assert not journal["unresolved"], journal
    entries = journal["events"][offset:]
    begins = [e for e in entries if e["phase"] == "begin"]
    finishes = {e["id"]: e for e in entries if e["phase"] == "finish"}
    for result in results:
        address = result["address"]
        required = {f"ghost-click {address} 250 75", f"ghost-key {address} ctrl+a",
                    f"ghost-key {address} ctrl+c", f"ghost-key {address} BackSpace",
                    f"ghost-key {address} ctrl+v", f"ghost-release {address}"}
        actual = {e.get("request") for e in begins}
        assert required <= actual, (required - actual, entries)
        assert all(finishes[e["id"]]["outcome"] == "success" for e in begins if e.get("request") in required)
    print(json.dumps({"task": "two-native-private-clipboards", "pass": True,
                      "overlap_seconds": overlap, "actors": results,
                      "native_action_records": 12, "unresolved": []}))
finally:
    for process, _ in actors:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
