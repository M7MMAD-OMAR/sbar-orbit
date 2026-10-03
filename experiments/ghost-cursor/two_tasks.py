#!/usr/bin/python3
"""Run two independent raw-input workers and join both before returning."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import subprocess
import sys
import time

task = Path(__file__).with_name("raw_task.py")
first_address, first_events, second_address, second_events = sys.argv[1:]


def worker(address, events, text):
    start = time.monotonic()
    p = subprocess.run(["/usr/bin/python3", str(task), address, events, text],
                       text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return {"start": start, "end": time.monotonic(), "result": json.loads(p.stdout)}


with ThreadPoolExecutor(max_workers=2) as pool:
    first = pool.submit(worker, first_address, first_events, "Alpha agent 0123")
    second = pool.submit(worker, second_address, second_events, "Beta agent 4567")
    tasks = [first.result(), second.result()]
    overlap = min(t["end"] for t in tasks) - max(t["start"] for t in tasks)
    assert overlap > 0, tasks
    print(json.dumps({"tasks": tasks, "overlap_seconds": overlap}))
