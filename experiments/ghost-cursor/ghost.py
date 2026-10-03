#!/usr/bin/python3
"""The agent's tool: operate real applications in the background through accessibility.

    ghost.py launch [--raw] -- CMD...  start CMD hidden; raw mode claims its process before exec
    ghost.py windows                   agent windows: address, pid, class, title
    ghost.py snapshot PID [--all]      numbered elements (refs) of that process's accessible tree
    ghost.py press PID REF             do the element's primary action (click, press, activate)
    ghost.py action PID REF NAME       do a named action
    ghost.py set PID REF TEXT          replace an editable text's contents
    ghost.py type PID REF TEXT         insert TEXT at the caret of an editable text
    ghost.py value PID REF NUMBER      set a slider, spin button or other value
    ghost.py select PID REF            select the element inside its parent (list row, tab, cell)
    ghost.py choose PID REF INDEX      pick option INDEX of a combo box or list (0-based)
    ghost.py scroll PID REF            scroll the element into view
    ghost.py read PID REF              text, value, states and name of the element
    ghost.py wait PID REF TEXT [SECS]  wait until the element's text contains TEXT
    ghost.py capture PID OUT.png       fresh pixels of the process's window, even while hidden

Nothing here moves the pointer, sends a key event, or changes focus. Every action is an
accessibility method call on the target process. Refs come from the last snapshot of that pid.
"""
import json, os, socket, subprocess, sys, time, warnings
from pathlib import Path
warnings.filterwarnings("ignore", category=DeprecationWarning)
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

SPACE = "special:ghost"
STATE = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "ghost-refs"
INTERESTING = {"push button", "button", "toggle button", "check box", "radio button", "menu item", "check menu item",
               "radio menu item", "text", "entry", "password text", "spin button", "slider", "combo box", "list item",
               "table cell", "tree item", "page tab", "link", "terminal", "paragraph", "document text", "heading",
               "label", "static", "status bar", "scroll bar", "menu", "tool bar item", "icon", "image", "section"}


def hypr(cmd):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(f"{os.environ['XDG_RUNTIME_DIR']}/hypr/{os.environ['HYPRLAND_INSTANCE_SIGNATURE']}/.socket.sock")
    s.sendall(cmd.encode())
    out = b""
    while chunk := s.recv(65536):
        out += chunk
    return out.decode()


def clients():
    return json.loads(hypr("j/clients"))


def agent_windows():
    return [c for c in clients() if c["workspace"]["name"] == SPACE]


def app(pid):
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a is not None and a.get_process_id() == pid:
            return a
    sys.exit(f"ghost: no accessible application for pid {pid} (is accessibility enabled for it?)")


def path_of(root, path):
    a = root
    for i in path:
        a = a.get_child_at_index(i)
        if a is None:
            sys.exit("ghost: element is gone, take a new snapshot")
    return a


def describe(a):
    role = a.get_role_name()
    name = (a.get_name() or "").strip()
    out = {"role": role, "name": name[:80]}
    if a.get_text_iface():
        n = Atspi.Text.get_character_count(a)
        out["text"] = Atspi.Text.get_text(a, 0, min(n, 200))
    if a.get_value_iface():
        out["value"] = Atspi.Value.get_current_value(a)
    if a.get_action_iface():
        out["actions"] = [Atspi.Action.get_action_name(a, i) for i in range(Atspi.Action.get_n_actions(a))][:6]
    st = a.get_state_set()
    flags = [s for s in ("editable", "checked", "selected", "focused", "showing", "sensitive", "expanded")
             if st.contains(getattr(Atspi.StateType, s.upper()))]
    out["states"] = flags
    return out


