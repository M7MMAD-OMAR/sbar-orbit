#!/usr/bin/python3
"""Prove native CLI launch and accessibility obey mode and journal decisions."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

from action_control import ActionControl
from ghost import clients
from lab import guard
from process_scope import identity, terminate

guard(os.environ)
root = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
events = lab / f"cli-control-{os.getpid()}.jsonl"
owned = None


def request(argv):
    return "ghost-cli " + json.dumps(argv, separators=(",", ":"), ensure_ascii=True)


def invoke(argv):
    return subprocess.run(["/usr/bin/python3", str(root / "ghost.py"), *argv],
                          text=True, capture_output=True, timeout=25)


def fixture_text():
    lines = events.read_text().splitlines() if events.exists() else []
    return json.loads(lines[-1])["text"] if lines else None


try:
    with ActionControl(Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control") as control:
        control.configure(mode="protected")
        launch = ["launch", "--raw", "--", "/usr/bin/python3", str(root / "clipboard_fixture.py"), str(events), ""]
        refused = invoke(launch)
        if refused.returncode == 0:
            owned = identity(json.loads(refused.stdout)["pid"])
            raise AssertionError("Protected CLI launched an application without approval")
        assert "approval" in refused.stderr, refused
        control.configure(approve=request(launch))
        started = invoke(launch)
        assert started.returncode == 0, started.stderr
        window = json.loads(started.stdout)
        owned = identity(window["pid"])
        pid = str(window["pid"])
        deadline = time.monotonic() + 5
        editable = None
        while time.monotonic() < deadline:
            args = ["snapshot", pid]
            control.configure(approve=request(args))
            tree = invoke(args)
            if tree.returncode == 0:
                editable = next((re.search(r"\[(e\d+)\]", line).group(1) for line in tree.stdout.splitlines()
                                 if "editable" in line and re.search(r"\[(e\d+)\]", line)), None)
            if editable:
                break
            time.sleep(0.1)
        assert editable, tree
        args = ["set", pid, editable, "Logged CLI text"]
        refused = invoke(args)
        assert refused.returncode != 0 and "approval" in refused.stderr, refused
        assert fixture_text() == ""
        control.configure(approve=request(args))
        edited = invoke(args)
        assert edited.returncode == 0, edited.stderr
        deadline = time.monotonic() + 3
        while fixture_text() != "Logged CLI text" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert fixture_text() == "Logged CLI text"
        replay = invoke(args)
        assert replay.returncode != 0 and "approval" in replay.stderr, replay
        control.configure(mode="full")
        read = invoke(["read", pid, editable])
        assert read.returncode == 0 and json.loads(read.stdout)["text"] == "Logged CLI text", read
        invalid = invoke(["set", pid, "missing-ref", "wrong"])
        assert invalid.returncode != 0, invalid
        person = next(c for c in clients() if c["class"] == "lab.person.standin")
        outside = invoke(["snapshot", str(person["pid"])])
        assert outside.returncode != 0 and "non-agent" in outside.stderr, outside
        before_windows = {c["address"] for c in clients()}
        ledger = control.directory / "actions.jsonl"
        saved = control.directory / "cli-failure-probe.jsonl"
        ledger.rename(saved)
        ledger.mkdir()
        try:
            unlogged = invoke(launch)
            assert unlogged.returncode != 0, unlogged
            assert {c["address"] for c in clients()} == before_windows
        finally:
            ledger.rmdir()
            saved.rename(ledger)
        journal = control.inspect()
        assert not journal["unresolved"], journal
        actions = [e for e in journal["events"] if e.get("kind") == "action"]
        assert any(e.get("request") == request(launch) and e["phase"] == "begin" for e in actions)
        assert any(e.get("request") == request(args) and e["phase"] == "begin" for e in actions)
        assert any(e.get("outcome") == "error" for e in journal["events"])
        control.configure(mode="protected")
        print(json.dumps({"task": "controlled-cli-launch-accessibility", "pass": True,
                          "protected_launch": True, "protected_edit": True,
                          "approval_once": True, "full_readback": True,
                          "error_logged": True, "non_agent_refused": True,
                          "journal_failure_prevented_launch": True}))
finally:
    if owned:
        terminate({owned})
