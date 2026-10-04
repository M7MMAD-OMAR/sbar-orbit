#!/usr/bin/python3
"""Private-window placement before mapping, without the lab exec-rule wrapper."""
import json
import hashlib
import os
from pathlib import Path
import re
import socket
import signal
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.lease import NativeLease, LeaseError, manager_environment, process_identity
from ghost import hypr, clients
from harness import StandIn
from lab import guard, members
from cursor_cost_probe import loaded_plugin


def wait_member(unit, pid):
    deadline = time.monotonic() + 3
    while True:
        try:
            lease = NativeLease(unit)
            if lease.contains(process_identity(pid)):
                return lease
        except LeaseError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Native fixture did not enter its scope")
        time.sleep(0.02)


def adopt(unit, pid):
    subprocess.run(["/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "3",
                    "PIDs", "au", "1", str(pid), "Slice", "s", "sbarorbit.slice",
                    "RuntimeMaxUSec", "t", "30000000", "0"], env=manager_environment(),
                   capture_output=True, timeout=3, check=True)
    return wait_member(unit, pid)


def worker(unit):
    # This fixture intentionally uses the direct launch path. No exec rule, move,
    # focus restoration or agent_launch wrapper can conceal a placement failure.
    lease = adopt(unit, os.getpid())
    if os.environ.get("ORBIT_NATIVE_PROBE_PLAN"):
        from src.native.host import read_plan
        from src.native.transport import NativeTransport
        from action_control import ActionControl
        transport = NativeTransport(read_plan(Path(os.environ["ORBIT_NATIVE_PROBE_PLAN"])))
        with ActionControl(Path(os.environ["ORBIT_NATIVE_PROBE_CONTROL"])) as control:
            reply = "ok " + transport.enroll(lease, process_identity(os.getpid()), control)
    else:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(f"{os.environ['XDG_RUNTIME_DIR']}/hypr/{os.environ['HYPRLAND_INSTANCE_SIGNATURE']}/.socket.sock")
            connection.sendall(f"ghost-register-scope-process {os.getpid()} {unit}".encode())
            reply = bytearray()
            while chunk := connection.recv(4096):
                reply.extend(chunk)
                if len(reply) > 65536:
                    raise RuntimeError("Native registration response is too large")
        reply = reply.decode().strip()
    match = re.fullmatch(r"ok ([0-9a-fA-F-]{36})", reply)
    if match:
        os.environ["HL_EXEC_RULE_TOKEN"] = match[1]
    elif reply == "ok":
        # Only the negative probe permits the old response, to reveal its actual
        # window placement rather than stopping before a window exists.
        os.environ.pop("HL_EXEC_RULE_TOKEN", None)
    else:
        raise RuntimeError(f"Native registration refused: {reply}")
    os.environ.pop("HL_INITIAL_WORKSPACE_TOKEN", None)
    lease.verify()
    # Match agent_launch: exec publishes the launch token in /proc/PID/environ
    # before the toolkit connects. setenv alone cannot update that kernel view.
    os.execve("/usr/bin/python3", ["/usr/bin/python3", str(Path(__file__).resolve()), "--windows", unit], dict(os.environ))


def windows(unit):
    wait_member(unit, os.getpid()).verify()
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, GLib
    windows = []

    def create():
        window = Gtk.Window(title=f"native-pre-map-{len(windows)}")
        window.set_wmclass("native-pre-map", "lab.native.premap")
        window.set_default_size(400, 300)
        window.add(Gtk.Label(label="Scoped pre-map placement"))
        windows.append(window)
        window.show_all()
        window.present()

    def command(_source, _condition):
        if sys.stdin.readline().strip() == "new":
            create()
            return True
        Gtk.main_quit()
        return False

    create()
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    Gtk.main()


