#!/usr/bin/python3
"""Private broker integration and source EOF supervision proof."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import argparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import inspect_host
from src.native.lease import process_identity
from lab import guard
from cursor_cost_probe import loaded_plugin
from native_application_probe import wait
from native_view_probe import prove_view


def cursor_marker(image, variant):
    from PIL import ImageChops
    assert type(variant) is int and variant in (0, 1), "Recording lacks a valid acknowledged cursor variant"
    red, green, blue = image.convert("RGB").split()
    ranges = ((69, 74), (138, 143), (248, 252)) if variant else ((18, 23), (181, 186), (156, 160))
    def channel_mask(channel, bounds):
        return channel.point(lambda value: 255 if bounds[0] <= value <= bounds[1] else 0)
    mask = ImageChops.multiply(channel_mask(red, ranges[0]), channel_mask(green, ranges[1]))
    mask = ImageChops.multiply(mask, channel_mask(blue, ranges[2]))
    bounds = mask.getbbox()
    assert bounds and bounds[2] - bounds[0] <= 12 and bounds[3] - bounds[1] <= 12, "Recording lacks one isolated agent cursor marker"
    return ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)


def identical_rgba(first, second):
    return first.size == second.size and first.convert("RGBA").tobytes() == second.convert("RGBA").tobytes()


def main():
    guard(os.environ)
    require_budget()
    parser = argparse.ArgumentParser()
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()
    here = Path(__file__).resolve()
    root = here.parents[2]
    evidence = here.with_name("evidence")
    private = root / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="broker-cache-", dir=private) as cache, tempfile.TemporaryDirectory(prefix="native-broker-", dir=private) as directory:
        work = Path(directory)
        prepared = inspect_host(os.environ)
        plugin_source = hashlib.sha256((here.parent / "plugin/ghostinput.cpp").read_bytes()).hexdigest()
        build = loaded_plugin(prepared["compositor"][0], plugin_source)
        (work / "host.json").write_text(json.dumps(prepared))
        with ActionControl(work / "control") as control, open(work / "broker.log", "xb") as log:
            child = subprocess.Popen([shutil.which("bun"), str(here.with_name("native_broker_fixture.ts")), str(work)],
                                     stdout=log, stderr=log, env=dict(os.environ, XDG_CACHE_HOME=cache))
            primary, failures = None, []
            try:
                wait(lambda: (work / "ready-for-full").exists() or child.poll() is not None, "Native broker protected phase")
                assert child.poll() is None, "Native broker failed before protected launch test"
                control.configure(mode="full")
                (work / "full-ready").write_text("ready")
                wait(lambda: (work / "native-view-visible").exists() or child.poll() is not None, "Public native GTK view")
                assert child.poll() is None, "Native broker failed before GTK viewing"
                from ghost import clients
                views = [value for value in clients() if value.get("title") == "Orbit native target"]
                assert len(views) == 1, "Native CLI did not map exactly one owned lab viewer"
                view = views[0]
                capture = evidence / "native-live-broker-view.png"
                with open(capture, "wb") as output:
                    subprocess.run(["/usr/bin/grim", "-T", view["stableId"], "-"], stdout=output, check=True, timeout=10)
                recording = None
                if args.record:
                    frames = work / "recording"
                    frames.mkdir(mode=0o700)
                    timestamps = []
                    started = time.monotonic()
                    for index in range(20):
                        if not any(value.get("stableId") == view["stableId"] for value in clients()):
                            break
                        frame_path = frames / f"{index:03d}.png"
                        subprocess.run(["/usr/bin/grim", "-T", view["stableId"], str(frame_path)], check=True, timeout=3)
                        assert frame_path.stat().st_size <= 16 * 1024 * 1024, "Recorded target frame exceeds bound"
                        timestamps.append(time.monotonic() - started)
                        if index == 2:
                            (work / "native-view-captured").write_text("ready")
                        time.sleep(max(0, started + (index + 1) / 5 - time.monotonic()))
                    assert len(timestamps) >= 8, "Live recording did not retain enough actual target captures"
                    pending_recording = work / "native-live-cursor-motion.png"
                    subprocess.run(["/usr/bin/ffmpeg", "-nostdin", "-v", "error", "-y", "-framerate", "5",
                                    "-i", str(frames / "%03d.png"), "-plays", "0", "-f", "apng", str(pending_recording)],
                                   check=True, timeout=20)
                    from PIL import Image
                    variant = json.loads((work / "view-frame.json").read_text())["cursorVariant"]
                    centers = []
                    with Image.open(pending_recording) as animation:
                        assert animation.n_frames == len(timestamps), "Encoded recording dropped target captures"
                        for index in range(animation.n_frames):
                            animation.seek(index)
                            actual = animation.convert("RGBA")
                            with Image.open(frames / f"{index:03d}.png") as original:
                                assert identical_rgba(actual, original), "Recording changed captured pixels"
                            centers.append(cursor_marker(actual, variant))
                        dx, dy = centers[-1][0] - centers[0][0], centers[-1][1] - centers[0][1]
                        assert dx > 50 and dy > 20 and abs(dy - dx * 70 / 160) <= 2, "Recorded agent cursor did not move between acknowledged positions"
                    recording = evidence / "native-live-cursor-motion.png"
                    shutil.copyfile(pending_recording, recording)
                    (evidence / "native-live-cursor-motion.json").write_text(json.dumps({"timestamps_seconds": timestamps,
                        "capture_rate": 5, "encoded_frames": len(timestamps), "decoded_pixels_identical": True,
                        "cursor_marker_centers": centers,
                        "cursor_variant": variant,
                        "owner_activation": "not performed"}))
                else:
                    (work / "native-view-captured").write_text("ready")
                child.wait(timeout=60)
                assert child.returncode == 0, "Native broker integration failed"
                result = json.loads((work / "broker-result.json").read_text())
                if recording:
                    result["recording"] = str(recording)
                for report in work.glob("app-*.json"):
                    state = json.loads(report.read_text())
                    assert all(process_identity(state[name][0]) != tuple(state[name]) for name in ("process", "child")), "Native broker left an owned process alive"
                frame = json.loads((work / "view-frame.json").read_text())
                result["native_view"] = prove_view([frame], work, evidence)
                assert control.inspect()["unresolved"] == []
                result["plugin"] = build
                result["source_sha256"] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in (
                    "src/session.ts", "src/ipc.ts", "src/hyprland.ts", "src/native-worker.ts", "src/native/session_worker.py",
                    "src/native-preview.ts", "src/cli.ts", "src/diagnostics.ts", "src/native/view.py",
                    "experiments/ghost-cursor/native_broker_fixture.ts", "experiments/ghost-cursor/native_broker_probe.py")}
            except BaseException as error:
                primary = error
            finally:
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        try: child.wait(timeout=3)
                        except BaseException as error: failures.append(error)
                for retain in (log.flush,
                               lambda: (evidence / f"native-broker-{os.getpid()}.log").write_bytes((work / "broker.log").read_bytes()),
                               lambda: shutil.copytree(work / "control", evidence / f"native-broker-{os.getpid()}-control")):
                    try:
                        retain()
                    except BaseException as error:
                        failures.append(error)
                diagnostics = work / "control/broker-logs"
                if diagnostics.exists():
                    destination = evidence / f"native-broker-{os.getpid()}-diagnostics"
                    try:
                        shutil.copytree(diagnostics, destination)
                    except BaseException as error:
                        failures.append(error)
            if primary is not None or failures:
                raise BaseExceptionGroup("Native broker proof or cleanup failed", ([primary] if primary else []) + failures)
        assert loaded_plugin(prepared["compositor"][0], plugin_source) == build
        print(json.dumps(result))


if __name__ == "__main__":
    main()
