"""Measure image versus accessibility text observation for one open window.

Usage: a11y-measure.py ADDRESS RUNS [NAME ...]
Reads the window from the compositor, times the same grim toplevel capture the native worker uses and
the same bounded tree query, and writes one cropped PNG per NAME at the center of that control's box so
a person can see whether the box center is on the right control. Sends no input.
"""
import json
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.native import a11y

address, runs, names = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
clients = json.loads(subprocess.run(["/usr/bin/hyprctl", "clients", "-j"], capture_output=True, check=True).stdout)
window = next(c for c in clients if c["address"] == address)
pid, title, stable = window["pid"], window["title"], window["stableId"]
runtime = "/run/user/1000"


def capture():
    started = time.perf_counter()
    data = subprocess.run(["/usr/bin/grim", "-T", stable, "-"], capture_output=True, check=True).stdout
    return len(data), (time.perf_counter() - started) * 1000


def tree():
    started = time.perf_counter()
    reply = a11y.read_tree(pid, title, runtime)
    size = len(json.dumps(reply.get("nodes", []), ensure_ascii=False, separators=(",", ":")))
    return reply, size, (time.perf_counter() - started) * 1000


for label, call in (("image", capture), ("text", tree)):
    results = [call() for _ in range(runs)]
    ms = sorted(r[-1] for r in results)
    size = results[0][0] if label == "image" else results[0][1]
    print(label, "bytes", size, "median_ms", round(ms[len(ms) // 2], 1), "min_ms", round(ms[0], 1), "max_ms", round(ms[-1], 1))

reply = tree()[0]
print("status", reply["status"], "nodes", len(reply.get("nodes", [])), "toolkit", reply.get("toolkit"), "truncated", reply.get("truncated"))
print("compositor at", window["at"], "size", window["size"])
if not names:
    print("nodes", " | ".join(n["role"] + ":" + n.get("name", "")[:16] for n in reply.get("nodes", [])[:28]))
for name in names:
    node = next((n for n in reply.get("nodes", []) if n.get("name") == name), None)
    if node is None:
        print("no node named", name)
        continue
    x, y, w, h = node["box"]
    cx, cy = x + w // 2, y + h // 2
    # Window local logical point to a global crop 40 by 24 around the box center.
    gx, gy = window["at"][0] + cx - 20, window["at"][1] + cy - 12
    out = Path(sys.argv[0]).resolve().parents[1] / ("a11y-crop-" + "".join(c for c in name if c.isalnum()) + ".png")
    subprocess.run(["/usr/bin/grim", "-g", f"{gx},{gy} 40x24", str(out)], check=True)
    print("control", repr(name), "box", node["box"], "center", [cx, cy], "crop", out)
