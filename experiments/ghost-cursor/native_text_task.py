#!/usr/bin/python3
"""Read back raw input in a real native editable text widget, inside the lab."""
import hashlib
import json
import os
import subprocess
import sys
import time

from lab import guard
from ghost import hypr, Atspi, ref, window_for

guard(os.environ)
pid, element = int(sys.argv[1]), sys.argv[2]
window = window_for(pid)
address = window["address"]
widget = ref(pid, element)
assert widget.get_text_iface() and widget.get_component_iface()


def command(name, *args):
    return hypr(" ".join([name, address, *map(str, args)]))


def text():
    return Atspi.Text.get_text(widget, 0, -1)


def pixels():
    return subprocess.run(["grim", "-T", window["stableId"], "-"],
                          check=True, capture_output=True, timeout=10).stdout


before_text = text()
before_pixels = pixels()
extent = Atspi.Component.get_extents(widget, Atspi.CoordType.WINDOW)
x = extent.x + min(100, extent.width // 2)
y = extent.y + min(100, extent.height // 2)
assert 0 <= x < window["size"][0] and 0 <= y < window["size"][1]
command("ghost-click", x, y)
command("ghost-key", "ctrl+a")
message = "Native editor 0123\n" + "\u0645\u0631\u062d\u0628\u0627\n" + "".join(
    f"Agent line {i:03d}\n" for i in range(100))
command("ghost-texthex", message.encode("utf-8").hex())
time.sleep(0.3)
observed = text()
assert observed == message, repr(observed)
command("ghost-key", "ctrl+a")
time.sleep(0.1)
assert Atspi.Text.get_n_selections(widget) == 1
selection = Atspi.Text.get_selection(widget, 0)
assert (selection.start_offset, selection.end_offset) == (0, len(message)), selection
command("ghost-key", "Left")
time.sleep(0.1)
assert Atspi.Text.get_n_selections(widget) == 0
assert Atspi.Text.get_caret_offset(widget) == 0
# Wait for the editor's caret scroll animation before measuring the wheel.
deadline = time.monotonic() + 3
stable = 0
previous_y = None
while True:
    top_before = Atspi.Text.get_character_extents(widget, 0, Atspi.CoordType.WINDOW)
    stable = stable + 1 if top_before.y == previous_y and top_before.y >= extent.y else 0
    if stable >= 3:
        break
    if time.monotonic() >= deadline:
        raise RuntimeError("Editor did not settle at the start of the document")
    previous_y = top_before.y
    time.sleep(0.1)
command("ghost-scroll", x, y, 10)
time.sleep(0.5)
top_after = Atspi.Text.get_character_extents(widget, 0, Atspi.CoordType.WINDOW)
assert top_after.y < top_before.y, (top_before.y, top_after.y)
after_pixels = pixels()
command("ghost-release")
assert before_pixels != after_pixels
assert text() == message
print(json.dumps({"task": "native-text", "pid": pid, "class": window["class"],
                  "before": before_text, "text": observed, "selection": [0, len(message)],
                  "scroll_first_character_y": [top_before.y, top_after.y],
                  "pixels_sha256": [hashlib.sha256(before_pixels).hexdigest(),
                                    hashlib.sha256(after_pixels).hexdigest()]}))
