#!/usr/bin/python3
"""One measured raw-input task. Run only under lab.py and harness.py."""
import json
import subprocess
import sys
import time
from pathlib import Path

from ghost import hypr
from lab import guard
import os

guard(os.environ)
address, events = sys.argv[1:3]
message = sys.argv[3] if len(sys.argv) > 3 else "Agent 0123"
assert message


def command(name, *args):
    return hypr(" ".join([name, address, *map(str, args)]))


before = json.loads(Path(events).read_text().splitlines()[-1])
for _ in before["text"]:
    command("ghost-key", "BackSpace")
command("ghost-click", 250, 150)
command("ghost-texthex", message.encode("utf-8").hex())
command("ghost-key", "BackSpace")
command("ghost-texthex", message[-1].encode("utf-8").hex())
command("ghost-scroll", 250, 150, 1)
time.sleep(0.3)
state = json.loads(Path(events).read_text().splitlines()[-1])
command("ghost-release")
assert state["text"] == message, state
assert state["clicks"] == before["clicks"] + 1, state
assert state["scrolls"] == before["scrolls"] + 1, state
print(json.dumps({"task": "raw-canvas", "observed": state}))
