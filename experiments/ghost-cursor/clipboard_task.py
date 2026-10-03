#!/usr/bin/python3
"""Launch, copy and paste in a native background app, then reap it."""
import json
import os
import subprocess
import time
import sys
from pathlib import Path

from lab import guard
from ghost import hypr
from process_scope import identity, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
events = lab / f"clipboard-fixture-{os.getpid()}.jsonl"
message = sys.argv[1] if len(sys.argv) > 1 else "Agent clipboard 0123"


def command(name, *args):
    answer = hypr(" ".join([name, address, *map(str, args)])).strip()
    assert answer.startswith("ok"), (name, answer)


def wait_text(expected):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        lines = events.read_text().splitlines()
        if lines and json.loads(lines[-1])["text"] == expected:
            return
        time.sleep(0.05)
    raise AssertionError((expected, events.read_text()))


owned = None
try:
    window = json.loads(subprocess.check_output(
        ["/usr/bin/python3", str(root / "ghost.py"), "launch", "--raw", "--", "/usr/bin/python3",
         str(root / "clipboard_fixture.py"), str(events), message], text=True, timeout=25))
    owned = identity(window["pid"])
    address = window["address"]
    wait_text(message)
    command("ghost-click", 250, 75)
    command("ghost-key", "ctrl+a")
    command("ghost-key", "ctrl+c")
    time.sleep(0.3)
    command("ghost-key", "BackSpace")
    wait_text("")
    command("ghost-key", "ctrl+v")
    wait_text(message)
    command("ghost-release")
    print(json.dumps({"task": "native-background-copy-paste", "pass": True, "text": message,
                      "address": address}))
finally:
    if owned:
        terminate({owned})
