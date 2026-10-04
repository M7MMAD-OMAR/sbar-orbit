#!/usr/bin/python3
"""Measure scoped cursor costs on the private nested display, never owner input."""
import hashlib
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.session import NativeSession
from cursor_cost_probe import identity, loaded_plugin
from ghost import clients, hypr
from harness import StandIn
from lab import guard, members


def main():
    guard(os.environ)
    require_budget()
    here = Path(__file__).resolve().parent
    private = here.parents[1] / ".private"
    retained = private / f"native-cursor-cost-{os.getpid()}"
    retained.mkdir(mode=0o700)
    report = {"measurement_complete": False, "scope": "two scoped GTK targets on private nested renderer",
              "whole_system_performance": "not measured", "old_system_comparison": "not measured",
              "display_latency": "not measured", "samples": [],
              "response_scope": "guarded Python session action and durable journal, no public broker or capture",
              "rss_scope": "approximate per-process RSS including shared pages; not unique memory",
              "cpu_scope": "inner/outer compositor and probe only; helper and application CPU excluded"}
    sources = [Path(__file__), here / "plugin/ghostinput.cpp", here / "native_broker_application.py",
               here / "native_application_probe.py", here / "cursor_cost_probe.py", here / "harness.py",
               here / "ghost.py", here / "lab.py"] + [here.parents[1] / f"src/native/{name}.py"
               for name in ("session", "application", "control", "transport", "host", "lease", "budget")]
    report["source_sha256"] = {str(path.relative_to(here.parents[1])): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    primary, failures, session, person = None, [], None, None
    with tempfile.TemporaryDirectory(prefix="np-", dir="/var/tmp", delete=False) as temporary, ExitStack() as controls:
        work = Path(temporary)
        try:
            plan = inspect_host(os.environ)
            lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
            processes = {pid: Path(f"/proc/{pid}/comm").read_text().strip() for pid in members(lab)
                         if Path(f"/proc/{pid}/comm").exists()}
            processes = {pid: name for pid, name in processes.items() if name in ("Hyprland", "kwin_wayland")}
            assert sorted(processes.values()) == ["Hyprland", "kwin_wayland"]
            hypr_pid = next(pid for pid, name in processes.items() if name == "Hyprland")
            binding = loaded_plugin(hypr_pid, report["source_sha256"]["experiments/ghost-cursor/plugin/ghostinput.cpp"])
            report["plugin"] = binding
            processes[os.getpid()] = "probe"
            starts = {pid: identity(pid)[0] for pid in processes}
            person = StandIn()
            owner = person.wait_mapped()
            control = controls.enter_context(ActionControl(work / "control"))
            control.configure(mode="full")
            (work / "apps").mkdir(mode=0o700)
            session = NativeSession(plan, work / "apps", control)
            targets = []
            for index in range(2):
                app = session.launch(["/usr/bin/python3", str(here / "native_broker_application.py"), str(work / f"app-{index}.json")])
                deadline = time.monotonic() + 10
                while True:
                    windows = session.execute({"type": "windows", "appId": app["appId"]})["windows"]
                    if windows:
                        assert len(windows) == 1
                        targets.append({"appId": app["appId"], "windowId": windows[0]["windowId"]})
                        break
                    assert time.monotonic() < deadline, "Scoped GTK target did not map"
                    time.sleep(0.05)
            for target in targets:
                session.execute({"type": "cursor", "x": 100, "y": 100, **target})
            expected = {value["address"]: {key: value[key] for key in ("pid", "at", "size", "workspace", "mapped")}
                        for value in clients()}
            focus = json.loads(hypr("j/activewindow")).get("address")
            assert focus == owner["address"], "Native launch changed simulated owner focus"
            report["target_visibility"] = "pre-map scoped workspace, no viewer capture during timing"
            time.sleep(5)
            for order in (("idle", "static", "ipc", "moving"), ("moving", "ipc", "static", "idle")):
                for phase in order:
                    for target in targets:
                        session.execute({"type": "cursor", "x": 100, "y": 100, **target} if phase in ("static", "moving")
                                        else {"type": "hide-cursor", **target})
                    time.sleep(0.5)
                    before = {pid: identity(pid) for pid in processes}
                    start = time.monotonic()
                    pairs, durations, misses = 0, [], 0
                    while time.monotonic() - start < 6:
                        if phase in ("ipc", "moving"):
                            began = time.monotonic()
                            for target in targets:
                                session.execute({"type": "cursor", "x": 100 + pairs % 100, "y": 100, **target}
                                                if phase == "moving" else {"type": "state", **target})
                            durations.append(time.monotonic() - began)
                            pairs += 1
                            due = start + pairs * 0.05
                            if time.monotonic() > due:
                                misses += 1
                            time.sleep(max(0, due - time.monotonic()))
                        else:
                            time.sleep(max(0, start + 6 - time.monotonic()))
                    elapsed = time.monotonic() - start
                    after = {pid: identity(pid) for pid in processes}
                    assert all(before[pid][0] == starts[pid] == after[pid][0] for pid in processes)
                    current = {value["address"]: {key: value[key] for key in ("pid", "at", "size", "workspace", "mapped")}
                               for value in clients()}
                    assert current == expected and json.loads(hypr("j/activewindow")).get("address") == focus
                    assert loaded_plugin(hypr_pid, report["source_sha256"]["experiments/ghost-cursor/plugin/ghostinput.cpp"]) == binding
                    rss = {name: int(Path(f"/proc/{pid}/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
                           for pid, name in processes.items()}
                    report["samples"].append({"phase": phase, "seconds": elapsed, "requested_pair_hz": 20,
                        "actual_pair_hz": pairs / elapsed, "missed_pair_deadlines": misses,
                        "pair_response_seconds": durations, "rss_bytes": rss,
                        "cpu_seconds": {name: (after[pid][1] - before[pid][1]) / os.sysconf("SC_CLK_TCK")
                                        for pid, name in processes.items()}})
            report["measurement_complete"] = True
        except BaseException as error:
            primary = error
        finally:
            for cleanup in ([session.close] if session else []):
                try:
                    cleanup()
                except BaseException as error:
                    failures.append(error)
            if person:
                try:
                    if person.p.poll() is None:
                        person.p.terminate()
                    person.p.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    failures.append(error)
                    try:
                        person.p.kill()
                        person.p.wait(timeout=3)
                    except BaseException as final_error:
                        failures.append(final_error)
                except BaseException as error:
                    failures.append(error)
            try:
                shutil.copytree(work, retained / "diagnostics")
            except BaseException as error:
                failures.append(error)
            if (session is None or session.closed) and (person is None or person.p.poll() is not None):
                try:
                    shutil.rmtree(work)
                except BaseException as error:
                    failures.append(error)
            else:
                failures.append(RuntimeError(f"Owned processes remain; retaining runtime {work}"))
            report["errors"] = [repr(error) for error in ([primary] if primary else []) + failures]
            try:
                (retained / "report.json").write_text(json.dumps(report, indent=2))
                print(str(retained / "report.json"), flush=True)
            except BaseException as error:
                failures.append(error)
    if primary or failures:
        raise BaseExceptionGroup("Native cost measurement or cleanup failed", ([primary] if primary else []) + failures)


if __name__ == "__main__":
    main()
