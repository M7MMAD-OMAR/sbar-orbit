#!/usr/bin/python3
"""Measure whether an agent action disturbs the person (criteria in BAR.md).

Run inside a lab:  lab.py run LAB -- /usr/bin/python3 harness.py --agent 'CMD'

The person is simulated by a fresh stand-in GTK window started for every run (it holds keyboard
focus and the pointer) and a virtual keyboard (wtype) typing into it. The agent command runs in its
own session with a timeout, and measurement continues for a settle period after it exits.

All evidence is held in this process's memory, read through pipes and sockets, never from files an
agent could rewrite. Criteria:
  B1   pointer position, sampled about every 5 ms
  B2   what the stand-in itself received: wl_keyboard, wl_pointer and zwp_text_input_v3 enter or
       leave, any keyboard layout group change, any clipboard or primary selection offer
  B3   the stand-in's buffer equals exactly what the person typed, the caret ends at the end and
       nothing was ever selected
  B4   the person's view and settings: focus, workspace, monitor and layer events; every window
       outside the agent's workspace, layers, monitors (including power), key binds, keymaps, a set
       of visual and focus options, clipboard and primary selection, all compared before and after
  B12  no process the agent started is still alive after the settle period
Exit status 0 only when every criterion holds and the agent command itself succeeded.

Known limits, printed here so nobody reads more into a pass: the agent runs as the same user, so it
could still kill or ptrace the harness itself; wtype carries its own keymap, so a layout change is
caught by the keymap and event checks in B2 and B4, not by B3.
"""
import argparse, json, os, re, signal, socket, subprocess, sys, threading, time
from pathlib import Path

RUN = Path(os.environ["XDG_RUNTIME_DIR"])
if not str(RUN).startswith("/tmp/gl-"):
    sys.exit("harness: refusing to run outside a lab")
HYPR = RUN / "hypr" / os.environ["HYPRLAND_INSTANCE_SIGNATURE"]
HERE = Path(__file__).resolve().parent
OPTIONS = ["decoration:screen_shader", "cursor:invisible", "decoration:active_opacity", "decoration:inactive_opacity",
           "decoration:dim_inactive", "input:kb_layout", "input:kb_options", "input:follow_mouse",
           "misc:focus_on_activate", "general:layout", "cursor:no_warps", "cursor:hide_on_key_press",
           "input:sensitivity", "input:repeat_rate", "input:repeat_delay"]


def hypr(cmd):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(str(HYPR / ".socket.sock"))
    s.sendall(cmd.encode())
    chunks = []
    while True:
        b = s.recv(65536)
        if not b:
            break
        chunks.append(b)
    s.close()
    return b"".join(chunks).decode()


def hj(cmd):
    return json.loads(hypr("j/" + cmd))


def paste(primary):
    try:
        r = subprocess.run(["wl-paste", "-n"] + (["-p"] if primary else []), capture_output=True, timeout=2,
                           stdin=subprocess.DEVNULL)
        return r.stdout.decode(errors="replace") if r.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return "<timeout>"


