#!/usr/bin/python3
"""Isolated lab for the ghost cursor experiment.

A headless KWin hosts a nested Hyprland. The lab has its own session bus, accessibility bus,
runtime directory, HOME and XDG directories, so nothing it starts can reach the person's screen,
input, session bus or files.

    lab.py up                 start a lab, print its directory
    lab.py up --disk          use a private disk-backed lab for scoped native proofs
    lab.py up --render-node /dev/dri/renderDNUMBER  select an outer render device
    lab.py down LAB           stop every process that belongs to it
    lab.py run LAB -- CMD...  run a command inside the lab environment (foreground)
    lab.py spawn LAB -- CMD...  start a command inside the lab, detached, print its pid
    lab.py env LAB            print the environment as shell exports
"""
import argparse, json, os, re, shutil, signal, stat, subprocess, sys, tempfile, time
from pathlib import Path

LAB_ROOTS = (Path("/tmp"), Path("/var/tmp"))
STRIP = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE",
         "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "XAUTHORITY", "NOTIFY_SOCKET", "HYPRLAND_CMD",
         "XDG_SESSION_DESKTOP", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION", "GDK_BACKEND", "QT_QPA_PLATFORM",
         "SSH_AUTH_SOCK", "GNOME_KEYRING_CONTROL"]

# Focus and input options copied from the person's live session (read with hyprctl getoption on
# 3 October 2026), so a pass in the lab predicts the live session. Results hold under these values.
HYPR_CONF = """\
monitor = WAYLAND-1, 1920x1200, 0x0, 1
input {
  kb_layout = us,ara
  kb_options = grp:alt_space_toggle
  follow_mouse = 1
}
misc {
  disable_hyprland_logo = true
  disable_splash_rendering = true
  focus_on_activate = true
}
cursor {
  no_warps = false
}
general {
  layout = dwindle
}
ecosystem {
  no_update_news = true
  no_donation_nag = true
}
animations {
  enabled = false
}
"""


def wait(cond, seconds, what):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return
        time.sleep(0.1)
    raise SystemExit(f"lab: timed out waiting for {what}")


def private_lab_directory(path):
    path = Path(path)
    info = path.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise SystemExit("lab: refusing noncanonical or nonprivate directory")
    return path


def lab_path(arg, partial=False):
    lab = Path(arg)
    if lab.parent not in LAB_ROOTS or not re.fullmatch(r"gl-[A-Za-z0-9_-]+", lab.name):
        raise SystemExit(f"lab: not a lab directory: {arg}")
    private_lab_directory(lab)
    if not (partial or (lab / "state.json").is_file()):
        raise SystemExit(f"lab: not a lab directory: {arg}")
    return lab


# The lab starts from an allowlist, never from the host environment: the host holds API keys and
# session tokens, and nothing in the lab needs them. Measured 3 October 2026: inheriting the host
# environment put a provider key into a systemd unit description and the user journal.
ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM", "XDG_DATA_DIRS", "TZ"]


def base_env(lab):
    env = {k: os.environ[k] for k in ALLOW if k in os.environ}
    home = lab / "home"
    env.update(HOME=str(home), XDG_RUNTIME_DIR=str(lab / "run"), XDG_CONFIG_HOME=str(home / ".config"),
               XDG_DATA_HOME=str(home / ".local/share"), XDG_STATE_HOME=str(home / ".local/state"),
               XDG_CACHE_HOME=str(home / ".cache"), HYPRLAND_NO_CRASHREPORTER="1", HYPRLAND_NO_SD_NOTIFY="1",
               HYPRLAND_NO_SD_VARS="1", NO_AT_BRIDGE="0",
               # No gvfs or document portal FUSE mounts inside the lab: they outlive a crashed lab.
               GIO_USE_VFS="local", GTK_USE_PORTAL="0", TMPDIR=str(lab / "tmp"))
    return env


def lab_env(lab):
    state = json.loads((lab / "state.json").read_text())
    env = base_env(lab)
    env.update(state["env"])
    return env


def lab_socket(path):
    path = Path(path)
    run = private_lab_directory(path.parent)
    if run.name != "run":
        raise SystemExit("lab: refusing socket outside the lab runtime")
    lab_path(run.parent, partial=True)
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise SystemExit("lab: refusing noncanonical or foreign Wayland socket")
    return path


