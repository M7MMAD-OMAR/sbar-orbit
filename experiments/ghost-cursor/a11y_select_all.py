#!/usr/bin/python3
"""Self-test helper: select every character of the person's stand-in through AT-SPI.
A deliberate violation: nothing moves or gains focus, yet the person's next keystroke would
replace their whole document. The harness must fail it (B3)."""
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
d = Atspi.get_desktop(0)
for i in range(d.get_child_count()):
    a = d.get_child_at_index(i)
    if a is None:
        continue
    stack = [a]
    while stack:
        e = stack.pop()
        if e.get_role_name() == "frame" and e.get_name() != "person-standin":
            continue
        if e.get_role_name() == "text" and e.get_text_iface():
            n = Atspi.Text.get_character_count(e)
            if n:
                Atspi.Text.add_selection(e, 0, n)
        stack += [e.get_child_at_index(k) for k in range(e.get_child_count()) if e.get_child_at_index(k)]
