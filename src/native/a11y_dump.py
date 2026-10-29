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
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\ufffc]+")

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


DOCUMENT = "document web"


def device_scale(box, chain):
    """Factor by which a web document's extents exceed the window, or 1.

    Chromium and Electron report browser chrome in logical pixels but web content in device pixels, so on
    a 1.5 scale output the document is 1.5 times the window. The signature is a document that starts at
    the window edge and whose far corner is exactly the window's far corner times one factor above 1."""
    if not chain:
        return 1.0
    frame = chain[0][1]
    if frame[2] <= 0 or frame[3] <= 0 or box[0] > SLACK or box[2] <= frame[2] * 1.05:
        return 1.0
    factor = box[2] / frame[2]
    if (abs(box[0] + box[2] - frame[2] * factor) <= SLACK and abs(box[1] + box[3] - frame[3] * factor) <= SLACK
            and factor <= 4):
        return factor
    return 1.0


def scaled(box, unit):
    if unit == 1.0:
        return box
    return [round(box[0] / unit), round(box[1] / unit), max(1, round(box[2] / unit)), max(1, round(box[3] / unit))]


SCROLLING = {"scroll pane", "viewport", "list", "list box", "tree", "tree table", "table", "document web",
             "document frame", "terminal"}
SLACK = 2


def anchor(box, chain, scrolling):
    """Window box of a node whose parent chain is `chain`, as (raw, fixed) frames of its ancestors.

    A toolkit may hand out a child rectangle that is relative to a widget ancestor which the accessible
    tree skips or repeats (GTK4 does: bounds are taken against the widget parent, then summed along the
    accessible parent chain, so a margin container that appears twice is counted twice). The signature is
    a child whose size fits inside its accessible parent but whose offset pushes it outside. Re anchor the
    parent relative offset to the nearest ancestor frame that holds it, and carry every ancestor's
    correction down. Content in a scrolling container is legitimately clipped and is never moved."""
    if not chain:
        return list(box), False
    raw_parent, fixed_parent = chain[-1]
    rel = [box[0] - raw_parent[0], box[1] - raw_parent[1]]
    parent_w, parent_h = fixed_parent[2], fixed_parent[3]
    fits_size = box[2] <= parent_w + SLACK and box[3] <= parent_h + SLACK
    inside = (rel[0] >= -SLACK and rel[1] >= -SLACK and rel[0] + box[2] <= parent_w + SLACK
              and rel[1] + box[3] <= parent_h + SLACK)
    moved = False
    base = fixed_parent
    if fits_size and not inside and not scrolling:
        for raw_up, fixed_up in reversed(chain[:-1]):
            if (rel[0] >= -SLACK and rel[1] >= -SLACK and rel[0] + box[2] <= fixed_up[2] + SLACK
                    and rel[1] + box[3] <= fixed_up[3] + SLACK):
                base, moved = fixed_up, True
                break
    return [base[0] + rel[0], base[1] + rel[1], box[2], box[3]], moved


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
    nodes, stats = [], {"visited": 0, "truncated": None, "recalibrated": 0}
    stack = [(frame, 0, (), False, 1.0)]
    while stack:
        if time.monotonic() > deadline:
            stats["truncated"] = "time"
            break
        node, depth, chain, scrolling, unit = stack.pop()
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
        raw = box_of(node, Atspi)
        box = None
        if raw is not None and role == DOCUMENT and unit == 1.0:
            unit = device_scale(raw, chain)
            stats["deviceScale"] = unit if unit != 1.0 else stats.get("deviceScale")
        if raw is not None:
            raw = scaled(raw, unit)
            box, moved = anchor(raw, chain, scrolling)
            stats["recalibrated"] += moved
            chain = chain + ((raw, box),)
        scrolling = scrolling or role in SCROLLING
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
        if interesting and role == "static" and name and not any(c.isalnum() for c in name):
            interesting = False
        if (interesting and role in ("label", "static") and nodes and name
                and name in (nodes[-1].get("name"), nodes[-1].get("text")) and contains(nodes[-1]["box"], box)):
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
                children.append((child, depth + 1, chain, scrolling, unit))
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
            "recalibrated": stats["recalibrated"], "deviceScale": stats.get("deviceScale"),
            "ms": int((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception as error:
        result = {"status": "unavailable", "reason": "accessibility bus unreachable: " + type(error).__name__}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
