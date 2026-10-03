#!/usr/bin/python3
"""Inspect actual private compositor pixels after cursor move/hide/window move/unload."""
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from action_control import ActionControl
from ghost import clients, hypr
from harness import StandIn
from lab import guard, members
from cursor_cost_probe import loaded_plugin



def verify_cursor_pixels(actual, baseline, boxes, label):
    delta = ImageChops.difference(actual, baseline)
    if not delta.getbbox():
        raise RuntimeError(f"No visible cursor pixels: {label}")
    for box in boxes:
        if not ImageChops.difference(actual, baseline).crop(box).getbbox():
            raise RuntimeError(f"Missing cursor footprint: {label}, {box}")
        delta.paste((0, 0, 0), box)
    if delta.getbbox():
        raise RuntimeError(f"Unexpected pixels outside cursor footprints: {label}, {delta.getbbox()}")


def main():
    guard(os.environ)
    require_budget()
    if len(sys.argv) != 2:
        raise RuntimeError("Provide the exact loaded private plugin path for the unload check")
    root = Path(__file__).resolve().parent
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    hypr_pids = [pid for pid in members(lab) if Path(f"/proc/{pid}/comm").exists()
                 and Path(f"/proc/{pid}/comm").read_text().strip() == "Hyprland"]
    if len(hypr_pids) != 1:
        raise RuntimeError("Expected the exact private compositor")
    report = {"pass": False, "scope": "private captures, not proof of every partial frame",
              "source_sha256": hashlib.sha256((root / "plugin/ghostinput.cpp").read_bytes()).hexdigest(),
              "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "checks": []}
    report["loaded_plugin"] = loaded_plugin(hypr_pids[0], report["source_sha256"])
    if Path(report["loaded_plugin"]["path"]).resolve() != Path(sys.argv[1]).resolve():
        raise RuntimeError("Unload path differs from the measured plugin")
    actors, windows, person, shown = [], [], None, False
    control_path = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(control_path) as control:
        original_mode = control.inspect()["settings"]["mode"]

    def command(value):
        reply = hypr(value).strip()
        if reply != "ok":
            raise RuntimeError(f"{value.split()[0]} failed: {reply}")

    def capture(label, scale):
        time.sleep(0.5)
        if any(actor.poll() is not None for actor in actors + ([person.p] if person else [])):
            raise RuntimeError("Fixture exited before capture")
        mapped_pids = {w["pid"] for w in clients() if w["mapped"]}
        if not all(actor.pid in mapped_pids for actor in actors + ([person.p] if person else [])):
            raise RuntimeError("Fixture disappeared before capture")
        data = subprocess.check_output(["grim", "-"], timeout=5)
        (lab / f"cursor-damage-{label}.png").write_bytes(data)
        im = Image.open(io.BytesIO(data)).convert("RGB")
        # Exclude the simulated person's blinking caret below the canvases.
        return im.crop((0, 0, im.width, min(im.height, math.ceil(550 * scale))))

    def footprint(window, local, scale):
        x, y = (window["at"][i] + local[i] for i in range(2))
        return (math.floor((x - 6) * scale), math.floor((y - 5) * scale),
                math.ceil((x + 28) * scale), math.ceil((y + 35) * scale))

    def only_cursors(actual, baseline, boxes, label):
        verify_cursor_pixels(actual, baseline, boxes, label)
        report["checks"].append(label)

    try:
        if json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"]:
            raise RuntimeError("Visual probe requires a fresh lab workspace")
        with ActionControl(control_path) as control:
            control.configure(mode="full")
        for index in range(2):
            with open(lab / f"cursor-damage-canvas-{index}.log", "ab") as log:
                actor = subprocess.Popen(["/usr/bin/python3", str(root / "canvas.py")], stdout=subprocess.DEVNULL, stderr=log)
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
            for value in (f"movetoworkspacesilent special:ghost,address:{window['address']}",
                          f"setfloating address:{window['address']}",
                          f"resizewindowpixel exact 600 420,address:{window['address']}",
                          f"movewindowpixel exact {30 + 650 * index} 30,address:{window['address']}"):
                command("dispatch " + value)
        person = StandIn()
        owner = person.wait_mapped()
        for value in (f"movetoworkspacesilent special:ghost,address:{owner['address']}",
                      f"setfloating address:{owner['address']}", f"movewindowpixel exact 30 600,address:{owner['address']}",
                      "togglespecialworkspace ghost", f"focuswindow address:{owner['address']}"):
            command("dispatch " + value)
            if value == "togglespecialworkspace ghost":
                shown = True
        clean_by_scale = {}
        for scale in (1, 1.5):
            command(f"keyword monitor WAYLAND-1,1920x1200,0x0,{scale}")
            time.sleep(1)
            command("dispatch movecursor 100 700")
            command("dispatch focuswindow address:" + owner["address"])
            for index, window in enumerate(windows):
                command(f"dispatch movewindowpixel exact {30 + index * 650} 30,address:{window['address']}")
            mapped = {w["pid"]: w for w in clients()}
            windows = [mapped[actor.pid] for actor in actors]
            clean = capture(f"{scale}-clean", scale)
            first, second = windows
            command(f"ghost-cursor {first['address']} 100 100")
            only_cursors(capture(f"{scale}-first", scale), clean, [footprint(first, (100, 100), scale)], f"{scale}: first")
            command(f"ghost-cursor {first['address']} 350 250")
            only_cursors(capture(f"{scale}-moved", scale), clean, [footprint(first, (350, 250), scale)], f"{scale}: old footprint clear")
            edge = (second["size"][0] - 5, second["size"][1] - 5)
            command(f"ghost-cursor {second['address']} {edge[0]} {edge[1]}")
            only_cursors(capture(f"{scale}-pair", scale), clean,
                         [footprint(first, (350, 250), scale), footprint(second, edge, scale)], f"{scale}: both visible")
            command(f"ghost-hide-cursor {first['address']}")
            only_cursors(capture(f"{scale}-hide-first", scale), clean, [footprint(second, edge, scale)], f"{scale}: first hidden")
            command(f"dispatch movewindowpixel exact 550 80,address:{second['address']}")
            moved = capture(f"{scale}-window-moved", scale)
            moved_window = next(w for w in clients() if w["pid"] == actors[1].pid)
            if moved_window["at"] == second["at"]:
                raise RuntimeError("Window move did not change geometry")
            second = moved_window
            command(f"ghost-hide-cursor {second['address']}")
            moved_clean = capture(f"{scale}-window-clean", scale)
            clean_by_scale[scale] = moved_clean
            only_cursors(moved, moved_clean, [footprint(second, edge, scale)], f"{scale}: window edge move")
            command(f"ghost-cursor {second['address']} {edge[0]} {edge[1]}")
            only_cursors(capture(f"{scale}-reshown", scale), moved_clean, [footprint(second, edge, scale)], f"{scale}: reshown")
            if scale == 1:
                command(f"ghost-hide-cursor {second['address']}")
            else:
                report["unload_monitor_before"] = json.loads(hypr("j/monitors"))
                result = subprocess.run(["hyprctl", "plugin", "unload", sys.argv[1]], capture_output=True, text=True, timeout=5, check=True)
                if result.stdout.strip() != "ok":
                    raise RuntimeError(f"Plugin unload failed: {result.stdout} {result.stderr}")
                time.sleep(0.5)
                active = json.loads(subprocess.check_output(["hyprctl", "-j", "plugin", "list"], timeout=5))
                if active:
                    raise RuntimeError("Plugin remains active after unload")
                report["active_plugins_after_unload"] = active
                report["unload_monitor_after"] = json.loads(hypr("j/monitors"))
                restored_scale = report["unload_monitor_after"][0]["scale"]
                if restored_scale not in clean_by_scale:
                    raise RuntimeError("Unload changed to an unmeasured monitor scale")
                if ImageChops.difference(capture("unloaded-natural-scale", restored_scale), clean_by_scale[restored_scale]).getbbox():
                    raise RuntimeError("Unexpected pixels after unload/config reload")
                report["checks"].append("unload/config reload leaves clean pixels")
        report["pass"] = True
    except BaseException as error:
        report["error"] = repr(error)
        raise
    finally:
        errors = []
        for actor in actors + ([person.p] if person else []):
            try:
                if actor.poll() is None:
                    actor.terminate()
                actor.wait(timeout=3)
            except Exception as error:
                errors.append(repr(error))
                try:
                    if actor.poll() is None:
                        actor.kill()
                    actor.wait(timeout=2)
                except Exception as final_error:
                    errors.append(repr(final_error))
        for value in ("keyword monitor WAYLAND-1,1920x1200,0x0,1",):
            try:
                command(value)
            except Exception as error:
                errors.append(repr(error))
        if shown:
            try:
                if json.loads(hypr("j/monitors"))[0]["specialWorkspace"]["name"] == "special:ghost":
                    command("dispatch togglespecialworkspace ghost")
            except Exception as error:
                errors.append(repr(error))
        try:
            with ActionControl(control_path) as control:
                control.configure(mode=original_mode)
                if control.inspect()["settings"]["mode"] != original_mode:
                    raise RuntimeError("Controller mode differs after restoration")
        except Exception as error:
            errors.append(repr(error))
        report["cleanup_errors"] = errors
        if errors:
            report["pass"] = False
        (lab / "cursor-damage-report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
        if errors:
            raise RuntimeError(f"Cleanup failed: {errors}")


if __name__ == "__main__":
    main()
