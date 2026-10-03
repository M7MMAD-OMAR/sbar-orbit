#!/usr/bin/python3
"""Compare cursor CPU cost in a private nested compositor, never the owner seat."""
import json
import hashlib
import sys
import os
from pathlib import Path
import subprocess
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from action_control import ActionControl
from ghost import clients, hypr
from harness import StandIn
from lab import guard, members


def identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return int(fields[19]), int(fields[11]) + int(fields[12])


def loaded_plugin(pid, source_hash):
    mappings = {}
    for line in Path(f"/proc/{pid}/maps").read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) == 6 and "ghostinput" in Path(fields[5]).name:
            mappings[fields[5]] = (fields[3], int(fields[4]))
    if len(mappings) != 1:
        raise RuntimeError("Expected exactly one loaded ghostinput library")
    path, (device, inode) = next(iter(mappings.items()))
    binary = Path(path)
    info = binary.stat()
    major, minor = (int(part, 16) for part in device.split(":"))
    if info.st_ino != inode or info.st_dev != os.makedev(major, minor):
        raise RuntimeError("Loaded library differs from the file being hashed")
    build_source = Path(path + ".source.sha256").read_text().split()[0]
    if build_source != source_hash:
        raise RuntimeError("Loaded library build source differs from current plugin source")
    return {"path": path, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "build_source_sha256": build_source, "optimization": "O0 prototype build"}


