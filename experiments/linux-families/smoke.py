#!/usr/bin/env python3
"""
l.compositor.smoke and l.capture.frame, in one process, against whichever sway binary it is given.

The private display in src/fedora.ts starts a bundled sway against WLR_BACKENDS=headless with a
scrubbed environment, waits for the IPC and Wayland sockets, asks Xwayland for its display, and then
starts the pointer helper. This does the same, from Python so it runs on a machine that has no Bun,
and asserts what docs/porting.md lists for the probe: the sockets inside 10 seconds, one HEADLESS-1
at the requested mode, a custom mode accepted, the pointer helper answering "ready" (which is what
binding both virtual input globals looks like from outside), one Wayland and one X11 fixture in
get_tree, and a captured frame whose decoded size equals the output mode.

It also records, for G1, every file the compositor holds open under /run/systemd, /run/seatd and
/run/user, which is the whole logind question: a compositor that started with none of them open
started without a logind session.

Usage: smoke.py --sway PATH --libdir DIR --pointer PATH [--x11 xterm] [--wayland foot] [--grim grim]
Prints one JSON object. Exit status is 0 whenever the JSON was written, whatever the verdict.
"""
import argparse, json, os, re, shlex, shutil, socket, struct, subprocess, sys, tempfile, time

parser = argparse.ArgumentParser()
parser.add_argument("--sway", required=True)
parser.add_argument("--libdir", required=True)
parser.add_argument("--pointer", required=True)
parser.add_argument("--x11", default="xterm", help="an X11 fixture: a program name, or a whole command line")
parser.add_argument("--wayland", default="foot", help="a Wayland fixture, the same way")
parser.add_argument("--grim", default="grim")
parser.add_argument("--label", default="")
parser.add_argument("--renderer", default="pixman", help="pixman, or gles2 with --device")
parser.add_argument("--hold", type=float, default=0, help="seconds to keep the display up after the checks, for a probe from outside; the report line is printed first")
parser.add_argument("--device", default="", help="a /dev/dri/renderD* node for a GPU renderer")
args = parser.parse_args()

WIDTH, HEIGHT = 1280, 800
report = {"label": args.label, "sway": args.sway, "libdir": args.libdir, "steps": {}, "timingsMs": {}}
started = time.monotonic()

def step(name, ok, **detail):
    report["steps"][name] = {"ok": bool(ok), **detail}
    return ok

def elapsed(name):
    report["timingsMs"][name] = round((time.monotonic() - started) * 1000)

directory = tempfile.mkdtemp(prefix="/tmp/orbit-native-")
env = dict(os.environ)
for key in ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NOTIFY_SOCKET", "XAUTHORITY"]:
    env.pop(key, None)
for name in ["config", "data", "cache", "state"]:
    os.makedirs(os.path.join(directory, name), 0o700, exist_ok=True)
env.update({
    "XDG_CONFIG_HOME": os.path.join(directory, "config"), "XDG_DATA_HOME": os.path.join(directory, "data"),
    "XDG_CACHE_HOME": os.path.join(directory, "cache"), "XDG_STATE_HOME": os.path.join(directory, "state"),
    "XDG_RUNTIME_DIR": directory, "WLR_BACKENDS": "headless", "WLR_HEADLESS_OUTPUTS": "1", "WLR_RENDERER": "pixman",
    "WLR_LIBINPUT_NO_DEVICES": "1", "LD_LIBRARY_PATH": args.libdir, "NO_AT_BRIDGE": "1",
    "DBUS_SESSION_BUS_ADDRESS": f"unix:path={directory}/no-session-bus",
})
env["WLR_RENDERER"] = args.renderer
if args.device:
    env["WLR_RENDER_DRM_DEVICE"] = args.device
report["renderer"] = {"asked": args.renderer, "device": args.device or None}
config = os.path.join(directory, "sway.conf")
with open(config, "w") as handle:
    handle.write(f"output HEADLESS-1 mode {WIDTH}x{HEIGHT}\nseat seat0 fallback true\nxwayland force\ndefault_border none\nfocus_follows_mouse no\n")
