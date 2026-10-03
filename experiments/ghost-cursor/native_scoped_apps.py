#!/usr/bin/python3
"""GTK4 and Dolphin in distinct private scopes and buses, measured in the lab."""
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.lease import NativeLease, manager_environment, process_identity
from action_control import ActionControl
from ghost import clients, hypr, window_for
from lab import guard
from native_lease_probe import cleanup_units

guard(os.environ)
here = Path(__file__).resolve().parent
lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
baseline = {window["pid"] for window in clients()}
control_path = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
units, profiles, workers, actors, results = [], [], [], [], []
primary_error = None
with ActionControl(control_path) as control:
    old_mode = control.inspect()["settings"]["mode"]
    control.configure(mode="full")
try:
    for name, command in (("gtk4", ["/usr/bin/gnome-text-editor", "--standalone"]),
                          ("qt", ["/usr/bin/dolphin", "--new-window", "/usr/share"])):
        work = Path(tempfile.mkdtemp(prefix="native-app-", dir=lab))
        profiles.append(work)
        unit = "orbit-native-" + uuid.uuid4().hex + ".scope"
        units.append(unit)
        if len(sys.argv) == 2:
            staged = subprocess.run(["bun", str(here / "native_appearance_stage.ts"), sys.argv[1], str(work)],
                                    capture_output=True, text=True, timeout=5, check=True)
            shutil.move(json.loads(staged.stdout)["directory"], work / "config")
        launched = subprocess.run(["/usr/bin/python3", str(here / "ghost.py"), "launch", "--raw", "--",
                                   "/usr/bin/python3", str(here / "native_scope_launch.py"), str(work), unit, "--", *command],
                                  capture_output=True, text=True, timeout=20, check=True)
        window = window_for(json.loads(launched.stdout)["pid"])
        lease = NativeLease(unit)
        process = process_identity(window["pid"])
        assert window["pid"] not in baseline and lease.contains(process), "Application reused a baseline instance or escaped its scope"
        if name == "qt":
            assert hypr(f"dispatch setfloating address:{window['address']}").strip() == "ok"
            assert hypr(f"dispatch resizewindowpixel exact 850 650,address:{window['address']}").strip() == "ok"
            window = window_for(window["pid"])
        environment = dict(os.environ, HOME=str(work / "home"), XDG_CONFIG_HOME=str(work / "config"),
                           XDG_DATA_HOME=str(work / "data"), XDG_CACHE_HOME=str(work / "cache"),
                           XDG_STATE_HOME=str(work / "state"), DBUS_SESSION_BUS_ADDRESS=f"unix:path={work / 'session'}",
                           AT_SPI_BUS_ADDRESS=f"unix:path={work / 'a11y'}")
        for bus in ("session", "a11y"):
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(1)
                connection.connect(str(work / bus))
                pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            assert uid == os.getuid() and lease.contains(process_identity(pid)), f"{bus} peer outside application scope"
        with ActionControl(Path(environment["XDG_STATE_HOME"]) / "orbit-native-control") as control:
            control.configure(mode="full")
        deadline = time.monotonic() + 5
        while True:
            tree = subprocess.run(["/usr/bin/python3", str(here / "ghost.py"), "snapshot", str(window["pid"])],
                                  env=environment, capture_output=True, text=True, timeout=5)
            if tree.returncode == 0 and (name != "gtk4" or " editable" in tree.stdout):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Private accessibility tree not ready: {tree.stdout} {tree.stderr}")
            time.sleep(0.05)
        if name == "gtk4":
            element = next(re.search(r"\[(e\d+)\]", line).group(1) for line in tree.stdout.splitlines()
                           if "] text" in line and line.endswith(" editable"))
            argv = ["/usr/bin/python3", str(here / "native_text_task.py"), str(window["pid"]), element]
        else:
            argv = ["/usr/bin/python3", str(here / "qt_task.py"), str(window["pid"])]
        workers.append({"name": name, "window": window, "lease": lease, "process": process, "env": environment, "argv": argv})
    for worker in workers:
        other = next(value for value in workers if value is not worker)
        assert not worker["lease"].contains(other["process"]), "Sibling application adopted"
        actors.append(subprocess.Popen(worker["argv"], env=worker["env"], stdout=subprocess.PIPE, stderr=subprocess.PIPE))
    for worker, actor in zip(workers, actors):
        output, error = actor.communicate(timeout=30)
        assert actor.returncode == 0, (worker["name"], output.decode(), error.decode())
        task = json.loads(output)
        (here / "evidence" / f"{worker['env']['HOME'].split('/')[-2]}-task.json").write_bytes(output)
        summary = {key: ({"characters": len(value), "sha256": hashlib.sha256(value.encode()).hexdigest()}
                         if isinstance(value, str) and len(value) > 160 else value) for key, value in task.items()}
        journal_path = Path(worker["env"]["XDG_STATE_HOME"]) / "orbit-native-control"
        with ActionControl(journal_path) as control:
            journal = control.inspect()
        assert not journal["unresolved"], journal["unresolved"]
        begins = [event for event in journal["events"] if event["phase"] == "begin" and event.get("request", "").startswith("ghost-")]
        finishes = {event["id"]: event for event in journal["events"] if event["phase"] == "finish"}
        assert begins and all(finishes[event["id"]]["outcome"] == "success" for event in begins)
        interval = [min(event["epoch_ns"] for event in begins), max(finishes[event["id"]]["epoch_ns"] for event in begins)]
        worker["lease"].verify()
        subprocess.run(["grim", "-T", worker["window"]["stableId"], str(here / "evidence" / f"native-scoped-{worker['name']}.png")],
                       env=worker["env"], capture_output=True, timeout=5, check=True)
        results.append({"name": worker["name"], "task": summary, "native_actions": len(begins), "interval": interval, "private_tree": "pass", "scope_membership": "pass", "bus_peers": "pass", "activated_profile": "pass", "diagnostics": error.decode()})
