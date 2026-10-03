#!/usr/bin/python3
"""Measure native Writer editing and scroll readback inside the private lab."""
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import uno

from lab import guard
from ghost import hypr, app, window_for, Atspi

guard(os.environ)
pid = int(sys.argv[1])
window = window_for(pid)
address = window["address"]
assert window["workspace"]["name"] == "special:ghost"
pipe = "orbit_" + Path(os.environ["XDG_RUNTIME_DIR"]).parent.name.replace("-", "_") + "_writer_quoted"
local_context = uno.getComponentContext()
resolver = local_context.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local_context)
context = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
enumeration = desktop.getComponents().createEnumeration()
documents = []
while enumeration.hasMoreElements():
    component = enumeration.nextElement()
    if component.supportsService("com.sun.star.text.TextDocument"):
        documents.append(component)
assert len(documents) == 1, len(documents)
document = documents[0]


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


def click(element):
    r = Atspi.Component.get_extents(element, Atspi.CoordType.WINDOW)
    x, y = r.x + min(30, r.width // 2), r.y + r.height // 2
    assert 0 <= x < window["size"][0] and 0 <= y < window["size"][1], (x, y)
    command("ghost-click", x, y)
    return x, y


def paragraphs():
    return [e for e in walk(find("document text"))
            if e.get_role_name() == "paragraph" and e.get_text_iface()]


def read():
    return document.Text.String


def visible_read():
    return "\n".join(Atspi.Text.get_text(e, 0, -1) for e in paragraphs())


def capture():
    return subprocess.run(["grim", "-T", window["stableId"], "-"],
                          capture_output=True, check=True, timeout=10).stdout


before = read()
before_pixels = capture()
bold = find("toggle button", "Bold")
bold_before = Atspi.Value.get_current_value(bold)
click(bold)
time.sleep(0.2)
bold_after = Atspi.Value.get_current_value(bold)
assert bold_after != bold_before, (bold_before, bold_after)
click(paragraphs()[0])
command("ghost-key", "ctrl+a")
time.sleep(0.2)
message = "Native Writer 0123\n\u0645\u0631\u062d\u0628\u0627\n" + "\n".join(
    f"Writer line {i:03d}" for i in range(80))
chunk_size = int(os.environ.get("ORBIT_WRITER_CHUNK", str(len(message))))
assert 1 <= chunk_size <= len(message), chunk_size
for offset in range(0, len(message), chunk_size):
    command("ghost-texthex", message[offset:offset + chunk_size].encode("utf-8").hex())
    if chunk_size < len(message):
        time.sleep(0.02)
        prefix = message[:offset + chunk_size]
        deadline = time.monotonic() + 2
        while read() != prefix and time.monotonic() < deadline:
            time.sleep(0.02)
        assert read() == prefix, (offset, repr(read()), repr(prefix))
time.sleep(0.4)
observed = read()
assert observed == message, repr(observed)
visible_text = visible_read()
assert visible_text and message.endswith(visible_text), repr(visible_text)
command("ghost-key", "shift+Home")
time.sleep(0.1)
last = paragraphs()[-1]
assert Atspi.Text.get_n_selections(last) == 1
selected = Atspi.Text.get_selection(last, 0)
assert (selected.start_offset, selected.end_offset) == (0, len("Writer line 079")), selected
command("ghost-key", "ctrl+Home")
deadline = time.monotonic() + 3
while not visible_read().startswith("Native Writer 0123"):
    if time.monotonic() >= deadline:
        raise RuntimeError("Writer did not expose the start of the document")
    time.sleep(0.05)
first = paragraphs()[0]
deadline = time.monotonic() + 3
stable = 0
previous_y = None
while True:
    r = Atspi.Component.get_extents(first, Atspi.CoordType.WINDOW)
    stable = stable + 1 if r.y == previous_y and r.y >= 0 else 0
    if stable >= 3:
        break
    if time.monotonic() >= deadline:
        raise RuntimeError("Writer did not settle at the start of the document")
    previous_y = r.y
    time.sleep(0.1)
top_before = r.y
scroll_text_before = visible_read()
scroll_pixels_before = capture()
command("ghost-scroll", r.x + 30, r.y + r.height // 2, 10)
time.sleep(0.5)
top_after = Atspi.Component.get_extents(first, Atspi.CoordType.WINDOW).y
scroll_text_after = visible_read()
assert scroll_text_after != scroll_text_before, (scroll_text_before, scroll_text_after)
first_after = scroll_text_after.split("\n")[0]
assert first_after.startswith("Writer line "), repr(first_after)
assert message.find(first_after) > 0, repr(first_after)
# The previous paragraph may no longer be exposed; -1 is not a pixel position.
if top_after >= 0:
    assert top_after < top_before, (top_before, top_after)
after_pixels = capture()
command("ghost-release")
assert scroll_pixels_before != after_pixels
print(json.dumps({"task": "libreoffice-writer", "before": before, "text": observed,
                  "accessible_visible_text": visible_text, "full_readback": "UNO Text.String",
                  "bold": [bold_before, bold_after], "selected": "Writer line 079",
                  "scroll_first_paragraph_y": [top_before, top_after],
                  "scroll_visible_first": [scroll_text_before.split("\n")[0], first_after],
                  "input_chunk_characters": chunk_size,
                  "initial_pixels_sha256": hashlib.sha256(before_pixels).hexdigest(),
                  "pixels_sha256": [hashlib.sha256(scroll_pixels_before).hexdigest(),
                                    hashlib.sha256(after_pixels).hexdigest()]}))
