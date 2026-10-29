"""One bounded accessibility tree dump for a single native window, as compact JSON on stdout.

Runs as its own short lived process so a hung application cannot stall the native worker, and so the
worker never links the accessibility libraries. Every string in the output is application controlled
data. The caller treats it as untrusted text and never as an instruction.

Usage: a11y_dump.py PID TITLE MAX_NODES BUDGET_MS
"""
import json
import re
import sys
import time

NAME_LIMIT = 80
TEXT_LIMIT = 120
MAX_DEPTH = 30
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]+")

# Roles that mean something even without a name, so an unnamed one is still worth a line.
KEEP_UNNAMED = {"text", "entry", "password text", "terminal", "document text", "document web", "slider",
                "spin button", "progress bar", "separator", "check box", "radio button", "toggle button",
                "push button", "combo box", "menu item", "page tab", "list item", "tree item", "table cell"}
EDITABLE_TEXT = {"text", "entry", "password text", "terminal", "document text", "document web", "paragraph"}


STRUCTURAL = {"panel", "grouping", "scroll pane", "filler", "viewport", "section", "split pane", "layered pane",
              "redundant object", "generic", "unknown"}


def contains(outer, inner):
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[0] + outer[2] >= inner[0] + inner[2] and outer[1] + outer[3] >= inner[1] + inner[3])


def clean(value, limit):
    """Single line, no control characters, bounded. Application text never keeps its line structure."""
    if not isinstance(value, str):
        return ""
    value = CONTROL.sub(" ", value).strip()
    return value if len(value) <= limit else value[:limit - 1] + "…"


def states_of(node, Atspi):
    """Short state words that change what an agent should do next."""
    try:
        have = node.get_state_set()
    except Exception:
        return None
    contains = have.contains
    S = Atspi.StateType
    if not contains(S.SHOWING):
        return None
    out = []
    if contains(S.FOCUSED):
        out.append("focused")
    if contains(S.SELECTED):
        out.append("selected")
    if contains(S.CHECKED):
        out.append("checked")
    if contains(S.PRESSED):
        out.append("pressed")
    if contains(S.EXPANDED):
        out.append("expanded")
    if contains(S.EDITABLE):
        out.append("editable")
    if not contains(S.ENABLED) and not contains(S.SENSITIVE):
        out.append("disabled")
    if contains(S.MODAL):
        out.append("modal")
    return out


def box_of(node, Atspi):
    """Window local rectangle, which is the surface local space the click actions use."""
    try:
        rect = Atspi.Component.get_extents(node, Atspi.CoordType.WINDOW)
    except Exception:
        return None
    if rect is None or rect.width <= 0 or rect.height <= 0:
        return None
    return [int(rect.x), int(rect.y), int(rect.width), int(rect.height)]


def read_text(node, Atspi):
    try:
        count = Atspi.Text.get_character_count(node)
        if count <= 0:
            return ""
        return clean(Atspi.Text.get_text(node, 0, min(count, TEXT_LIMIT + 1)), TEXT_LIMIT)
    except Exception:
        return ""


def walk(frame, Atspi, max_nodes, deadline):
    """Depth first, document order, with every bound enforced on the way in."""
    nodes, stats = [], {"visited": 0, "truncated": None}
    stack = [(frame, 0)]
    while stack:
        if time.monotonic() > deadline:
            stats["truncated"] = "time"
            break
        node, depth = stack.pop()
        stats["visited"] += 1
        try:
            role = node.get_role_name() or ""
        except Exception:
            continue
        have = states_of(node, Atspi)
        if have is None:
            continue
        name = ""
        try:
            name = clean(node.get_name(), NAME_LIMIT)
        except Exception:
            pass
        box = box_of(node, Atspi)
        actionable = False
        try:
            actionable = Atspi.Action.get_n_actions(node) > 0
        except Exception:
            pass
        text = read_text(node, Atspi) if role in EDITABLE_TEXT or "editable" in have else ""
        interesting = box is not None and (name or text or role in KEEP_UNNAMED or depth == 0)
        if role in STRUCTURAL and not name and depth > 0:
            interesting = False
        # A label that repeats its container's name (a button caption) adds bytes and no information.
        if (interesting and role == "label" and nodes and nodes[-1].get("name") == name
                and contains(nodes[-1]["box"], box)):
            interesting = False
        if interesting:
            if len(nodes) >= max_nodes:
                stats["truncated"] = "nodes"
                break
            entry = {"role": clean(role, 32), "box": box}
            if name:
                entry["name"] = name
            if text and text != name:
                entry["text"] = text
            if have:
                entry["states"] = have
            if actionable:
                entry["act"] = 1
            nodes.append(entry)
        if depth >= MAX_DEPTH:
            continue
        try:
            count = node.get_child_count()
        except Exception:
            continue
        # Reversed so the pop order stays document order.
        children = []
        for index in range(min(count, 512)):
            try:
                child = node.get_child_at_index(index)
            except Exception:
                continue
            if child is not None:
                children.append((child, depth + 1))
        stack.extend(reversed(children))
    return nodes, stats


def pick_frame(app, title, Atspi):
    """The top level window of the application that carries the compositor title."""
    frames = []
    for index in range(min(app.get_child_count(), 64)):
        try:
            child = app.get_child_at_index(index)
            if child is None:
                continue
            role = child.get_role_name()
            if role not in ("frame", "window", "dialog", "alert", "file chooser", "document frame"):
                continue
            frames.append((clean(child.get_name(), 200), child))
        except Exception:
            continue
    if not frames:
        return None
    for name, child in frames:
        if name and name == title:
            return child
    # Compositor titles often add an application suffix to the toolkit name, or the reverse.
    for name, child in frames:
        if name and (title.startswith(name) or name.startswith(title) or name in title):
            return child
    if len(frames) == 1:
        return frames[0][1]
    # Several windows and no title match: refuse to guess which one the caller means.
    return False


def main(argv):
    pid, title, max_nodes, budget_ms = int(argv[0]), argv[1], int(argv[2]), int(argv[3])
    started = time.monotonic()
    deadline = started + budget_ms / 1000
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    app = None
    for index in range(min(desktop.get_child_count(), 256)):
        try:
            candidate = desktop.get_child_at_index(index)
            if candidate is not None and candidate.get_process_id() == pid:
                app = candidate
                break
        except Exception:
            continue
    if app is None:
        return {"status": "unavailable", "reason": "application exposes no accessibility tree"}
    frame = pick_frame(app, title, Atspi)
    if frame is None:
        return {"status": "unavailable", "reason": "application exposes no top level window"}
    if frame is False:
        return {"status": "unavailable", "reason": "no accessible window matches the compositor title"}
    nodes, stats = walk(frame, Atspi, max_nodes, deadline)
    if len(nodes) <= 1:
        return {"status": "unavailable", "reason": "accessible window has no visible content"}
    return {"status": "ok", "toolkit": clean(app.get_toolkit_name() or "", 24), "nodes": nodes,
            "visited": stats["visited"], "truncated": stats["truncated"],
            "ms": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception as error:
        result = {"status": "unavailable", "reason": "accessibility bus unreachable: " + type(error).__name__}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
