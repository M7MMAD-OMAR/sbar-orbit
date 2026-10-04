#!/usr/bin/python3
"""Exercise the runtime launcher on the private display, including parent death."""
import ctypes
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.application import NativeLauncher, application_environment
from src.native.budget import require_budget
from src.native.control import ActionControl, ControlError
from src.native.host import inspect_host
from src.native.lease import process_identity
from src.native.transport import NativeTransport
from lab import guard


def wait(condition, description):
    deadline = time.monotonic() + 6
    while not condition():
        if time.monotonic() >= deadline:
            raise TimeoutError(description)
        time.sleep(0.02)


def fixture(report):
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    child = subprocess.Popen(["/usr/bin/sleep", "30"], env={}, start_new_session=True)
    window = Gtk.Window(title="Native runtime fixture")
    window.set_default_size(400, 200)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    box.set_border_width(12)
    entry = Gtk.Entry()
    box.pack_start(entry, False, False, 0)
    window.add(box)
    def publish(*_):
        temporary = report.with_suffix(".pending")
        temporary.write_text(json.dumps({"process": process_identity(os.getpid()),
                                        "child": process_identity(child.pid), "text": entry.get_text(),
                                        "runtime": os.environ["XDG_RUNTIME_DIR"],
                                        "bus": os.environ["DBUS_SESSION_BUS_ADDRESS"],
                                        "a11y": os.environ["AT_SPI_BUS_ADDRESS"]}))
        temporary.replace(report)
    entry.connect("changed", publish)
    window.show_all()
    entry.grab_focus()
    window.present()
    publish()
    Gtk.main()


def death_parent(report):
    with ActionControl(report.parent / "death-control") as control:
        control.configure(mode="full")
        launcher = NativeLauncher(inspect_host(os.environ), report.parent, control)
        fixture_report = report.with_name("death-fixture.json")
        app = launcher.launch(["/usr/bin/python3", str(Path(__file__).resolve()), "--fixture", str(fixture_report)])
        wait(fixture_report.exists, "Parent-death fixture report")
        control.configure(mode="protected")
        temporary = report.with_suffix(".pending")
        temporary.write_text(json.dumps({"unit": app.unit, "members": list(app.lease.members()),
                                        "fixture": json.loads(fixture_report.read_text()),
                                        "supervisor": process_identity(app.supervisor.pid)}))
        temporary.replace(report)
        time.sleep(30)