def main():
    guard(os.environ)
    require_budget()
    root = Path(__file__).resolve().parent
    if len(sys.argv) not in (1, 2):
        raise RuntimeError("Provide an optional exact plugin build source snapshot")
    plugin_source = Path(sys.argv[1]) if len(sys.argv) == 2 else root / "plugin/ghostinput.cpp"
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    report = {"scope": "private nested renderer only", "pass": False,
              "whole_system_performance": "not measured", "samples": [],
              "probe_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "plugin_source_sha256": hashlib.sha256(plugin_source.read_bytes()).hexdigest()}
    actors, windows, person = [], [], None
    cursor_addresses = set()
    shown = False
    original = json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"]
    if original:
        raise RuntimeError("Probe requires a fresh lab without a special workspace")

    def checked(command):
        reply = hypr(command).strip()
        if reply != "ok":
            raise RuntimeError(f"{command.split()[0]} failed: {reply}")

    control_path = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(control_path) as control:
        original_mode = control.inspect()["settings"]["mode"]
    try:
        with ActionControl(control_path) as control:
            control.configure(mode="full")
        for index in range(2):
            with open(lab / f"cursor-cost-canvas-{index}.log", "ab") as diagnostics:
                actor = subprocess.Popen(["/usr/bin/python3", str(root / "canvas.py")],
                                         stdout=subprocess.DEVNULL, stderr=diagnostics)
            actors.append(actor)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                window = next((w for w in clients() if w["pid"] == actor.pid), None)
                if window:
                    break
                if actor.poll() is not None:
                    raise RuntimeError("Canvas exited before mapping")
                time.sleep(0.05)
            else:
                raise TimeoutError("Canvas mapping")
            windows.append(window)
            address = window["address"]
            checked(f"dispatch movetoworkspacesilent special:ghost,address:{address}")
            checked(f"dispatch setfloating address:{address}")
            checked(f"dispatch resizewindowpixel exact 600 420,address:{address}")
            checked(f"dispatch movewindowpixel exact {30 + index * 650} 30,address:{address}")
        person = StandIn()
        owner = person.wait_mapped()
        checked("dispatch movetoworkspacesilent special:ghost,address:" + owner["address"])
        checked("dispatch setfloating address:" + owner["address"])
        checked("dispatch movewindowpixel exact 30 600,address:" + owner["address"])
        checked("dispatch togglespecialworkspace ghost")
        shown = True
        checked("dispatch focuswindow address:" + owner["address"])
        # Use only processes that the lab's exact environment census identifies.
        compositors = {pid: Path(f"/proc/{pid}/comm").read_text().strip()
                       for pid in members(lab)
                       if Path(f"/proc/{pid}/comm").exists()}
        compositors = {pid: name for pid, name in compositors.items() if name in ("Hyprland", "kwin_wayland")}
        if sorted(compositors.values()) != ["Hyprland", "kwin_wayland"]:
            raise RuntimeError("Expected exactly the private inner and outer compositor")
        starts = {pid: identity(pid)[0] for pid in compositors}
        hypr_pid = next(pid for pid, name in compositors.items() if name == "Hyprland")
        binding = loaded_plugin(hypr_pid, report["plugin_source_sha256"])
        report["loaded_plugin"] = binding
        fixture_starts = {actor.pid: identity(actor.pid)[0] for actor in actors + [person.p]}
        expected = {w["address"]: {k: w[k] for k in ("pid", "at", "size", "workspace", "mapped")}
                    for w in clients() if w["pid"] in fixture_starts}
        if len(expected) != 3:
            raise RuntimeError("Expected all three fixture windows")

        def check_fixtures():
            for actor in actors + [person.p]:
                if actor.poll() is not None or identity(actor.pid)[0] != fixture_starts[actor.pid]:
                    raise RuntimeError("Fixture exited or changed identity")
            current = {w["address"]: {k: w[k] for k in ("pid", "at", "size", "workspace", "mapped")}
                       for w in clients() if w["pid"] in fixture_starts}
            if current != expected or json.loads(hypr("j/activewindow")).get("address") != owner["address"]:
                raise RuntimeError("Mapped fixture geometry or simulated owner focus changed")
            if loaded_plugin(hypr_pid, report["plugin_source_sha256"]) != binding:
                raise RuntimeError("Loaded plugin binding changed")

        check_fixtures()
        time.sleep(5)
        ticks = os.sysconf("SC_CLK_TCK")
        visible = False
        orders = [("idle", "static", "ipc", "moving"), ("moving", "ipc", "static", "idle")]
        for order in orders:
            for phase in order:
                want = phase in ("static", "moving")
                for window in windows:
                    address = window["address"]
                    if want:
                        checked(f"ghost-cursor {address} 100 100")
                        cursor_addresses.add(address)
                    elif visible:
                        checked(f"ghost-hide-cursor {address}")
                        cursor_addresses.discard(address)
                visible = want
                time.sleep(0.5)
                check_fixtures()
                before = {pid: identity(pid) for pid in compositors}
                start = time.monotonic()
                requests = 0
                request_times = []
                while time.monotonic() - start < 6:
                    if phase in ("ipc", "moving"):
                        request_times.append(time.monotonic() - start)
                        for window in windows:
                            if phase == "moving":
                                checked(f"ghost-cursor {window['address']} {100 + requests % 200} 100")
                            else:
                                value = json.loads(hypr(f"ghost-state {window['address']}"))
                                if not isinstance(value.get("suspended"), bool):
                                    raise RuntimeError("Invalid read-only control response")
                        requests += 1
                    time.sleep(max(0, start + (requests * 0.05 if phase in ("ipc", "moving") else 6) - time.monotonic()))
                elapsed = time.monotonic() - start
                after = {pid: identity(pid) for pid in compositors}
                check_fixtures()
                rate = requests / elapsed
                if phase in ("ipc", "moving") and abs(rate - 20) > 0.2:
                    raise RuntimeError(f"Request cadence outside 20 Hz +/- 0.2 tolerance: {rate}")
                cpu = {}
                for pid, name in compositors.items():
                    if before[pid][0] != starts[pid] or after[pid][0] != starts[pid]:
                        raise RuntimeError("Compositor process identity changed during sample")
                    cpu[name] = (after[pid][1] - before[pid][1]) / ticks
                report["samples"].append({"phase": phase, "elapsed_seconds": elapsed,
                                          "request_pairs": requests, "request_pair_hz": rate,
                                          "request_times_seconds": request_times, "cpu_seconds": cpu})
        report["pass"] = True
    except BaseException as error:
        report["error"] = repr(error)
        raise
    finally:
        errors = []
        for address in cursor_addresses:
            try:
                reply = hypr(f"ghost-hide-cursor {address}").strip()
                if reply not in ("ok", "no cursor for window"):
                    raise RuntimeError(reply)
            except Exception as error:
                errors.append(repr(error))
        for actor in actors + ([person.p] if person else []):
            try:
                if actor.poll() is None:
                    actor.terminate()
                actor.wait(timeout=5)
            except Exception as error:
                errors.append(repr(error))
                try:
                    if actor.poll() is None:
                        actor.kill()
                    actor.wait(timeout=3)
                except Exception as final_error:
                    errors.append(repr(final_error))
        if shown:
            try:
                current = json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"]
                if current == "special:ghost":
                    checked("dispatch togglespecialworkspace ghost")
                elif current:
                    raise RuntimeError("Unexpected workspace during cleanup")
            except Exception as error:
                errors.append(repr(error))
        try:
            with ActionControl(control_path) as control:
                control.configure(mode=original_mode)
                if control.inspect()["settings"]["mode"] != original_mode:
                    raise RuntimeError("Controller mode restoration differs")
        except Exception as error:
            errors.append(repr(error))
        report["cleanup_errors"] = errors
        if errors:
            report["pass"] = False
        (lab / "cursor-cost-report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
        if errors:
            raise RuntimeError(f"Probe cleanup failed: {errors}")


if __name__ == "__main__":
    main()