class StandIn:
    WL = re.compile(r"^\[[\d:. ]+\]\s+(?:\{[^}]*\}\s+)?(\w+)#\d+\.(\w+)\((.*)\)$")

    def __init__(self):
        env = dict(os.environ, WAYLAND_DEBUG="client")
        self.p = subprocess.Popen(["/usr/bin/python3", str(HERE / "standin.py")], env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.states, self.events, self.lock = [], [], threading.Lock()
        threading.Thread(target=self._output, daemon=True).start()
        threading.Thread(target=self._wayland, daemon=True).start()

    def _output(self):
        for line in self.p.stdout:
            try:
                state = json.loads(line)
            except ValueError:
                continue
            with self.lock:
                self.states.append(state)

    def _wayland(self):
        for raw in self.p.stderr:
            line = raw.decode(errors="replace").rstrip("\n")
            if " -> " in line:
                continue  # requests the stand-in sent, not events it received
            m = self.WL.match(line.strip())
            if m:
                with self.lock:
                    self.events.append((m.group(1), m.group(2), m.group(3)))

    def window(self):
        for c in hj("clients"):
            if c["class"] == "lab.person.standin" and c["pid"] == self.p.pid:
                return c
        return None

    def wait_mapped(self):
        for _ in range(150):
            time.sleep(0.1)
            with self.lock:
                ready = bool(self.states)
            c = self.window()
            if c and ready:
                return c
        sys.exit("harness: stand-in did not map")

    def stop(self):
        try:
            os.killpg(self.p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def snapshot(space):
    def keep(c):
        return {k: c.get(k) for k in ["at", "size", "workspace", "hidden", "mapped", "fullscreen", "pinned",
                                      "floating", "monitor", "focusHistoryID", "class", "title"]}
    person_windows = {c["address"]: keep(c) for c in hj("clients") if not c["workspace"]["name"].startswith(space)}
    monitors = {m["name"]: {k: m.get(k) for k in ["activeWorkspace", "specialWorkspace", "dpmsStatus", "disabled",
                                                  "x", "y", "width", "height", "scale", "transform"]}
                for m in hj("monitors all")}
    layers = hj("layers")
    keyboards = [{k: d.get(k) for k in ["name", "layout", "active_keymap", "active_layout_index"]}
                 for d in hj("devices").get("keyboards", [])]
    options = {o: hj(f"getoption {o}") for o in OPTIONS}
    return {"windows": person_windows, "monitors": monitors, "layers": layers, "binds": hj("binds"),
            "keyboards": keyboards, "options": options, "clipboard": paste(False), "primary": paste(True),
            "active": hj("activewindow").get("address")}


class Events(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.lines, self.stop = [], False
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(str(HYPR / ".socket2.sock"))

    def run(self):
        buf = b""
        self.s.settimeout(0.1)
        while not self.stop:
            try:
                b = self.s.recv(65536)
            except socket.timeout:
                continue
            if not b:
                break
            buf += b
            *done, buf = buf.split(b"\n")
            self.lines += [x.decode(errors="replace") for x in done]


class Pointer(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.samples, self.stop = [], False

    def run(self):
        while not self.stop:
            p = hj("cursorpos")
            self.samples.append((p["x"], p["y"]))
            time.sleep(0.005)


def judge_events(lines, start_active, person, space):
    violations, noise = [], []
    for line in lines:
        kind, _, value = line.partition(">>")
        parts = value.split(",")
        target = parts[0]
        if kind in ("activewindow", "windowtitle", "windowtitlev2"):
            continue
        if kind == "activelayout" and target.startswith("hl-virtual-keyboard-wtype"):
            noise.append(line)  # the simulated person's own virtual keyboard
            continue
        if kind == "activewindowv2":
            (noise if target == start_active else violations).append(line)
        elif kind == "openwindow":
            ws = parts[1] if len(parts) > 1 else ""
            (noise if ws.startswith(space) else violations).append(line)
        elif kind in ("closewindow", "movewindow", "movewindowv2", "changefloatingmode", "fullscreen", "pin",
                      "minimized"):
            (violations if "0x" + target in person else noise).append(line)
        elif kind in ("urgent", "openwindow", "windowtitle", "screencast", "screencastv2", "submap", "bell", "activewindow",
                      "moveintogroup", "moveoutofgroup", "togglegroup"):
            noise.append(line)
        elif kind in ("workspace", "workspacev2", "focusedmon", "focusedmonv2", "activespecial", "activespecialv2",
                      "activelayout", "openlayer", "closelayer", "monitoradded", "monitoraddedv2",
                      "monitorremoved", "monitorremovedv2", "configreloaded", "createworkspace", "createworkspacev2",
                      "destroyworkspace", "destroyworkspacev2", "moveworkspace", "moveworkspacev2",
                      "renameworkspace", "lockgroups", "ignoregrouplock"):
            # createworkspace for the agent's own special workspace is harmless; anything else is not.
            (noise if space.split(":")[-1] in value and "workspace" in kind else violations).append(line)
        else:
            violations.append(line)
    return violations, noise


def client_events(events, start_group):
    found = []
    group = start_group
    for iface, event, args in events:
        if iface in ("wl_keyboard", "wl_pointer", "zwp_text_input_v3") and event in ("enter", "leave"):
            found.append(f"{iface}.{event}")
        elif iface == "wl_keyboard" and event == "modifiers":
            g = args.split(",")[-1].strip()
            if g != group:
                found.append(f"layout group {group} -> {g}")
                group = g
        elif event in ("selection", "data_offer") and iface in ("wl_data_device", "zwp_primary_selection_device_v1",
                                                                  "ext_data_control_device_v1"):
            found.append(f"{iface}.{event}")
    return found


def descendants(root, exclude):
    """Every live process below root, minus the subtrees in exclude. The harness is a child
    subreaper, so a process the agent detaches with setsid or a double fork is re-parented to the
    harness rather than to init and is still found here."""
    children = {}
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            stat = (p / "stat").read_text()
            fields = stat[stat.rindex(")") + 2:].split()
            if fields[0] != "Z":
                children.setdefault(int(fields[1]), []).append(int(p.name))
        except (OSError, ValueError, IndexError):
            pass
    out, stack = [], [c for c in children.get(root, []) if c not in exclude]
    while stack:
        pid = stack.pop()
        out.append(pid)
        stack += [c for c in children.get(pid, []) if c not in exclude]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True, help="shell command for the agent's work")
    ap.add_argument("--text", default="the person keeps typing while the agent works 0123456789 ")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("--settle", type=float, default=4)
    ap.add_argument("--out", default=None)
    ap.add_argument("--agent-space", default="special:ghost", help="workspace name prefix the agent owns")
    a = ap.parse_args()
    from process_scope import processes, terminate
    import ctypes
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER

    # A fresh stand-in every run: damage left by an earlier run is never silently repaired.
    for c in hj("clients"):
        if c["class"] == "lab.person.standin":
            hypr(f"dispatch closewindow address:{c['address']}")
    time.sleep(0.5)
    standin = StandIn()
    c = standin.wait_mapped()
    hypr(f"dispatch focuswindow address:{c['address']}")
    hypr(f"dispatch movecursor {c['at'][0] + c['size'][0] // 2} {c['at'][1] + c['size'][1] // 2}")
    time.sleep(1.0)

    with standin.lock:
        before_state = standin.states[-1]
        ev_offset = len(standin.events)
        start_group = next((args.split(",")[-1].strip() for i, e, args in reversed(standin.events)
                            if i == "wl_keyboard" and e == "modifiers"), "0")
        state_offset = len(standin.states)
    before = snapshot(a.agent_space)
    baseline_processes = processes()
    ev, ptr = Events(), Pointer()
    ev.start(); ptr.start()
    time.sleep(0.3)
    typed = a.text * a.repeat
    typist = subprocess.Popen(["wtype", "-d", "12", typed], stdin=subprocess.DEVNULL)
    time.sleep(0.2)

    import tempfile
    out_f, err_f = tempfile.TemporaryFile(), tempfile.TemporaryFile()
    t0 = time.monotonic()
    agent = subprocess.Popen(["/bin/bash", "-c", a.agent], stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f,
                             start_new_session=True)
    timed_out = False
    try:
        agent_exit = agent.wait(timeout=a.timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(agent.pid, signal.SIGKILL)
        agent_exit = agent.wait()
    agent_s = time.monotonic() - t0
    typist.wait()
    time.sleep(a.settle)  # measurement continues: delayed effects of the agent land here
    compositor_leftovers = processes() - baseline_processes
    leftovers = sorted(set(descendants(os.getpid(), {standin.p.pid, typist.pid})) |
                       {pid for pid, started in compositor_leftovers if pid != typist.pid})
    terminate(compositor_leftovers - {item for item in compositor_leftovers if item[0] == typist.pid})
    for pid in leftovers:
        if pid in {item[0] for item in compositor_leftovers}:
            continue  # Already terminated through the retained process identities.
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    ptr.stop = ev.stop = True
    ptr.join(); ev.join()
    after = snapshot(a.agent_space)
    with standin.lock:
        states = standin.states[state_offset:]
        events = standin.events[ev_offset:]
    standin.stop()
    out_f.seek(0); err_f.seek(0)

    final = states[-1] if states else before_state
    selected_ever = [s["selection"] for s in states if s["selection"][0] != s["selection"][1]]
    xs = set(ptr.samples)
    person = set(before["windows"])
    violations, noise = judge_events(ev.lines, (before["active"] or "").removeprefix("0x"), person, a.agent_space)
    diffs = {k: [before[k], after[k]] for k in before if before[k] != after[k] and k != "windows"}
    moved = {k: (before["windows"].get(k), after["windows"].get(k))
             for k in set(before["windows"]) | set(after["windows"]) if before["windows"].get(k) != after["windows"].get(k)}
    found = client_events(events, start_group)
    report = {
        "agent": {"cmd": a.agent, "exit": agent_exit, "timed_out": timed_out, "seconds": round(agent_s, 3),
                  "stdout": out_f.read().decode(errors="replace")[-2000:],
                  "stderr": err_f.read().decode(errors="replace")[-2000:]},
        "B1_pointer": {"pass": len(xs) == 1, "distinct_positions": sorted(xs)[:10], "samples": len(ptr.samples)},
        "B2_client_events": {"pass": not found, "events": found[:20]},
        "B3_keystrokes": {"pass": final["text"] == before_state["text"] + typed and not selected_ever
                          and final["caret"] == len(final["text"]),
                          "expected_len": len(typed), "got_len": len(final["text"]) - len(before_state["text"]),
                          "got_tail": final["text"][-60:], "selected": selected_ever[:5], "caret": final["caret"]},
        "B4_view_and_settings": {"pass": not violations and not moved and not diffs,
                                 "events": violations[:20], "noise": noise[:20], "changed_windows": moved,
                                 "changed_state": diffs},
        "B12_leftovers": {"pass": not leftovers, "pids": leftovers,
                          "compositor_processes": sorted(compositor_leftovers)},
    }
    ok = all(report[k]["pass"] for k in report if k.startswith("B")) and agent_exit == 0 and not timed_out
    report["pass"] = ok
    text = json.dumps(report, indent=1, default=str, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text)
    print(text)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
