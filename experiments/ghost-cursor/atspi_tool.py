#!/usr/bin/python3
"""Minimal AT-SPI agent actions, used by the probes.

    atspi_tool.py tree APP [DEPTH]
    atspi_tool.py press APP NAME [NAME...]       do the first action of each named button
    atspi_tool.py text APP                       print every text field's contents
    atspi_tool.py settext APP INDEX TEXT         replace text field INDEX via EditableText
    atspi_tool.py inserttext APP INDEX TEXT      insert at the caret via EditableText
APP is pid:N (exact process) or a substring of the accessible application name.
"""
import sys
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def app(name):
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a is None:
            continue
        if name.startswith("pid:"):
            if a.get_process_id() == int(name[4:]):
                return a
        elif name.lower() in (a.get_name() or "").lower():
            return a
    sys.exit(f"no application matching {name!r}")


def walk(a, fn, depth=0, maxd=60):
    fn(a, depth)
    if depth < maxd:
        for i in range(a.get_child_count()):
            c = a.get_child_at_index(i)
            if c is not None:
                walk(c, fn, depth + 1, maxd)


def texts(root):
    out = []
    def fn(a, _):
        if a.get_role_name() in ("text", "entry", "terminal", "paragraph", "document text") and a.get_text_iface():
            out.append(a)
    walk(root, fn)
    return out


def text_of(a):
    return Atspi.Text.get_text(a, 0, Atspi.Text.get_character_count(a))


def main():
    cmd, name, *rest = sys.argv[1:]
    root = app(name)
    if cmd == "tree":
        maxd = int(rest[0]) if rest else 20
        def fn(a, d):
            ai = a.get_action_iface()
            acts = [Atspi.Action.get_action_name(a, i) for i in range(Atspi.Action.get_n_actions(a))] if ai else []
            states = a.get_state_set()
            st = [s for s in ("focused", "editable", "showing") if states.contains(getattr(Atspi.StateType, s.upper()))]
            print("  " * d + f"{a.get_role_name()} {a.get_name()!r} acts={acts[:4]} {st}")
        walk(root, fn, maxd=maxd)
    elif cmd == "press":
        found = {}
        def fn(a, _):
            if a.get_role_name() in ("button", "push button", "toggle button") and a.get_action_iface():
                found.setdefault(a.get_name(), a)
        walk(root, fn)
        for n in rest:
            if n not in found:
                sys.exit(f"no button {n!r}")
            if not Atspi.Action.do_action(found[n], 0):
                sys.exit(f"action failed on {n!r}")
    elif cmd == "text":
        for i, t in enumerate(texts(root)):
            print(i, repr(text_of(t)))
    elif cmd in ("settext", "inserttext"):
        t = texts(root)[int(rest[0])]
        e = t.get_editable_text_iface()
        if e is None:
            sys.exit("no EditableText interface")
        if cmd == "settext":
            ok = Atspi.EditableText.set_text_contents(t, rest[1])
        else:
            pos = Atspi.Text.get_caret_offset(t)
            ok = Atspi.EditableText.insert_text(t, max(pos, 0), rest[1], len(rest[1].encode()))
        if not ok:
            sys.exit("edit refused")
        print(repr(text_of(t)))


if __name__ == "__main__":
    main()
