#!/usr/bin/python3
"""A supplied-frame consumer for lifecycle tests. No display or application access."""
import json
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
for line in sys.stdin:
    frame = json.loads(line)
    if mode == "malformed":
        print('{"rendered":false}', flush=True)
    else:
        point = frame["pointer"]
        print(json.dumps({"rendered": True, "pointer": [point["x"], point["y"]] if point else None,
                          "width": frame["width"], "height": frame["height"]}), flush=True)
    if mode == "close":
        break
