"""Run native GTK apps on a private Sway headless display, never the host display."""
import json
import os
from pathlib import Path
import shlex
import signal
import select
import stat
import subprocess
import tempfile
import time
import sys

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / "src/native"))
from budget import require_budget
require_budget()
runtime = Path(tempfile.mkdtemp(prefix="orbit-native-"))
packages = project / ".runtime/sway/root/usr"
sway = packages / "bin/sway"
swaymsg = packages / "bin/swaymsg"
fixture = Path(__file__).with_name("fixture.py")
output = project / "output/native"
output.mkdir(parents=True, exist_ok=True)
config = runtime / "sway.conf"
config.write_text("output HEADLESS-1 mode 1280x800\noutput * bg #e9eef5 solid_color\nseat seat0 fallback true\nxwayland force\ndefault_border none\nfocus_follows_mouse no\n")
env = {key: value for key, value in os.environ.items() if key not in
       ("DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NOTIFY_SOCKET")}
env.update({"XDG_RUNTIME_DIR": str(runtime), "WLR_BACKENDS": "headless", "WLR_HEADLESS_OUTPUTS": "1",
            "WLR_RENDERER": "pixman", "WLR_LIBINPUT_NO_DEVICES": "1", "LD_LIBRARY_PATH": str(packages / "lib64"),
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(runtime / "no-session-bus"), "NO_AT_BRIDGE": "1"})
log = (runtime / "sway.log").open("w")
process = subprocess.Popen([str(sway), "-c", str(config), "-d"], env=env, stdout=log, stderr=log, start_new_session=True)
owned_apps = []
pointer = None
report = {"runtime": str(runtime), "pid": process.pid, "results": []}

def wait_for(probe, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = probe()
        if result:
            return result
        if process.poll() is not None:
            raise RuntimeError("Private compositor exited: " + (runtime / "sway.log").read_text()[-2500:])
        time.sleep(0.05)
    raise TimeoutError("Private display operation timed out")

def sockets(pattern):
    return [p for p in runtime.glob(pattern) if stat.S_ISSOCK(p.stat().st_mode)]

def state(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None

def host_sample():
    active = json.loads(subprocess.check_output(["hyprctl", "-j", "activewindow"], text=True))
    clients = json.loads(subprocess.check_output(["hyprctl", "-j", "clients"], text=True))
    pids = [process.pid] + owned_apps
    return {"own_active": active.get("pid") in pids, "own_visible": any(c.get("pid") in pids for c in clients)}

try:
    ipc = wait_for(lambda: sockets("sway-ipc.*.sock"))[0]
    display = wait_for(lambda: sockets("wayland-*"))[0]
    env["WAYLAND_DISPLAY"] = display.name
    env["SWAYSOCK"] = str(ipc)
    assert ipc.parent == runtime and display.parent == runtime
    pointer = subprocess.Popen([str(project / ".runtime/sway/pointer"), str(display)], env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    def pointer_reply(expected):
        if not select.select([pointer.stdout], [], [], 5)[0] or pointer.stdout.readline().strip() != expected:
            raise RuntimeError("Private virtual pointer failed")
    pointer_reply("ready")
    def click(x, y):
        pointer.stdin.write(f"{x} {y}\n")
        pointer.stdin.flush()
        pointer_reply("ok")

    def command(*args):
        completed = subprocess.run([str(swaymsg), "-s", str(ipc), *args], env=env, capture_output=True, text=True, timeout=5)
        if completed.returncode:
            raise RuntimeError(completed.stderr + completed.stdout)
        value = json.loads(completed.stdout)
        if isinstance(value, list) and any(v.get("success") is False for v in value):
            raise RuntimeError(str(value))
        return value

    report["outputs"] = [{k: v[k] for k in ("name", "active", "current_mode")} for v in command("-t", "get_outputs")]
    assert len(report["outputs"]) == 1 and report["outputs"][0]["name"] == "HEADLESS-1"
    report["samples"] = [host_sample()]
    for backend in ("wayland", "x11"):
        datafile = runtime / (backend + ".json")
        launch = shlex.join(["/usr/bin/env", "GDK_BACKEND=" + backend, "/usr/bin/python3", str(fixture), str(datafile)])
        command("exec", launch)
        initial = wait_for(lambda: state(datafile))
        owned_apps.append(initial["pid"])
        def mapped():
            def find(node):
                if node.get("pid") == initial["pid"] and node.get("visible"):
                    return node
                for child in node.get("nodes", []) + node.get("floating_nodes", []):
                    if value := find(child):
                        return value
                return None
            return find(command("-t", "get_tree"))
        wait_for(mapped)
        command("[pid=" + str(initial["pid"]) + "]", "focus")
        # Mapping and focus IPC finish before Xwayland has processed all events.
        # This bounded settling delay is a prototype limit, not a readiness API.
        time.sleep(0.5)
        text = "Orbit " + backend + " independent input"
        click(120, 180)
        pointer.stdin.write("text " + text + "\n")
        pointer.stdin.flush()
        pointer_reply("ok")
        click(550, 180)
        saved = wait_for(lambda: (v if (v := state(datafile)) and v.get("saved") == text else None))
        screenshot = output / (backend + ".png")
        subprocess.run(["/usr/bin/grim", "-o", "HEADLESS-1", str(screenshot)], env=env, check=True, timeout=5)
        report["results"].append({**saved, "screenshot": str(screenshot)})
        report["samples"].append(host_sample())
        command("[pid=" + str(initial["pid"]) + "]", "kill")
        time.sleep(0.2)
    report["status"] = "passed"
    assert not any(s["own_active"] or s["own_visible"] for s in report["samples"])
except Exception as error:
    report["status"] = "failed"
    report["error"] = str(error)
    if env.get("WAYLAND_DISPLAY") and process.poll() is None:
        subprocess.run(["/usr/bin/grim", "-o", "HEADLESS-1", str(output / "failure.png")], env=env, timeout=5)
    raise
finally:
    if pointer is not None and pointer.poll() is None:
        pointer.terminate()
        try:
            pointer.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pointer.kill()
            pointer.wait(timeout=5)
    for pid in owned_apps:
        try:
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
            if str(fixture).encode() in cmd and str(runtime).encode() in cmd:
                os.kill(pid, signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError):
            pass
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    log.close()
    report["compositor_exit"] = process.returncode
    (output / "latest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
