#!/usr/bin/python3
"""Measure distinct private clipboard text for two concurrent native clients."""
import json
import os
import subprocess
import time
from pathlib import Path
from lab import guard

guard(os.environ)
root = Path(__file__).resolve().parent
messages = ["First agent clipboard 012345", "Second agent clipboard abcdef"]
actors = []
results = []
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
        results.append({"text": result["text"], "started": start, "finished": end})
    overlap = min(r["finished"] for r in results) - max(r["started"] for r in results)
    assert overlap > 0, results
    print(json.dumps({"task": "two-native-private-clipboards", "pass": True,
                      "overlap_seconds": overlap, "actors": results}))
finally:
    for process, _ in actors:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