def guard(env):
    """Refuse to act unless every display, bus and runtime path points inside a lab."""
    run = env.get("XDG_RUNTIME_DIR", "")
    bus = env.get("DBUS_SESSION_BUS_ADDRESS", "")
    display = env.get("WAYLAND_DISPLAY", "")
    if (not run or not display or display in (".", "..") or "/" in display
            or bus != f"unix:path={run}/bus" or "DISPLAY" in env or "WAYLAND_SOCKET" in env):
        raise SystemExit("lab: refusing, environment does not point inside a lab")
    try:
        lab_socket(Path(run) / display)
    except OSError as error:
        raise SystemExit("lab: refusing, lab Wayland socket missing") from error


HOST_ENV = {k: os.environ[k] for k in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "PATH", "HOME") if k in os.environ}


def scoped(lab, name, argv, env):
    """Run argv in its own systemd user scope, capped, so it neither lives in the agent host's
    process group nor can
    take memory from the person's desktop. systemd-run --scope execs argv in place: same pid."""
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
    unit = f"ghostlab-{lab.name}-{safe}"
    # The environment goes through a 0600 file, so it never appears in argv, ps, the unit's
    # description or the journal.
    envfile = lab / f".env-{safe}"
    fd = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(env, f)
    return ["systemd-run", "--user", "--scope", "--quiet", "--slice=sbarorbit.slice", f"--unit={unit}", f"--description=ghost lab {safe}",
            "-p", "MemoryMax=3G", "-p", "CPUWeight=50", "-p", "CollectMode=inactive-or-failed", "--",
            "/usr/bin/python3", str(Path(__file__).resolve()), "exec-env", str(envfile), *argv]


def spawn(lab, argv, env, name, log=True):
    out = open(lab / f"{name}.log", "ab") if log else subprocess.DEVNULL
    # systemd-run itself talks to the person's user manager; only the command inside gets the lab env.
    p = subprocess.Popen(scoped(lab, name, argv, env), env=HOST_ENV, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                         start_new_session=True, cwd=env["HOME"])
    with open(lab / "pids", "a") as f:
        record = process_record(p.pid)
        if record is not None:
            f.write(json.dumps(record) + "\n")
    return p


def ensure_no_devices(lab, pid):
    """Abort the lab if the nested compositor holds any real input device or display card."""
    held = []
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith("/dev/input/") or target.startswith("/dev/dri/card") or target == "/dev/uinput":
            held.append(target)
    if held:
        down(lab)
        raise SystemExit(f"lab: ABORTED, nested compositor opened real devices: {sorted(set(held))}")


def usable_output(monitors):
    return (len(monitors) == 1 and monitors[0].get("name") == "WAYLAND-1"
            and monitors[0].get("width") == 1920 and monitors[0].get("height") == 1200
            and not monitors[0].get("disabled"))


def failed_output(lab, source_log, observed, primary):
    errors = [primary]
    try:
        evidence = Path(__file__).with_name("evidence")
        (evidence / f"{lab.name}-invalid-output.json").write_text(json.dumps(observed))
        if source_log.is_file():
            shutil.copyfile(source_log, evidence / f"{lab.name}-invalid-output.log")
    except BaseException as error:
        errors.append(error)
    try:
        down(lab)
    except BaseException as error:
        errors.append(error)
    raise BaseExceptionGroup("Lab output validation or cleanup failed", errors)