except BaseException as error:
    if isinstance(error, subprocess.CalledProcessError):
        print(json.dumps({"failed_command_stdout": error.stdout, "failed_command_stderr": error.stderr}), flush=True)
    primary_error = error
finally:
    cleanup_errors = []
    for actor in actors:
        if actor.poll() is None:
            try:
                actor.terminate()
                actor.communicate(timeout=5)
            except BaseException as error:
                cleanup_errors.append(error)
                try:
                    actor.kill()
                    actor.communicate(timeout=2)
                except BaseException as kill_error:
                    cleanup_errors.append(kill_error)
    cleanup_errors.extend(cleanup_units(units))
    with ActionControl(control_path) as control:
        control.configure(mode=old_mode)
    for unit in units:
        (lab / f"{unit}.pid").unlink(missing_ok=True)
errors = ([primary_error] if primary_error else []) + cleanup_errors
if errors:
    raise BaseExceptionGroup("Scoped native apps or cleanup failed", errors)
for worker in workers:
    assert process_identity(worker["process"][0]) != worker["process"], "Application survived scope stop"
overlap = (min(result["interval"][1] for result in results) - max(result["interval"][0] for result in results)) / 1e9
assert overlap > 0, "Workers did not overlap native input intervals"
for profile in profiles:
    shutil.copyfile(profile / "activation.json", here / "evidence" / f"{profile.name}-activation.json")
    shutil.copyfile(profile / "launcher.log", here / "evidence" / f"{profile.name}-launcher.log")
    shutil.rmtree(profile)
print(json.dumps({"task": "native-scoped-gtk4-dolphin", "results": results, "scope_cleanup": "pass", "native_overlap_seconds": overlap, "owner_activation": "not performed", "appearance_parity": "not measured", "performance": "not measured"}))
