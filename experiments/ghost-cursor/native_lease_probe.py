#!/usr/bin/python3
"""Two exact native units with private buses, tested without desktop windows."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.lease import NativeLease, LeaseError, manager_environment, process_identity
from lab import guard


def fixture(report):
    child = subprocess.Popen(["/usr/bin/env", "-i", "/usr/bin/sleep", "30"], start_new_session=True)
    temporary = Path(report).with_suffix(".pending")
    temporary.write_text(json.dumps({"root": process_identity(os.getpid()),
                                      "child": process_identity(child.pid),
                                      "bus": os.environ["DBUS_SESSION_BUS_ADDRESS"]}))
    os.replace(temporary, report)
    time.sleep(30)


def cleanup_units(units):
    errors = []
    for unit in reversed(units):
        try:
            subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], env=manager_environment(), capture_output=True, timeout=4, check=True)
        except BaseException as error:
            errors.append(error)
    return errors


def probe():
    guard(os.environ)
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    started = []
    reports = []
    primary_error = None
    with tempfile.TemporaryDirectory(prefix="native-lease-", dir=lab) as work:
        try:
            for index in range(2):
                unit = "orbit-native-" + uuid.uuid4().hex + ".service"
                report = Path(work) / f"worker-{index}.json"
                # The manager command uses its own bus. The service receives only these
                # explicit values, then dbus-run-session creates its separate private bus.
                environment = {key: os.environ[key] for key in ("HOME", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE")}
                environment.update({"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
                args = ["/usr/bin/systemd-run", "--user", "--quiet", "--collect", f"--unit={unit}",
                        "--slice=sbarorbit.slice", "--service-type=exec", "--property=KillMode=control-group",
                        "--property=TimeoutStopSec=2", "--property=RuntimeMaxSec=15", "--", "/usr/bin/env", "-i",
                        *[f"{key}={value}" for key, value in environment.items()], "/usr/bin/dbus-run-session", "--",
                        "/usr/bin/python3", str(Path(__file__).resolve()), "--fixture", str(report)]
                started.append(unit)
                subprocess.run(args, env=manager_environment(), capture_output=True, timeout=3, check=True)
                deadline = time.monotonic() + 3
                while not report.exists():
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Native fixture did not publish its identity")
                    time.sleep(0.02)
                data = json.loads(report.read_text())
                lease = NativeLease(unit)
                members = lease.members()
                assert tuple(data["root"]) in members and tuple(data["child"]) in members, "Untagged detached child is missing"
                assert not lease.contains(process_identity(os.getpid())), "Caller adopted as worker"
                assert not lease.contains((data["child"][0], data["child"][1] + 1)), "PID start time ignored"
                path = data["bus"].split("path=", 1)[1].split(",", 1)[0]
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(1)
                    connection.connect(path)
                    pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                assert uid == os.getuid() and lease.contains(process_identity(pid)), "Bus daemon is outside the worker lease"
                data["lease"] = lease
                reports.append(data)
            left, right = reports
            assert left["bus"] != right["bus"], "Workers shared a bus"
            assert not left["lease"].contains(tuple(right["root"])), "Sibling root adopted"
            assert not right["lease"].contains(tuple(left["child"])), "Sibling child adopted"
            first = started[0]
            reports[0]["lease"].verify()
            subprocess.run(["/usr/bin/systemctl", "--user", "stop", first], env=manager_environment(), capture_output=True, timeout=4, check=True)
            started.remove(first)
            assert process_identity(left["root"][0]) != tuple(left["root"]), "Stopped root survived"
            assert process_identity(left["child"][0]) != tuple(left["child"]), "Stopped detached child survived"
            try:
                left["lease"].verify()
            except (LeaseError, subprocess.CalledProcessError, FileNotFoundError):
                pass
            else:
                raise AssertionError("Stopped lease remained valid")
            assert right["lease"].contains(tuple(right["root"])), "Stopping one worker killed its sibling"
            assert right["lease"].contains(tuple(right["child"])), "Sibling child was lost"
            result = {"two_units": "pass", "private_bus_peers": "pass", "untagged_detached_children": "pass",
                      "sibling_and_outside_caller_refusal": "pass", "exact_start_time": "pass", "scoped_stop": "pass",
                      "owner_activation": "not performed", "input_integration": "not measured", "performance": "not measured"}
        except BaseException as error:
            primary_error = error
        finally:
            cleanup_errors = cleanup_units(started)
        errors = ([primary_error] if primary_error else []) + cleanup_errors
        if errors:
            raise BaseExceptionGroup("Native lease probe or cleanup failed", errors)
        for data in reports:
            for key in ("root", "child"):
                assert process_identity(data[key][0]) != tuple(data[key]), "Worker cleanup left a process"
        result["final_cleanup"] = "pass"
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        fixture(sys.argv[2])
    else:
        probe()