log = open(os.path.join(directory, "compositor.log"), "wb")
def start(extra):
    process = subprocess.Popen([args.sway, *extra, *([] if args.renderer == "pixman" else ["-V"]), "-c", config], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    report["compositorPid"] = process.pid
    report["compositorArgs"] = extra
    return process
sway = start([])

def wait_for(probe, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sway.poll() is not None:
            return False
        value = probe()
        if value:
            return value
        time.sleep(0.05)
    return False

def sockets():
    files = os.listdir(directory)
    ipc = next((f for f in files if re.match(r"^sway-ipc\..*\.sock$", f)), None)
    display = next((f for f in files if re.match(r"^wayland-\d+$", f)), None)
    return (ipc, display) if ipc and display else None

def ipc(kind, payload=""):
    body = payload.encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(env["SWAYSOCK"])
        connection.sendall(b"i3-ipc" + struct.pack("<II", len(body), kind) + body)
        header = b""
        while len(header) < 14:
            chunk = connection.recv(14 - len(header))
            if not chunk:
                raise RuntimeError("compositor closed the IPC connection")
            header += chunk
        size, _ = struct.unpack("<II", header[6:14])
        data = b""
        while len(data) < size:
            chunk = connection.recv(size - len(data))
            if not chunk:
                raise RuntimeError("compositor closed the IPC connection")
            data += chunk
        return json.loads(data)

def compositor_log_tail():
    log.flush()
    try:
        with open(os.path.join(directory, "compositor.log"), "rb") as handle:
            return handle.read()[-2000:].decode("utf-8", "replace")
    except OSError:
        return ""

def visible_windows():
    windows = []
    def collect(node):
        if node.get("pid") and node.get("visible"):
            windows.append({"pid": node["pid"], "shell": node.get("shell"), "app_id": node.get("app_id"), "class": (node.get("window_properties") or {}).get("class")})
        for child in (node.get("nodes") or []) + (node.get("floating_nodes") or []):
            collect(child)
    collect(ipc(4))
    return windows

pointer = None
fixtures = []
try:
    found = wait_for(sockets)
    # sway before 1.10 refuses outright on a machine whose kernel has the proprietary NVIDIA module
    # loaded, headless or not, and says so on its first line. That is a fact about the family's
    # package worth recording, so the retry is taken once, with the flag it asks for, and reported.
    if not found and "Proprietary Nvidia" in compositor_log_tail():
        # The refusal is the finding; it stays in the log and in the report whatever the retry does.
        report["firstAttempt"] = {"args": [], "exit": sway.poll(), "logTail": compositor_log_tail()}
        sway = start(["--unsupported-gpu"])
        found = wait_for(sockets)
    elapsed("sockets")
    if not step("sockets", found, detail="sway-ipc socket and wayland display inside 10 seconds" if found else compositor_log_tail()):
        raise SystemExit
    env["SWAYSOCK"] = os.path.join(directory, found[0])
    env["WAYLAND_DISPLAY"] = found[1]

    outputs = ipc(3)
    headless = next((o for o in outputs if o.get("name") == "HEADLESS-1"), None)
    mode = (headless or {}).get("current_mode") or {}
    step("output", headless is not None and mode.get("width") == WIDTH and mode.get("height") == HEIGHT,
         outputs=[o.get("name") for o in outputs], mode=f"{mode.get('width')}x{mode.get('height')}")

    reply = ipc(0, "output HEADLESS-1 mode --custom 1920x1200")
    after = next((o for o in ipc(3) if o.get("name") == "HEADLESS-1"), {}).get("current_mode") or {}
    step("customMode", all(r.get("success") for r in reply) and after.get("width") == 1920 and after.get("height") == 1200, mode=f"{after.get('width')}x{after.get('height')}")
    ipc(0, f"output HEADLESS-1 mode --custom {WIDTH}x{HEIGHT}")

    # G1: what the compositor holds open under the places a logind session would show up.
    contacts = []
    for fd in os.listdir(f"/proc/{sway.pid}/fd"):
        try:
            target = os.readlink(f"/proc/{sway.pid}/fd/{fd}")
        except OSError:
            continue
        if any(target.startswith(prefix) for prefix in ["/run/systemd", "/run/seatd", "/run/user", "/run/dbus"]):
            contacts.append(target)
    step("noLogindContact", not contacts, contacts=contacts, runSystemdExists=os.path.exists("/run/systemd/system"), seatdSocket=os.path.exists("/run/seatd.sock"))

    handoff = os.path.join(directory, "display.json")
    code = f"import os,json;json.dump({{'display':os.environ.get('DISPLAY')}},open('{handoff}','w'))"
    ipc(0, "exec " + sys.executable + " -c '" + code.replace("'", "'\\''") + "'")
    def display_ready():
        try:
            with open(handoff) as handle:
                value = json.load(handle).get("display")
            return value if re.match(r"^:\d+$", value or "") else None
        except (OSError, ValueError):
            return None
    display = wait_for(display_ready)
    elapsed("xwayland")
    step("xwayland", bool(display), display=display or None, detail=None if display else compositor_log_tail())
    if display:
        env["DISPLAY"] = display

    pointer = subprocess.Popen([args.pointer, os.path.join(directory, env["WAYLAND_DISPLAY"])], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line = b""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not line.endswith(b"\n"):
        if pointer.poll() is not None:
            break
        chunk = pointer.stdout.read1(64) if hasattr(pointer.stdout, "read1") else pointer.stdout.read(1)
        if not chunk:
            break
        line += chunk
    step("pointerReady", line.strip() == b"ready", answer=line.decode("utf-8", "replace").strip(), stderr=pointer.stderr.read1(400).decode("utf-8", "replace") if pointer.poll() is not None else "")
    elapsed("pointer")

    def fixture(command):
        argv = shlex.split(command or "")
        return [shutil.which(argv[0]), *argv[1:]] if argv and shutil.which(argv[0]) else None
    fixture_x11 = fixture(args.x11)
    fixture_wayland = fixture(args.wayland)
    launched_at = time.monotonic()
    for argv in [fixture_x11, fixture_wayland]:
        if argv:
            fixtures.append(subprocess.Popen(argv, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
    # Every window is stamped with the moment it was first seen, so a single fixture's time to map is
    # a reading rather than the length of the wait.
    seen = {}
    def mapped():
        current = visible_windows()
        for window in current:
            if window["pid"] not in seen:
                seen[window["pid"]] = {**window, "mappedAfterMs": round((time.monotonic() - launched_at) * 1000)}
        return list(seen.values()) if len(seen) >= len(fixtures) else None
    windows = (wait_for(mapped, timeout=15) if fixtures else []) or list(seen.values())
    elapsed("fixtures")
    shells = sorted({w.get("shell") for w in windows if w.get("shell")})
    expected = {shell for shell, argv in [("xwayland", fixture_x11), ("xdg_shell", fixture_wayland)] if argv}
    step("fixtures", bool(fixtures) and len(windows) >= len(fixtures) and (expected <= set(shells) if args.x11 != args.wayland else True),
         x11=fixture_x11, wayland=fixture_wayland, windows=windows)

    frame = os.path.join(directory, "frame.png")
    grim = shutil.which(args.grim)
    if grim:
        capture = subprocess.run([grim, "-o", "HEADLESS-1", frame], env=env, capture_output=True, text=True, timeout=20)
        size = None
        if capture.returncode == 0 and os.path.exists(frame):
            with open(frame, "rb") as handle:
                head = handle.read(24)
            if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                size = struct.unpack(">II", head[16:24])
        step("frame", size == (WIDTH, HEIGHT), captureTool=grim, decoded=f"{size[0]}x{size[1]}" if size else None, bytes=os.path.getsize(frame) if os.path.exists(frame) else 0, stderr=capture.stderr.strip()[-300:])
        report["frame"] = frame if os.path.exists(frame) else None
    else:
        step("frame", False, detail="grim is not installed")
    elapsed("frame")
    if args.hold > 0:
        # Printed now, so whoever is holding the display open from outside can read where it is.
        report["holding"] = {"seconds": args.hold, "wayland": os.path.join(directory, env["WAYLAND_DISPLAY"]), "display": display or None, "swaysock": env["SWAYSOCK"]}
        print(json.dumps(report), flush=True)
        time.sleep(args.hold)
except SystemExit:
    pass
except Exception as error:
    report["error"] = f"{type(error).__name__}: {error}"
    report["compositorLogTail"] = compositor_log_tail()
finally:
    for process in fixtures:
        try: process.terminate()
        except OSError: pass
    if pointer and pointer.poll() is None:
        pointer.terminate()
    if sway.poll() is None:
        sway.terminate()
        try: sway.wait(5)
        except subprocess.TimeoutExpired: sway.kill()
    report["compositorExit"] = sway.returncode
    log.close()
    report["directory"] = directory
    report["ok"] = all(s["ok"] for s in report["steps"].values()) and "error" not in report and bool(report["steps"])
    print(json.dumps(report))
