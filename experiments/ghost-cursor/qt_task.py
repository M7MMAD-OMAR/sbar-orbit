#!/usr/bin/python3
"""Exercise real Dolphin navigation, selection and scrolling inside the lab."""
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from lab import guard
from ghost import hypr, app, window_for, Atspi

guard(os.environ)
pid = int(sys.argv[1])
window = window_for(pid)
address = window["address"]
assert window["workspace"]["name"] == "special:ghost"


def walk(node):
    yield node
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child:
            yield from walk(child)


def find(role, name=None):
    return next(e for e in walk(app(pid)) if e.get_role_name() == role
                and (name is None or e.get_name() == name))


def command(name, *args):
    return hypr(" ".join([name, address, *map(str, args)]))


def state():
    return json.loads(hypr("ghost-state " + address))


def capture():
    return subprocess.run(["grim", "-T", window["stableId"], "-"],
                          capture_output=True, check=True, timeout=10).stdout


initial_state = state()
assert initial_state["render_unfocused"], initial_state
try:
    before = find("list", "share")
except StopIteration:
    # The retained failed scroll run leaves the app in applications.
    find("list", "applications")
    command("ghost-click", 22, 23)
    deadline = time.monotonic() + 5
    while True:
        try:
            before = find("list", "share")
            break
        except StopIteration:
            if time.monotonic() >= deadline:
                raise RuntimeError("Dolphin did not return to share before the task")
            time.sleep(0.1)
assert before.get_child_count() > 100
before_pixels = capture()
# The breadcrumb's blank area was verified from the native 850x650 capture.
assert window["size"] == [850, 650], window["size"]
command("ghost-click", 500, 23)
time.sleep(0.1)
location = next(e for e in walk(app(pid)) if e.get_text_iface()
                and e.get_state_set().contains(Atspi.StateType.EDITABLE)
                and e.get_state_set().contains(Atspi.StateType.SENSITIVE)
                and e.get_state_set().contains(Atspi.StateType.SHOWING))
command("ghost-key", "ctrl+a")
command("ghost-texthex", "/usr/share/applications".encode().hex())
time.sleep(0.1)
typed = Atspi.Text.get_text(location, 0, -1)
assert typed.rstrip("/") == "/usr/share/applications", typed
command("ghost-key", "Return")
deadline = time.monotonic() + 5
while True:
    try:
        listing = find("list", "applications")
        if listing.get_child_count():
            break
    except StopIteration:
        pass
    if time.monotonic() >= deadline:
        raise RuntimeError("Dolphin did not navigate to applications")
    time.sleep(0.1)
item = listing.get_child_at_index(0)
name = item.get_name()
rect = Atspi.Component.get_extents(item, Atspi.CoordType.WINDOW)
x, y = rect.x + rect.width // 2, rect.y + rect.height // 2
assert 0 <= x < window["size"][0] and 0 <= y < window["size"][1], (x, y, window["size"])
command("ghost-click", x, y)
time.sleep(0.1)
assert item.get_state_set().contains(Atspi.StateType.SELECTED), name
top_before = Atspi.Component.get_extents(item, Atspi.CoordType.WINDOW).y
awake_state = state()
assert not awake_state["suspended"], awake_state
wheel_pixels_before = capture()
command("ghost-scroll", x, y, 10)
time.sleep(0.3)
top_after = Atspi.Component.get_extents(item, Atspi.CoordType.WINDOW).y
assert top_after < top_before, (top_before, top_after)
after_pixels = capture()
evidence = Path(os.environ["XDG_RUNTIME_DIR"]).parent
(evidence / "qt-wheel-before.png").write_bytes(wheel_pixels_before)
(evidence / "qt-wheel-after.png").write_bytes(after_pixels)
assert wheel_pixels_before != after_pixels
back = Atspi.Component.get_extents(find("button", "Back"), Atspi.CoordType.WINDOW)
back_x, back_y = back.x + back.width // 2, back.y + back.height // 2
assert 0 <= back_x < window["size"][0] and 0 <= back_y < window["size"][1]
command("ghost-click", back_x, back_y)
deadline = time.monotonic() + 5
while True:
    try:
        final = find("list", "share")
        if final.get_child_count() > 100:
            break
    except StopIteration:
        pass
    if time.monotonic() >= deadline:
        raise RuntimeError("Dolphin Back action did not restore share")
    time.sleep(0.1)
command("ghost-release")
released_state = state()
assert released_state["suspended"] == initial_state["suspended"], (initial_state, released_state)
print(json.dumps({"task": "qt-dolphin", "typed": typed, "selected": name,
                  "scroll_item_y": [top_before, top_after], "final_list": final.get_name(),
                  "target_states": [initial_state, awake_state, released_state],
                  "initial_pixels_sha256": hashlib.sha256(before_pixels).hexdigest(),
                  "pixels_sha256": [hashlib.sha256(wheel_pixels_before).hexdigest(),
                                    hashlib.sha256(after_pixels).hexdigest()]}))