def up(render_node=None, disk=False):
    if render_node is not None:
        if not re.fullmatch(r"/dev/dri/renderD[0-9]+", render_node):
            raise SystemExit("lab: expected an explicit DRM render node")
        info = os.lstat(render_node)
        if not stat.S_ISCHR(info.st_mode) or info.st_uid != 0:
            raise SystemExit("lab: render node must be a root-owned character device")
    root = "/var/tmp" if disk else "/tmp"
    if disk:
        filesystem = subprocess.check_output(
            ["/usr/bin/findmnt", "-n", "-o", "FSTYPE", "-T", root], text=True).strip()
        if not filesystem or filesystem in ("tmpfs", "ramfs", "devtmpfs"):
            raise SystemExit("lab: disk root must be backed by a non-RAM filesystem")
    lab = Path(tempfile.mkdtemp(prefix="gl-", dir=root))
    os.chmod(lab, 0o700)
    for d in ["run", "tmp", "home/.config", "home/.local/share", "home/.local/state", "home/.cache", "hypr"]:
        (lab / d).mkdir(parents=True, exist_ok=True)
    os.chmod(lab / "run", 0o700)
    os.chmod(lab / "tmp", 0o700)
    (lab / "state.json").write_text(json.dumps({"env": {}}))
    env = base_env(lab)
    bus = f"unix:path={lab}/run/bus"
    spawn(lab, ["dbus-daemon", "--session", "--nofork", f"--address={bus}"], env, "bus")
    wait(lambda: (lab / "run/bus").is_socket(), 5, "session bus")
    env["DBUS_SESSION_BUS_ADDRESS"] = bus
    # Headless KWin is the outer compositor. Hyprland's nested backend needs xdg_wm_base 6, which the
    # bundled sway lacks, and under headless Mutter it stalls before creating an output. On 3 October
    # 2026 something outside this project SIGKILLed every kwin_wayland for a while; if that recurs the
    # lab stops here, it never falls back to anything that touches the person's seat.
    outer_env = dict(env)
    if render_node is not None:
        outer_env["KWIN_RENDER_NODES"] = render_node
    outer = spawn(lab, ["kwin_wayland", "--virtual", "--no-lockscreen", "--no-global-shortcuts",
                        "--width", "1920", "--height", "1200", "--socket", "outer-0"], outer_env, "outer")
    wait(lambda: (lab / "run/outer-0").is_socket(), 15, "outer compositor")
    (lab / "hypr/hyprland.conf").write_text(HYPR_CONF)
    # Hyprland must never open the person's seat. If its seat backend works it opens a session, and
    # with a session it reads every real keyboard and mouse through libinput and tries the GPU through
    # DRM. Measured 3 October 2026: through logind it tried to take the live seat (refused only
    # because the session held it), and through the noop backend it opened /dev/input directly. The
    # seatd backend pointed at a socket that does not exist fails cleanly, so there is no session at
    # all; the nested Wayland backend needs none. ensure_no_devices() checks the result every start.
    henv = dict(env, WAYLAND_DISPLAY="outer-0", LIBSEAT_BACKEND="seatd", SEATD_SOCK=str(lab / "no-seat"),
                AQ_DRM_DEVICES="/nonexistent")
    if outer.poll() is not None:
        raise SystemExit("lab: outer compositor exited")
    hypr_proc = spawn(lab, ["Hyprland", "-c", str(lab / "hypr/hyprland.conf")], henv, "hyprland")
    hypr = lab / "run/hypr"
    wait(lambda: hypr.is_dir() and any((d / ".socket.sock").exists() for d in hypr.iterdir()), 20, "Hyprland")
    sig = next(d.name for d in hypr.iterdir() if (d / ".socket.sock").exists())
    monitor_env = dict(henv, HYPRLAND_INSTANCE_SIGNATURE=sig)
    observed = []
    def observe_output():
        nonlocal observed
        reply = subprocess.run(["hyprctl", "-j", "monitors"], env=monitor_env,
                               capture_output=True, text=True, timeout=2, check=True)
        observed = json.loads(reply.stdout)
        return usable_output(observed)
    try:
        wait(observe_output, 8, "usable 1920x1200 nested output")
    except BaseException as primary:
        failed_output(lab, hypr / sig / "hyprland.log", observed, primary)
    time.sleep(1.0)
    ensure_no_devices(lab, hypr_proc.pid)
    wait(lambda: any(p.name.startswith("wayland-") and p.is_socket() for p in (lab / "run").iterdir()), 10, "nested socket")
    wl = sorted(p.name for p in (lab / "run").iterdir() if p.name.startswith("wayland-") and p.is_socket())[0]
    env.update(HYPRLAND_INSTANCE_SIGNATURE=sig, WAYLAND_DISPLAY=wl, GDK_BACKEND="wayland", QT_QPA_PLATFORM="wayland")
    spawn(lab, ["/usr/libexec/at-spi-bus-launcher", "--launch-immediately"], env, "atspi")
    time.sleep(0.8)
    spawn(lab, ["/usr/libexec/at-spi2-registryd"], env, "registry")
    time.sleep(0.5)
    # Chromium, Electron and Qt only expose a tree when assistive technology is reported on.
    subprocess.run(["busctl", f"--address={bus}", "set-property", "org.a11y.Bus", "/org/a11y/bus",
                    "org.a11y.Status", "IsEnabled", "b", "true"], env=env, check=False)
    subprocess.run(["busctl", f"--address={bus}", "set-property", "org.a11y.Bus", "/org/a11y/bus",
                    "org.a11y.Status", "ScreenReaderEnabled", "b", "true"], env=env, check=False)
    keep = {k: env[k] for k in ["DBUS_SESSION_BUS_ADDRESS", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY",
                                "GDK_BACKEND", "QT_QPA_PLATFORM"]}
    (lab / "state.json").write_text(json.dumps({"env": keep}))
    guard(lab_env(lab))
    print(lab)


