#!/usr/bin/python3
"""A supplied-frame consumer for lifecycle tests. No display or application access."""
import json
import os
from pathlib import Path
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
for line in sys.stdin:
    frame = json.loads(line)
    if mode == "malformed":
        print('{"rendered":false}', flush=True)
    else:
        point = frame["pointer"]
        value = {"rendered": True, "pointer": [point["x"], point["y"]] if point else None,
                 "width": frame["width"], "height": frame["height"]}
        if mode == "appearance":
            config = os.environ.get("XDG_CONFIG_HOME", "")
            value.update(configHome=config, settings=(Path(config) / "gtk-3.0/settings.ini").read_text())
        print(json.dumps(value), flush=True)
    if mode == "close":
        break
