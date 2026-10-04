#!/usr/bin/python3
"""Owner-side lab acceptance probe, never an agent settings capability."""
import json
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import time
import argparse
import hashlib
import shutil
import uuid

import lab
lab.guard(os.environ)
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
from action_control import ActionControl, ControlError
from ghost import clients, window_for, _hypr
from process_scope import identity, processes, terminate


def wait(check):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Native UI condition timed out")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ui", type=Path, default=Path(__file__).with_name("native_settings.py"))
    parser.add_argument("--close-only", action="store_true")
    parser.add_argument("--cli", action="store_true")
    parser.add_argument("--kill-cli", action="store_true")
    args = parser.parse_args()
    if args.kill_cli and not args.cli:
        parser.error("--kill-cli requires --cli")
    with tempfile.TemporaryDirectory(prefix="settings-probe-", dir=os.environ["XDG_STATE_HOME"]) as directory:
        state = Path(directory) / "orbit-native-control"
        with ActionControl(state) as control:
            try:
                control.execute("ghost-texthex 0x123 " + "Preview text".encode().hex(), lambda: None)
            except ControlError:
                pass
            else:
                raise AssertionError("Protected request unexpectedly succeeded")
        repo = Path(__file__).resolve().parents[2]
        evidence_directory = Path(__file__).with_name("evidence")
        launch_id = uuid.uuid4().hex
        env = dict(os.environ, XDG_STATE_HOME=directory, ORBIT_NATIVE_CONTROL=str(state),
                   ORBIT_NATIVE_PLAN=str(Path(directory) / "owner-plan.json"),
                   ORBIT_AGENT_LAUNCH_ID=launch_id)
        argv = [shutil.which("bun"), str(repo / "src/cli.ts"), "native-settings"] if args.cli else ["/usr/bin/python3", str(args.ui)]
        log = open(evidence_directory / f"native-settings-{os.getpid()}.log", "xb")
        process = subprocess.Popen(argv, env=env, stdout=log, stderr=log)
        process_identity = identity(process.pid)
        ui_identity = None
        try:
            desktop = Atspi.get_desktop(0)

            def application():
                for index in range(desktop.get_child_count()):
                    child = desktop.get_child_at_index(index)
                    if not child:
                        continue
                    pid = child.get_process_id()
                    if pid == process.pid and not args.cli:
                        return child
                    if args.cli and pid > 0:
                        try:
                            parent = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
                        except (OSError, ValueError, IndexError):
                            continue
                        if parent == process.pid and any(client["pid"] == pid and client["title"] == "Orbit native settings" for client in clients()):
                            return child

            root = wait(application)
            ui_pid = root.get_process_id()
            ui_identity = identity(ui_pid)
            if args.kill_cli:
                process.kill()
                process.wait(timeout=5)
                assert ui_identity and identity(ui_pid) == ui_identity, "Fixture must leave a live GTK child"
                return

            def nodes(node):
                yield node
                for index in range(node.get_child_count()):
                    child = node.get_child_at_index(index)
                    if child:
                        yield from nodes(child)

            def named(name):
                return next((node for node in nodes(root) if node.get_name() == name), None)

            def status(prefix):
                return next((node.get_name() for node in nodes(root) if node.get_name().startswith(prefix)), None)

            def click(name):
                node = wait(lambda: named(name))
                if node.get_role() == Atspi.Role.LABEL:
                    node = node.get_parent()
                wait(lambda: node.get_state_set().contains(Atspi.StateType.SENSITIVE))
                action = node.get_action_iface()
                if node.get_role() in (Atspi.Role.CHECK_BOX, Atspi.Role.RADIO_BUTTON):
                    # GTK4 radios expose focus but no AT-SPI Action interface.
                    # Owner fixture uses the private lab keyboard to exercise
                    # the same keyboard activation available to the person.
                    address = next(client["address"] for client in clients() if client["pid"] == ui_pid)
                    _hypr("dispatch focuswindow address:" + address)
                    for _ in range(20):
                        if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                            break
                        focused_radio = next((item for item in nodes(root) if item.get_role() == Atspi.Role.RADIO_BUTTON
                                              and item.get_state_set().contains(Atspi.StateType.FOCUSED)), None)
                        if focused_radio is not None:
                            subprocess.run(["wtype", "-k", "Down" if name.startswith("Full") else "Up"], check=True)
                            time.sleep(0.05)
                            continue
                        subprocess.run(["wtype", "-k", "Tab"], check=True)
                        time.sleep(0.05)
                    assert node.get_state_set().contains(Atspi.StateType.FOCUSED), name
                    subprocess.run(["wtype", "-k", "space"], check=True)
                    wait(lambda: node.get_state_set().contains(Atspi.StateType.CHECKED))
                else:
                    assert action and action.do_action(0), name

            wait(lambda: status("Applied mode: Protected."))
            wait(lambda: status("Type into 0x123: Preview text"))
            # Settings must remain outside the agent workspace and API.
            wait(lambda: named("Approve this action once"))
            try:
                window_for(ui_pid)
            except SystemExit:
                pass
            else:
                raise AssertionError("Settings window was agent-targetable")
            click("Approve this action once")
            wait(lambda: status("Applied mode: Protected. One-use approval is ready."))
            request = "ghost-texthex 0x123 " + "Preview text".encode().hex()
            with ActionControl(state) as control:
                assert control.execute(request, lambda: "approved") == "approved"
                try:
                    control.execute(request, lambda: "replay")
                except ControlError:
                    pass
                else:
                    raise AssertionError("Consumed approval was reused")
            click("Full access: allow actions and keep the action log")
            click("Apply mode")
            wait(lambda: status("Applied mode: Full access."))
            with ActionControl(state) as control:
                assert control.execute("preview full action", lambda: "full") == "full"
            click("Protected: approve each exact action once")
            click("Apply mode")
            wait(lambda: status("Applied mode: Protected."))
            # Corrupt storage must visibly refuse reading and writing.
            journal = state / "actions.jsonl"
            original = journal.read_bytes()
            if not args.close_only:
                huge_time = json.dumps({"phase": "denied", "id": "bad", "kind": "action",
                                        "request": "synthetic", "epoch_ns": 10 ** 100}).encode() + b"\n"
                for broken in (b"not-json\n", b'{"phase":"denied","id":"bad"}\n', huge_time):
                    journal.write_bytes(original + broken)
                    click("Refresh")
                    wait(lambda: status("Could not read or save settings:"))
                    assert not named("Apply mode").get_state_set().contains(Atspi.StateType.SENSITIVE)
                    assert not named("Approve this action once").get_state_set().contains(Atspi.StateType.SENSITIVE)
                    journal.write_bytes(original)
                    click("Refresh")
                    wait(lambda: status("Applied mode: Protected."))
            with ActionControl(state) as control:
                evidence = control.inspect()
            assert not evidence["unresolved"]
            screenshot = evidence_directory / ("native-settings-runtime.png" if args.cli else "native-settings-preview.png")
            target = next(client for client in clients() if client["pid"] == ui_pid)
            subprocess.run(["grim", "-T", target["stableId"], str(screenshot)], check=True, timeout=10)
            with (state / "lock").open("r+") as held_lock:
                fcntl.flock(held_lock, fcntl.LOCK_EX)
                click("Refresh")
                wait(lambda: status("Reading settings..."))
                address = next(client["address"] for client in clients() if client["pid"] == ui_pid)
                _hypr("dispatch closewindow address:" + address)
                assert process.wait(timeout=2) == 0, "Close while lock is held"
            print(json.dumps({"passed": True, "approval_once": True, "mode_roundtrip": True,
                              "journal_error_visible": not args.close_only, "agent_target_refused": True,
                              "close_during_lock": True,
                              "events": len(evidence["events"]), "screenshot": str(screenshot)}))
            print(json.dumps({"public_cli": args.cli, "owner_activation": "not performed",
                              "source_sha256": {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in (
                                  "src/native/settings.py", "src/native/control.py", "src/native-settings.ts", "src/cli.ts",
                                  "experiments/ghost-cursor/native_settings.py", "experiments/ghost-cursor/native_settings_probe.py")}}))
        finally:
            try:
                owned = processes(launch_id=launch_id, root_identity=process_identity)
                owned.update(item for item in (process_identity, ui_identity) if item)
                terminate(owned)
                process.wait(timeout=5)
                assert not processes(launch_id=launch_id, root_identity=process_identity), "Owned UI processes survived cleanup"
                if args.kill_cli:
                    print(json.dumps({"parent_killed": True, "owned_child_cleanup": True}))
            finally:
                log.close()


if __name__ == "__main__":
    main()