def probe(source, use_transport=False):
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    compositor = [pid for pid in members(lab) if Path(f"/proc/{pid}/comm").read_text().strip() == "Hyprland"]
    if len(compositor) != 1:
        raise RuntimeError("Expected one private compositor")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    build = loaded_plugin(compositor[0], source_hash)
    person = None
    actor = None
    unit = "orbit-native-" + uuid.uuid4().hex + ".scope"
    units = [unit]
    errors = []
    checks = []
    transport_evidence = None
    primary = None
    with tempfile.TemporaryDirectory(prefix="pre-map-", dir=lab) as work:
        log = open(Path(work) / "worker.log", "wb")
        try:
            person = StandIn()
            owner = person.wait_mapped()
            assert hypr("dispatch focuswindow address:" + owner["address"]).strip() == "ok"
            time.sleep(0.2)
            with person.lock:
                event_start = len(person.events)
            environment = dict(os.environ, GTK_A11Y="none", NO_AT_BRIDGE="1")
            if use_transport:
                from src.native.host import inspect_host
                from src.native.transport import NativeTransport
                from action_control import ActionControl, ControlError
                plan = inspect_host(os.environ)
                plan_file = Path(work) / "host.json"
                plan_file.write_text(json.dumps(plan))
                control_path = Path(work) / "control"
                with ActionControl(control_path) as control:
                    control.configure(mode="full")
                transport = NativeTransport(plan)
                environment.update(ORBIT_NATIVE_PROBE_PLAN=str(plan_file),
                                   ORBIT_NATIVE_PROBE_CONTROL=str(control_path))
            actor = subprocess.Popen(["/usr/bin/python3", str(Path(__file__).resolve()), "--worker", unit],
                                     env=environment, stdin=subprocess.PIPE, stdout=log, stderr=log)
            wait_member(unit, actor.pid)
            for count in (1, 2):
                if count == 2:
                    assert hypr("reload").strip() == "ok"
                    time.sleep(0.5)
                    actor.stdin.write(b"new\n")
                    actor.stdin.flush()
                deadline = time.monotonic() + 5
                while True:
                    mapped = [window for window in clients() if window["pid"] == actor.pid]
                    if len(mapped) == count:
                        break
                    if actor.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError(f"Pre-map fixture did not map: {actor.poll()}")
                    time.sleep(0.02)
                assert all(window["workspace"]["name"] == "special:ghost" for window in mapped), "Window mapped outside agent space"
                assert json.loads(hypr("j/activewindow"))["address"] == owner["address"], "Mapping stole owner focus"
                assert not json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"], "Mapping opened the agent workspace"
                time.sleep(0.2)
                with person.lock:
                    changed = [event for event in person.events[event_start:] if event[0] == "wl_keyboard" and event[1] in ("enter", "leave")]
                assert not changed, "Owner received a transient focus change"
                checks.append("initial map" if count == 1 else "new window after config reload")
                if use_transport and count == 1:
                    address = mapped[0]["address"]
                    cursor = f"ghost-cursor {address} 50 50"
                    with ActionControl(control_path) as control:
                        control.configure(mode="protected")
                        try:
                            transport.execute(cursor, control)
                        except ControlError:
                            pass
                        else:
                            raise RuntimeError("Transport bypassed protected approval")
                        control.configure(approve=cursor)
                        transport.execute(cursor, control)
                        control.configure(mode="full")
                        transport.execute(f"ghost-hide-cursor {address}", control)
                        transport.execute(f"ghost-state {address}", control)
                    checks.append("journaled native transport actions and protected denial")
            migrated = "orbit-native-" + uuid.uuid4().hex + ".scope"
            units.append(migrated)
            adopt(migrated, actor.pid)
            assert hypr("reload").strip() == "ok"
            time.sleep(0.5)
            actor.stdin.write(b"new\n")
            actor.stdin.flush()
            deadline = time.monotonic() + 5
            while True:
                mapped = [window for window in clients() if window["pid"] == actor.pid]
                if len(mapped) == 3:
                    break
                if actor.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Migrated fixture did not map its new window")
                time.sleep(0.02)
            latest = [window for window in mapped if window["title"] == "native-pre-map-2"]
            assert len(latest) == 1 and latest[0]["workspace"]["name"] != "special:ghost", "Revoked process retained its placement rule"
            checks.append("migration revokes placement on config reload")
            if use_transport:
                from src.native.host import HostError
                with ActionControl(control_path) as control:
                    try:
                        transport.execute(cursor, control)
                    except HostError:
                        pass
                    else:
                        raise RuntimeError("Transport action reached a revoked target")
                    journal = control.inspect()
                assert not journal["unresolved"], "Transport journal has unfinished requests"
                requests = [event for event in journal["events"] if event.get("kind") == "action"]
                assert len(requests) == 6, requests
                finishes = {event["id"]: event for event in journal["events"] if event["phase"] == "finish"}
                assert all(event["id"] in finishes for event in requests if event["phase"] == "begin")
                (Path(__file__).with_name("evidence") / "native-transport-actions.jsonl").write_bytes(
                    (control_path / "actions.jsonl").read_bytes())
                transport_evidence = {"requests": len(requests), "protected_denial": "pass",
                                      "revoked_target_refusal": "pass", "journal_outcomes": "pass",
                                      "source_sha256": {name: hashlib.sha256((Path(__file__).resolve().parents[2]
                                          / "src/native" / name).read_bytes()).hexdigest()
                                          for name in ("host.py", "transport.py")}}
        except BaseException as error:
            primary = error
        finally:
            try:
                if actor is not None and actor.poll() is None:
                    actor.terminate()
                    try:
                        actor.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        actor.kill()
                        actor.wait(timeout=3)
            except BaseException as error:
                errors.append(str(error))
            for owned_unit in reversed(units):
                try:
                    properties = subprocess.run(["/usr/bin/systemctl", "--user", "show", owned_unit,
                                                 "--property=LoadState,ActiveState"], env=manager_environment(),
                                                capture_output=True, text=True, timeout=3, check=True).stdout
                    if not ("LoadState=not-found" in properties and "ActiveState=inactive" in properties):
                        subprocess.run(["/usr/bin/systemctl", "--user", "stop", owned_unit], env=manager_environment(),
                                       capture_output=True, timeout=4, check=True)
                except BaseException as error:
                    errors.append(str(error))
            try:
                if person is not None:
                    person.stop()
                    try:
                        person.p.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        errors.append("Stand-in exceeded its graceful cleanup timeout")
                        os.killpg(person.p.pid, signal.SIGKILL)
                        person.p.wait(timeout=3)
            except BaseException as error:
                errors.append(str(error))
            log.close()
            # Retain failed startup diagnostics before the private profile is removed.
            evidence = Path(__file__).with_name("evidence")
            (evidence / f"pre-map-{uuid.uuid4().hex}.log").write_bytes((Path(work) / "worker.log").read_bytes())
        if primary is not None or errors:
            raise RuntimeError(f"Pre-map probe failed: {primary}; cleanup={errors}") from primary
    assert loaded_plugin(compositor[0], source_hash) == build, "Loaded plugin changed during the probe"
    print(json.dumps({"checks": checks, "workspace_placement": "pass", "focus_preserved": "pass",
                      "no_transient_keyboard_focus_events": "pass", "config_reload": "pass", "cleanup": "pass",
                      "plugin": build, "transport": transport_evidence,
                      "owner_desktop_activation": "not performed", "performance": "not measured"}))


if __name__ == "__main__":
    guard(os.environ)
    require_budget()
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        worker(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--windows":
        windows(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] == "--transport":
        probe(Path(__file__).with_name("plugin") / "ghostinput.cpp", use_transport=True)
    elif len(sys.argv) == 1:
        probe(Path(__file__).with_name("plugin") / "ghostinput.cpp")
    elif len(sys.argv) == 3 and sys.argv[1] == "--source":
        probe(Path(sys.argv[2]))
    else:
        raise SystemExit("Usage: native_pre_map_probe.py [--worker UNIT]")