def probe():
    from ghost import hypr, clients
    from harness import StandIn
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    here = Path(__file__).resolve()
    person, actor = None, None
    apps, errors = [], []
    primary = None
    checks = []
    # Reap the killed test parent's orphan supervisor locally instead of leaving
    # a zombie for the user manager. This changes no owner-desktop process.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("Cannot subreap the parent-death fixture")
    with tempfile.TemporaryDirectory(prefix="launch-", dir=lab) as work:
        work = Path(work)
        with ActionControl(work / "control") as control:
            try:
                person = StandIn()
                owner = person.wait_mapped()
                assert hypr("dispatch focuswindow address:" + owner["address"]).strip() == "ok"
                time.sleep(0.2)
                with person.lock:
                    event_start = len(person.events)
                    owner_text = person.states[-1]["text"]
                plan = inspect_host(os.environ)
                transport = NativeTransport(plan)
                launcher = NativeLauncher(plan, work, control)
                report = work / "fixture-0.json"
                argv = ["/usr/bin/python3", str(here), "--fixture", str(report)]
                before = set(work.iterdir())
                try:
                    launcher.launch(argv)
                except ControlError:
                    pass
                else:
                    raise AssertionError("Protected launcher created an application")
                assert set(work.iterdir()) == before, "Protected denial created a profile"
                control.configure(approve=launcher.request(argv))
                apps.append(launcher.launch(argv))
                control.configure(mode="full")
                report2 = work / "fixture-1.json"
                apps.append(launcher.launch(["/usr/bin/python3", str(here), "--fixture", str(report2)]))
                reports = [report, report2]
                windows = []
                for app, output in zip(apps, reports):
                    wait(output.exists, "Native GTK fixture report")
                    wait(lambda: any(window["pid"] == app.process[0] for window in clients()), "Native mapped window")
                    window = next(window for window in clients() if window["pid"] == app.process[0])
                    assert window["workspace"]["name"] == "special:ghost"
                    state = json.loads(output.read_text())
                    assert app.lease.contains(tuple(state["child"])), "Detached child escaped lease"
                    assert state["runtime"] == str(app.profile / "run")
                    assert state["bus"] != os.environ["DBUS_SESSION_BUS_ADDRESS"]
                    other = next(value for value in apps if value is not app)
                    assert not app.lease.contains(other.process), "Sibling application adopted"
                    windows.append(window)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    def type_target(index):
                        address = windows[index]["address"]
                        transport.execute(f"ghost-cursor {address} 40 30", control)
                        transport.execute(f"ghost-click {address} 40 30", control)
                        transport.execute(f"ghost-type {address} Native-runtime-{index}", control)
                    list(pool.map(type_target, range(2)))
                for index, output in enumerate(reports):
                    wait(lambda: json.loads(output.read_text())["text"] == f"Native-runtime-{index}", "Native input readback")
                assert json.loads(hypr("j/activewindow"))["address"] == owner["address"]
                with person.lock:
                    assert person.states[-1]["text"] == owner_text, "Native typing leaked to stand-in"
                    assert not [event for event in person.events[event_start:]
                                if event[0] == "wl_keyboard" and event[1] in ("enter", "leave")], "Transient owner keyboard focus change"
                checks.extend(["protected launch denied before resources", "one-use approved launch",
                               "two exact scopes and private runtimes/buses", "detached child ownership",
                               "paired native cursor/click/text readback", "stand-in keyboard focus and text preserved"])
                control.configure(mode="protected")
                stopped = apps[0]
                stopped_child = tuple(json.loads(report.read_text())["child"])
                stopped.close()
                assert process_identity(stopped.process[0]) != stopped.process
                assert process_identity(stopped_child[0]) != stopped_child
                assert apps[1].lease.contains(apps[1].process), "Sibling stop leaked across scopes"
                apps[1].close()
                checks.append("protected cleanup stops one owned tree and preserves sibling")
                control.configure(mode="full")
                try:
                    launcher.launch(["/missing/native-application"])
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Missing executable reported successful launch")
                checks.append("failed application exec cleans supervised tree")
                death_report = work / "death.json"
                actor = subprocess.Popen(["/usr/bin/python3", str(here), "--death-parent", str(death_report)],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                wait(death_report.exists, "Parent-death launch report")
                death = json.loads(death_report.read_text())
                actor.kill()
                actor.communicate(timeout=3)
                identities = [tuple(value) for value in death["members"]] + [tuple(death["fixture"]["child"]), tuple(death["supervisor"])]
                wait(lambda: all(process_identity(value[0]) != value for value in identities), "Parent-death owned cleanup")
                os.waitpid(death["supervisor"][0], 0)
                with ActionControl(work / "death-control") as dead_control:
                    journal = dead_control.inspect()
                assert not journal["unresolved"], "Parent-death cleanup journal incomplete"
                assert any(event.get("request") == "native-supervisor-close " + death["unit"] for event in journal["events"])
                checks.append("parent death reaps owned tree and journals protected cleanup")
                assert not control.inspect()["unresolved"]
            except BaseException as error:
                primary = error
            finally:
                if actor is not None and actor.poll() is None:
                    actor.kill()
                    actor.communicate(timeout=3)
                for app in reversed(apps):
                    try:
                        app.close()
                    except BaseException as error:
                        errors.append(error)
                if person is not None:
                    try:
                        person.stop()
                        person.p.wait(timeout=3)
                    except BaseException as error:
                        errors.append(error)
                # Retain each supervised worker log, including the expected exec failure.
                evidence = here.with_name("evidence")
                for profile in work.glob("native-app-*"):
                    try:
                        (evidence / f"launch-{profile.name}-{os.getpid()}.log").write_bytes((profile / "worker.log").read_bytes())
                    except BaseException as error:
                        errors.append(error)
            if primary is not None or errors:
                raise BaseExceptionGroup("Native application probe or cleanup failed", ([primary] if primary else []) + errors)
    root = here.parents[2]
    sources = {name: hashlib.sha256((root / "src/native" / name).read_bytes()).hexdigest()
               for name in ("application.py", "application_worker.py", "control.py", "transport.py", "supervise.py")}
    print(json.dumps({"checks": checks, "source_sha256": sources, "owner_activation": "not performed",
                      "appearance": "not measured", "whole_system_invariants": "not measured", "performance": "not measured"}))


if __name__ == "__main__":
    guard(os.environ)
    require_budget()
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        fixture(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--death-parent":
        death_parent(Path(sys.argv[2]))
    else:
        probe()
