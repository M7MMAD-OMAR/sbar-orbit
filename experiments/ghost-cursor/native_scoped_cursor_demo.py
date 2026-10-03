#!/usr/bin/python3
"""Record actual scoped native work and compositor cursors on the private lab."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import signal
import tempfile
import re
import sys
import threading
import time

from PIL import Image
from ghost import hypr
from lab import guard
from harness import StandIn, Pointer
from action_control import ActionControl
from native_lease_probe import cleanup_units
from src.native.lease import manager_environment


def main():
    guard(os.environ)
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] not in ("default", "prefer-dark", "prefer-light")):
        raise RuntimeError("Provide appearance config and optional validated color-scheme enum")
    here = Path(__file__).resolve().parent
    evidence = here / "evidence"
    frames, errors = [], []
    stop = threading.Event()

    def capture():
        try:
            while not stop.is_set():
                data = subprocess.check_output(["grim", "-"], timeout=5)
                frames.append((time.monotonic(), data))
                stop.wait(0.1)
        except BaseException as error:
            errors.append(error)

    monitors = json.loads(hypr("j/monitors"))
    if len(monitors) != 1 or monitors[0]["specialWorkspace"]["name"]:
        raise RuntimeError("Recording needs the fresh private lab monitor")
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    control_path = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(control_path) as control:
        original_mode = control.inspect()["settings"]["mode"]
    person, pointer, typist, recorder, actor = None, None, None, None, None
    failure, cleanup_errors = None, []
    unit_report = None
    try:
        descriptor, report_path = tempfile.mkstemp(prefix="native-demo-units-", suffix=".json", dir=lab)
        os.close(descriptor)
        unit_report = Path(report_path)
        unit_report.write_text('{"units": []}')
        person = StandIn()
        pointer = Pointer()
        owner = person.wait_mapped()
        for command in (f"movetoworkspacesilent special:ghost,address:{owner['address']}",
                        f"setfloating address:{owner['address']}",
                        f"resizewindowpixel exact 600 180,address:{owner['address']}",
                        f"movewindowpixel exact 650 1000,address:{owner['address']}"):
            assert hypr("dispatch " + command).strip() == "ok"
        assert hypr("dispatch togglespecialworkspace ghost").strip() == "ok"
        assert hypr("dispatch focuswindow address:" + owner["address"]).strip() == "ok"
        assert hypr("dispatch movecursor 960 1080").strip() == "ok"
        time.sleep(0.2)
        with person.lock:
            before_text = person.states[-1]["text"]
        typed = "person keeps typing 0123456789 " * 10
        recorder = threading.Thread(target=capture)
        recorder.start()
        pointer.start()
        typist = subprocess.Popen(["wtype", "-d", "15", typed])
        actor = subprocess.Popen(["/usr/bin/python3", str(here / "native_scoped_apps.py"), *sys.argv[1:]],
                                 env=dict(os.environ, ORBIT_NATIVE_DEMO_LAYOUT="1",
                                          ORBIT_NATIVE_DEMO_UNITS_FILE=str(unit_report)),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = actor.communicate(timeout=40)
        (evidence / "native-scoped-cursor-actor.log").write_bytes(stdout + stderr)
        if actor.returncode != 0:
            raise RuntimeError(f"Native demo task failed: {stderr.decode()}")
        result = json.loads(stdout)
        typist.wait(timeout=10)
        with person.lock:
            assert person.states[-1]["text"] == before_text + typed
    except BaseException as error:
        failure = error
    finally:
        def attempt(operation):
            try:
                operation()
            except BaseException as error:
                cleanup_errors.append(error)

        if actor and actor.poll() is None:
            # SIGINT raises KeyboardInterrupt so the worker executes its finally.
            attempt(lambda: actor.send_signal(signal.SIGINT))
            attempt(lambda: actor.communicate(timeout=12))
            if actor.poll() is None:
                attempt(actor.kill)
                attempt(lambda: actor.communicate(timeout=2))
        if unit_report:
            def reconcile_units():
                units = json.loads(unit_report.read_text())["units"]
                if not isinstance(units, list) or any(not isinstance(unit, str) or
                        not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.scope", unit) for unit in units):
                    raise RuntimeError("Invalid generated demo scope report")
                def status(unit):
                    reply = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                                            "--property=LoadState,ActiveState"],
                                           env=manager_environment(), capture_output=True, text=True,
                                           timeout=3, check=True)
                    if len(reply.stdout) > 32768:
                        raise RuntimeError("Scope state reply is too large")
                    return dict(line.split("=", 1) for line in reply.stdout.splitlines() if "=" in line)
                for unit in units:
                    def reconcile_one(unit=unit):
                        current = status(unit)
                        if current.get("LoadState") == "not-found" and current.get("ActiveState") == "inactive":
                            return
                        if current.get("LoadState") != "loaded":
                            raise RuntimeError(f"Unknown scope load state: {current}")
                        if current.get("ActiveState") == "inactive":
                            return
                        if current.get("ActiveState") not in ("active", "activating", "deactivating"):
                            cleanup_errors.append(RuntimeError(f"Unexpected scope state: {current}"))
                        cleanup_errors.extend(cleanup_units([unit]))
                        final = status(unit)
                        if final.get("ActiveState") != "inactive":
                            raise RuntimeError(f"Scope did not become inactive: {final}")
                    attempt(reconcile_one)
            attempt(reconcile_units)
        stop.set()
        if recorder and recorder.ident is not None:
            attempt(lambda: recorder.join(timeout=6))
            if recorder.is_alive():
                cleanup_errors.append(RuntimeError("Recording thread did not stop"))
        if pointer and pointer.ident is not None:
            pointer.stop = True
            attempt(lambda: pointer.join(timeout=2))
            if pointer.is_alive():
                cleanup_errors.append(RuntimeError("Pointer observer did not stop"))
        if typist and typist.poll() is None:
            attempt(typist.terminate)
            attempt(lambda: typist.wait(timeout=3))
            if typist.poll() is None:
                attempt(typist.kill)
                attempt(lambda: typist.wait(timeout=2))
        if person:
            attempt(person.stop)
            attempt(lambda: person.p.wait(timeout=3))
        def restore():
            if json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"] == "special:ghost":
                assert hypr("dispatch togglespecialworkspace ghost").strip() == "ok"
        def restore_mode():
            with ActionControl(control_path) as control:
                control.configure(mode=original_mode)
        attempt(restore)
        attempt(restore_mode)
        if unit_report:
            attempt(unit_report.unlink)
    failures = ([failure] if failure else []) + cleanup_errors
    if failures:
        raise BaseExceptionGroup("Native recording or cleanup failed", failures)
    if recorder.is_alive() or errors or len(frames) < 5:
        raise RuntimeError(f"Incomplete recording: {len(frames)} frames; {errors}")
    raw = Path(tempfile.mkdtemp(prefix="native-cursor-originals-", dir=evidence))
    for index, (_, data) in enumerate(frames):
        (raw / f"{index:04}.png").write_bytes(data)
    originals = [Image.open(io.BytesIO(data)).convert("RGB") for _, data in frames]
    images, durations = [], []
    for index, original in enumerate(originals):
        duration = max(1, round((frames[index + 1][0] - frames[index][0]) * 1000)) if index + 1 < len(frames) else 100
        if images and original.tobytes() == images[-1].tobytes():
            durations[-1] += duration
        else:
            images.append(original)
            durations.append(duration)
    output = evidence / "native-scoped-cursor-demo.png"
    images[0].save(output, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True)
    with Image.open(output) as saved:
        assert saved.n_frames == len(images)
        for index, original in enumerate(images):
            saved.seek(index)
            assert saved.convert("RGB").tobytes() == original.tobytes(), index
            assert round(saved.info["duration"]) == durations[index], index
    report = {"scope": "Visible private lab recording; owner session not activated",
              "task": result, "frames": len(images), "pixels_preserved": True, "durations_preserved": True,
              "pointer_positions": sorted(set(pointer.samples)), "standin_typing": "pass",
              "source_png_bytes": sum(len(data) for _, data in frames), "encoded_bytes": output.stat().st_size,
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
              "noninterference": "separate hidden-workspace harness evidence", "performance": "not measured"}
    assert pointer.samples and len(set(pointer.samples)) == 1
    (evidence / "native-scoped-cursor-demo.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