def snapshot(pid, every=False):
    root = app(pid)
    refs, lines = {}, []

    def walk(a, path, depth):
        if depth > 80:
            return
        try:
            role = a.get_role_name()
        except Exception:
            return
        st = a.get_state_set()
        if not every and not st.contains(Atspi.StateType.SHOWING) and depth > 1:
            return
        info = None
        if not every and role == "label":
            parent = a.get_parent()
            if parent is not None and (parent.get_name() or "") == (a.get_name() or ""):
                return  # the text of a button already shown on the button itself
        if every or role in INTERESTING or a.get_action_iface() or a.get_editable_text_iface():
            info = describe(a)
            if every or info["name"] or info.get("text") or info.get("actions") or "editable" in info["states"]:
                ref = f"e{len(refs) + 1}"
                refs[ref] = path
                bits = [f"[{ref}] {role}"]
                if info["name"]:
                    bits.append(repr(info["name"]))
                if info.get("text") and info["text"] != info["name"]:
                    bits.append(f"text={info['text'][:60]!r}")
                if "value" in info:
                    bits.append(f"value={info['value']}")
                bits += [s for s in info["states"] if s in ("editable", "checked", "selected", "expanded")]
                lines.append("  " * min(depth, 12) + " ".join(bits))
        for i in range(a.get_child_count()):
            c = a.get_child_at_index(i)
            if c is not None:
                walk(c, path + [i], depth + 1)

    walk(root, [], 0)
    STATE.mkdir(exist_ok=True)
    (STATE / f"{pid}.json").write_text(json.dumps(refs))
    return "\n".join(lines)


def ref(pid, r):
    refs = json.loads((STATE / f"{pid}.json").read_text())
    if r not in refs:
        sys.exit(f"ghost: unknown ref {r}, take a new snapshot")
    return path_of(app(pid), refs[r])


PRIMARY = ["click", "press", "activate", "toggle", "jump", "open", "default.activate", "select"]


def press(a):
    if not a.get_action_iface():
        sys.exit("ghost: element has no actions")
    names = [Atspi.Action.get_action_name(a, i) for i in range(Atspi.Action.get_n_actions(a))]
    for want in PRIMARY:
        if want in names:
            return Atspi.Action.do_action(a, names.index(want))
    return Atspi.Action.do_action(a, 0)


