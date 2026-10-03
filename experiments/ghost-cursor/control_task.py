#!/usr/bin/python3
"""Measure mode decisions and journal failure against a real native target."""
import json
import os
from pathlib import Path
import subprocess
import time

from action_control import ActionControl, ControlError, dispatch_native
from lab import guard
from process_scope import identity, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
events = lab / f"controlled-fixture-{os.getpid()}.jsonl"
owned = None


def text():
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if events.exists() and (lines := events.read_text().splitlines()):
            return json.loads(lines[-1])["text"]
        time.sleep(0.05)
    raise RuntimeError("Native fixture did not publish its state")


def wait_text(expected):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if text() == expected:
            return
        time.sleep(0.05)
    raise AssertionError((expected, text()))


try:
    window = json.loads(subprocess.check_output([
        "/usr/bin/python3", str(root / "ghost.py"), "launch", "--raw", "--",
        "/usr/bin/python3", str(root / "clipboard_fixture.py"), str(events), ""], text=True, timeout=25))
    owned = identity(window["pid"])
    address = window["address"]
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(directory) as control:
        control.configure(mode="protected")
        def action(request):
            return control.execute(request, lambda: dispatch_native(request))
        request = f"ghost-texthex {address} " + "Controlled native text".encode().hex()
        wait_text("")
        try:
            action(request)
        except ControlError as error:
            assert "approval" in str(error)
        else:
            raise AssertionError("Unapproved native input succeeded")
        assert text() == ""
        control.configure(approve=request)
        action(request)
        wait_text("Controlled native text")
        try:
            action(request)
        except ControlError as error:
            assert "approval" in str(error)
        else:
            raise AssertionError("Native approval replay succeeded")
        assert text() == "Controlled native text"
        control.configure(mode="full")
        action(f"ghost-key {address} ctrl+a")
        action(f"ghost-key {address} BackSpace")
        wait_text("")
        try:
            action("ghost-key 0x0 Return")
        except ControlError:
            pass
        else:
            raise AssertionError("Invalid target did not fail")
        journal = directory / "actions.jsonl"
        saved = directory / "failure-probe.jsonl"
        journal.rename(saved)
        journal.mkdir()
        try:
            try:
                action(request)
            except OSError:
                pass
            else:
                raise AssertionError("Native input ran without a writable journal")
            assert text() == ""
        finally:
            journal.rmdir()
            saved.rename(journal)
        report = control.inspect()
        assert not report["unresolved"], report
        assert any(e.get("outcome") == "error" for e in report["events"])
        action(f"ghost-release {address}")
        control.configure(mode="protected")
        print(json.dumps({"task": "controlled-native-input", "pass": True,
                          "protected_denial": True, "approval_once": True,
                          "full_input": True, "failure_logged": True,
                          "journal_failure_prevented_input": True,
                          "events": len(control.inspect()["events"])}))
finally:
    if owned:
        terminate({owned})