def process_record(pid):
    try:
        path = Path(f"/proc/{pid}")
        if path.stat().st_uid != os.getuid():
            return None
        fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": int(fields[19]),
                "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except (FileNotFoundError, ProcessLookupError):
        return None


def recorded_members(lab):
    pids = set()
    if (lab / "pids").exists():
        for line in (lab / "pids").read_text().splitlines():
            if line.isdecimal():
                continue  # A historical bare PID is not process ownership evidence.
            value = json.loads(line)
            if (not isinstance(value, dict) or set(value) != {"pid", "start", "boot"}
                    or type(value["pid"]) is not int or value["pid"] <= 0
                    or type(value["start"]) is not int or value["start"] < 0
                    or not isinstance(value["boot"], str)):
                raise RuntimeError("lab: invalid saved process identity")
            if process_record(value["pid"]) == value:
                pids.add(value["pid"])
    return pids


def owns(lab, pid):
    if pid in recorded_members(lab):
        return True
    try:
        return (f"XDG_RUNTIME_DIR={lab}/run".encode() in
                Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") and process_record(pid) is not None)
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return False


def members(lab):
    """Current identities plus processes with this exact private runtime environment."""
    run = f"XDG_RUNTIME_DIR={lab}/run".encode()
    pids = recorded_members(lab)
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                if run in (p / "environ").read_bytes().split(b"\0") and process_record(int(p.name)) is not None:
                    pids.add(int(p.name))
            except OSError:
                pass
    pids.discard(os.getpid())
    return pids


def signal_member(lab, pid, sig):
    before = process_record(pid)
    if before is None:
        return False
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return False
    try:
        if process_record(pid) != before or not owns(lab, pid) or pid == os.getpid():
            return False
        try:
            signal.pidfd_send_signal(descriptor, sig)
        except ProcessLookupError:
            return False
        return True
    finally:
        os.close(descriptor)


def down(lab):
    def unmount():
        for mount in ["run/gvfs", "run/doc"]:
            subprocess.run(["fusermount3", "-uz", str(lab / mount)], stderr=subprocess.DEVNULL, check=False)
    unmount()
    subprocess.run(["systemctl", "--user", "stop", f"ghostlab-{lab.name}-*.scope"], stderr=subprocess.DEVNULL, check=False)
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        for pid in members(lab):
            signal_member(lab, pid, sig)
        time.sleep(1.0)
    left = [p for p in members(lab) if Path(f"/proc/{p}").exists()]
    if left:
        raise SystemExit(f"lab: processes still alive: {left}")
    unmount()
    shutil.rmtree(lab, ignore_errors=True)


def main():
    a = sys.argv[1:]
    if not a:
        raise SystemExit(__doc__)
    if a[0] == "exec-env":  # internal: replace this process with argv under the environment in the file
        env = json.loads(Path(a[1]).read_text())
        os.unlink(a[1])
        os.chdir(env["HOME"])
        os.execvpe(a[2], a[2:], env)
    if a[0] == "up":
        parser = argparse.ArgumentParser(prog="lab.py up")
        parser.add_argument("--disk", action="store_true")
        parser.add_argument("--render-node")
        options = parser.parse_args(a[1:])
        return up(options.render_node, disk=options.disk)
    lab = lab_path(a[1], partial=a[0] == "down")
    if a[0] == "down":
        return down(lab)
    env = lab_env(lab)
    guard(env)
    if a[0] == "env":
        for k in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY",
                  "GDK_BACKEND", "QT_QPA_PLATFORM", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]:
            print(f"export {k}={env[k]}")
        print("unset DISPLAY SSH_AUTH_SOCK")
        return
    argv = a[a.index("--") + 1:]
    if a[0] == "run":
        sys.exit(subprocess.run(argv, env=env, cwd=env["HOME"]).returncode)
    if a[0] == "spawn":
        name = Path(argv[0]).name + "-" + str(int(time.time() * 1000) % 100000)
        print(spawn(lab, argv, env, name).pid)
        return
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