def window_for(pid):
    for c in clients():
        if c["pid"] == pid:
            return c
    sys.exit(f"ghost: no window for pid {pid}")


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "launch":
        argv = a[a.index("--") + 1:]
        before = {c["address"] for c in clients()}
        launch_pid_file = None
        raw = "--raw" in a[1:a.index("--")]
        # Register intent before the first client selection request. Every
        # environment passed to the compositor child stays allowlisted.
        import tempfile
        import uuid
        from lab import guard, lab_env
        guard(os.environ)
        lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
        fd, envfile = tempfile.mkstemp(prefix="raw-launch-", suffix=".json", dir=lab)
        launch_id = uuid.uuid4().hex
        environment = lab_env(lab)
        environment["ORBIT_AGENT_LAUNCH_ID"] = launch_id
        with os.fdopen(fd, "w") as stream:
            json.dump(environment, stream)
        fd, launch_pid_file = tempfile.mkstemp(prefix="raw-launch-pid-", dir=lab)
        os.close(fd)
        here = Path(__file__).resolve().parent
        argv = ["/usr/bin/python3", str(here / "lab.py"), "exec-env", envfile,
                "/usr/bin/python3", str(here / "agent_launch.py"), launch_pid_file,
                *(["--register"] if raw else []), "--", *argv]
        # Launch rules apply only to this process's windows: hidden workspace, never focused on
        # map, kept rendering while unseen so pixels stay current.
        rules = f"workspace {SPACE} silent; no_initial_focus on; render_unfocused on; focus_on_activate off"
        import shlex
        line = shlex.join(argv)
        launched = False
        try:
            res = hypr(f"dispatch exec [{rules}] {line}")
            if res.strip() != "ok":
                sys.exit(f"ghost: launch refused: {res}")
            for _ in range(150):
                new = [c for c in agent_windows() if c["address"] not in before]
                if launch_pid_file:
                    launch_pid = Path(launch_pid_file).read_text().strip()
                    if raw:
                        new = [c for c in new if launch_pid.isdigit() and c["pid"] == int(launch_pid)]
                    else:
                        from process_scope import processes
                        owned_pids = {pid for pid, started in processes(launch_id)}
                        new = [c for c in new if c["pid"] in owned_pids]
                if new:
                    launched = True
                    print(json.dumps({k: new[0][k] for k in ("address", "pid", "class", "title")}))
                    return
                time.sleep(0.1)
            sys.exit("ghost: no matching window appeared within 15 s" +
                     ("; raw launch currently requires the window in the exec process" if raw else ""))
        finally:
            if launch_pid_file:
                if not launched:
                    from process_scope import processes, terminate
                    terminate(processes(launch_id))
                Path(launch_pid_file).unlink(missing_ok=True)
                Path(envfile).unlink(missing_ok=True)
    if cmd == "windows":
        for c in agent_windows():
            print(json.dumps({k: c[k] for k in ("address", "pid", "class", "title")}))
        return
    pid = int(a[1])
    if cmd == "snapshot":
        print(snapshot(pid, "--all" in a))
    elif cmd == "press":
        sys.exit(0 if press(ref(pid, a[2])) else "ghost: action refused")
    elif cmd == "action":
        e = ref(pid, a[2])
        names = [Atspi.Action.get_action_name(e, i) for i in range(Atspi.Action.get_n_actions(e))]
        if a[3] not in names:
            sys.exit(f"ghost: no action {a[3]!r}; has {names}")
        sys.exit(0 if Atspi.Action.do_action(e, names.index(a[3])) else "ghost: action refused")
    elif cmd in ("set", "type"):
        e = ref(pid, a[2])
        if not e.get_editable_text_iface():
            sys.exit("ghost: element is not editable text")
        if cmd == "set":
            ok = Atspi.EditableText.set_text_contents(e, a[3])
        else:
            pos = max(Atspi.Text.get_caret_offset(e), 0)
            ok = Atspi.EditableText.insert_text(e, pos, a[3], len(a[3]))
        sys.exit(0 if ok else "ghost: edit refused")
    elif cmd == "value":
        e = ref(pid, a[2])
        sys.exit(0 if e.get_value_iface() and Atspi.Value.set_current_value(e, float(a[3])) else "ghost: value refused")
    elif cmd == "select":
        e = ref(pid, a[2])
        parent = e.get_parent()
        if parent is not None and parent.get_selection_iface():
            sys.exit(0 if Atspi.Selection.select_child(parent, e.get_index_in_parent()) else "ghost: select refused")
        sys.exit(0 if press(e) else "ghost: select refused")
    elif cmd == "choose":
        e, i = ref(pid, a[2]), int(a[3])
        # A combo box keeps its options in a child menu; a list selects its own children.
        for target in [e] + [e.get_child_at_index(k) for k in range(e.get_child_count())]:
            if target is not None and target.get_selection_iface() and target.get_child_count() > i:
                sys.exit(0 if Atspi.Selection.select_child(target, i) else "ghost: choose refused")
        sys.exit("ghost: nothing selectable under this element")
    elif cmd == "scroll":
        e = ref(pid, a[2])
        sys.exit(0 if e.get_component_iface() and Atspi.Component.scroll_to(e, Atspi.ScrollType.ANYWHERE)
                 else "ghost: scroll refused")
    elif cmd == "read":
        print(json.dumps(describe(ref(pid, a[2])), ensure_ascii=False))
    elif cmd == "wait":
        want, secs = a[3], float(a[4]) if len(a) > 4 else 5
        end = time.time() + secs
        while time.time() < end:
            d = describe(ref(pid, a[2]))
            if want in (d.get("text") or "") or want in d["name"]:
                print(json.dumps(d, ensure_ascii=False))
                return
            time.sleep(0.05)
        sys.exit(f"ghost: timed out waiting for {want!r}; last {describe(ref(pid, a[2]))}")
    elif cmd == "capture":
        w = window_for(pid)
        r = subprocess.run(["grim", "-T", w["stableId"], a[2]], capture_output=True, text=True, timeout=10)
        sys.exit(r.returncode and f"ghost: capture failed: {r.stderr}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
