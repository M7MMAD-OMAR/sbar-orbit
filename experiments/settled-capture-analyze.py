#!/usr/bin/python3
"""Judge settled-capture-measure.ts output. Needs Pillow; this is a developer measurement, not product code.

A frame is stale when it differs from the observe taken 900 ms later by more than 0.2 percent of its
blocks. A blinking caret changes about 0.03 percent, so it does not count; a missing result does. That
limit can hide a small miss on a large window, so a second, strict count is also reported: more than
12 blocks of 8 pixels (a caret is up to about 8). Stale frames must be 0 on both. Modes come from runs.json.
"""
import json
from pathlib import Path
import statistics
import sys

from PIL import Image

BLOCK, LEVEL, LIMIT = 8, 8, 0.2


def blocks(path):
    image = Image.open(path).convert("RGB")
    return image.resize((image.width // BLOCK, image.height // BLOCK), Image.BOX)


def changed_percent(first, second):
    a, b = blocks(first), blocks(second)
    width, height = min(a.width, b.width), min(a.height, b.height)
    pa, pb = a.load(), b.load()
    count = sum(1 for y in range(height) for x in range(width)
                if max(abs(pa[x, y][k] - pb[x, y][k]) for k in range(3)) > LEVEL)
    return 100 * count / (width * height), count


def p95(values):
    return sorted(values)[min(len(values) - 1, -(-len(values) * 95 // 100) - 1)]


directory = Path(sys.argv[1])
everything = json.loads((directory / "runs.json").read_text())
report = {}
for mode in dict.fromkeys(row["mode"] for row in everything):
    rows = [row for row in everything if row["mode"] == mode]
    judged = [changed_percent(directory / f"{mode}-{row['run']}.png", directory / f"final-{row['run']}.png") for row in rows]
    stale = [percent > LIMIT for percent, _ in judged]
    strict = [count > 12 for _, count in judged]
    # As the agent lives it: a stale first frame costs one more observe, so one more call.
    cost = [row["ms"] + (row["extraObserveMs"] if flag else 0) for row, flag in zip(rows, stale)]
    calls = [row["calls"] + (1 if flag else 0) for row, flag in zip(rows, stale)]
    entry = {"runs": len(rows), "staleFrames": sum(stale), "strictStale": sum(strict), "medianMs": round(statistics.median(cost)),
             "p95Ms": round(p95(cost)), "medianCalls": statistics.median(calls)}
    if rows[0]["settle"]:
        entry["unsettled"] = sum(1 for row in rows if not row["settle"]["settled"])
        entry["unchanged"] = sum(1 for row in rows if row["settle"]["changed"] is not True)
        entry["medianWaitedMs"] = statistics.median(row["settle"]["waitedMs"] for row in rows)
        entry["medianCaptures"] = statistics.median(row["settle"]["captures"] for row in rows)
    report[mode] = entry
print(json.dumps(report, indent=2))
