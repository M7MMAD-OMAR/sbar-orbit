#!/usr/bin/python3
"""Measure launch and raw editing of a fresh native GTK4 editor in the lab."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

from lab import guard
from process_scope import identity, terminate

guard(os.environ)
here = Path(__file__).resolve().parent
launch = subprocess.run(["/usr/bin/python3", str(here / "ghost.py"), "launch", "--raw", "--",
                         "/usr/bin/gnome-text-editor", "--standalone"],
                        check=True, text=True, capture_output=True)
window = json.loads(launch.stdout)
owned = identity(window["pid"])
try:
    print(json.dumps({"launch": window}), flush=True)
    deadline = time.monotonic() + 5
    while True:
        tree = subprocess.run(["/usr/bin/python3", str(here / "ghost.py"), "snapshot", str(window["pid"])],
                              check=True, text=True, capture_output=True).stdout
        editable = next((re.search(r"\[(e\d+)\]", line).group(1)
                         for line in tree.splitlines() if "] text" in line and line.endswith(" editable")), None)
        if editable:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Editor accessibility did not become ready: {tree}")
        time.sleep(0.1)
    print(json.dumps({"launch": window, "tree": tree}), flush=True)
    subprocess.run(["/usr/bin/python3", str(here / "native_text_task.py"), str(window["pid"]), editable], check=True)
finally:
    if owned:
        terminate({owned})
