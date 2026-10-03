#!/usr/bin/python3
"""Lab-only scope attach before private buses or application clients exist."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.lease import NativeLease, manager_environment
from lab import guard


def publish(path, value):
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)


def main():
    guard(os.environ)
    require_budget()
    work = Path(sys.argv[1])
    unit = sys.argv[2]
    if not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.scope", unit):
        raise RuntimeError("Invalid native scope name")
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    if work.resolve().parent != lab or not work.is_dir() or work.stat().st_mode & 0o077:
        raise RuntimeError("Native scope profile must be a private lab child")
    log = os.open(work / "launcher.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(log, 2)
    os.close(log)
    if sys.argv[3] != "--" or len(sys.argv) < 5:
        raise RuntimeError("No native application command")
    publish(work / "scope.json", {"unit": unit, "state": "requested"})
    subprocess.run(["/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "3",
                    "PIDs", "au", "1", str(os.getpid()), "Slice", "s", "sbarorbit.slice",
                    "RuntimeMaxUSec", "t", "60000000", "0"],
                   env=manager_environment(), capture_output=True, timeout=3, check=True)
    deadline = time.monotonic() + 3
    while True:
        try:
            lease = NativeLease(unit)
            break
        except RuntimeError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)
    lease.verify()
    publish(work / "scope.json", {"unit": unit, "state": "active", "invocation": lease.invocation,
                                 "group": lease.group, "directory_identity": lease.directory_identity})
    environment = dict(os.environ, HOME=str(work / "home"), XDG_CONFIG_HOME=str(work / "config"),
                       XDG_DATA_HOME=str(work / "data"), XDG_CACHE_HOME=str(work / "cache"),
                       XDG_STATE_HOME=str(work / "state"), DBUS_SESSION_BUS_ADDRESS=f"unix:path={work / 'session'}",
                       AT_SPI_BUS_ADDRESS=f"unix:path={work / 'a11y'}",
                       QT_LINUX_ACCESSIBILITY_ALWAYS_ON="1", GTK_A11Y="atspi")
    if (work / "config" / "kdeglobals").is_file():
        plugin = Path("/usr/lib64/qt6/plugins/platformthemes/KDEPlasmaPlatformTheme6.so")
        info = plugin.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("KDE platform theme must be an installed root-owned library")
        environment["QT_QPA_PLATFORMTHEME"] = "kde"
    for name in ("home", "config", "data", "cache", "state"):
        (work / name).mkdir(mode=0o700, exist_ok=True)
    services_dir = work / "data" / "dbus-1" / "services"
    services_dir.mkdir(parents=True, mode=0o700)
    helper = Path(__file__).with_name("native_activation_fixture.py")
    (services_dir / "org.sbarorbit.ActivationFixture.service").write_text(
        "[D-BUS Service]\nName=org.sbarorbit.ActivationFixture\n"
        f"Exec=/usr/bin/python3 {helper} {work / 'activation.json'}\n")
    for name, bus_type, services in (("session", "session", "<standard_session_servicedirs/>"),
                                     ("a11y", "accessibility", "<servicedir>/usr/share/dbus-1/accessibility-services</servicedir>")):
        config = f'<busconfig><type>{bus_type}</type><listen>unix:path={escape(str(work / name))}</listen><auth>EXTERNAL</auth>{services}<policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_type="method_call"/><allow receive_type="method_return"/><allow receive_type="error"/><allow receive_type="signal"/></policy></busconfig>'
        (work / f"{name}.conf").write_text(config)
        daemon_env = dict(environment, DBUS_SESSION_BUS_ADDRESS=f"unix:path={work / name}")
        subprocess.Popen(["/usr/bin/dbus-daemon", "--nofork", f"--config-file={work / (name + '.conf')}"], env=daemon_env)
    deadline = time.monotonic() + 3
    while not all((work / name).is_socket() for name in ("session", "a11y")):
        if time.monotonic() >= deadline:
            raise RuntimeError("Private accessibility bus did not start")
        time.sleep(0.02)
    subprocess.run(["/usr/bin/busctl", f"--address={environment['DBUS_SESSION_BUS_ADDRESS']}", "call",
                    "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                    "StartServiceByName", "su", "org.sbarorbit.ActivationFixture", "0"],
                   capture_output=True, timeout=3, check=True)
    activation = json.loads((work / "activation.json").read_text())
    keys = ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
            "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS")
    if any(activation["environment"][key] != environment[key] for key in keys if key != "DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError("Activated service inherited another worker profile")
    # D-Bus adds its generated GUID to the same socket address during activation.
    address = activation["environment"]["DBUS_SESSION_BUS_ADDRESS"]
    if not re.fullmatch(re.escape(environment["DBUS_SESSION_BUS_ADDRESS"]) + r"(?:,guid=[0-9a-f]{32})?", address or ""):
        raise RuntimeError("Activated service inherited another session bus")
    if not lease.contains(tuple(activation["process"])):
        raise RuntimeError("Activated service escaped its scope")
    if (work / "color-scheme.json").is_file():
        environment["GSETTINGS_BACKEND"] = "dconf"
        settings = subprocess.run(["/usr/bin/python3", str(Path(__file__).with_name("native_color_scheme.py")),
                                  str(work), unit], env=environment, capture_output=True, text=True, timeout=10)
        sys.stderr.write(settings.stderr)
        settings.check_returncode()
    registry_env = dict(environment, DBUS_SESSION_BUS_ADDRESS=environment["AT_SPI_BUS_ADDRESS"])
    subprocess.Popen(["/usr/libexec/at-spi2-registryd"], env=registry_env)
    deadline = time.monotonic() + 3
    while True:
        status = subprocess.run(["/usr/bin/busctl", f"--address={environment['AT_SPI_BUS_ADDRESS']}", "status", "org.a11y.atspi.Registry"],
                                capture_output=True, timeout=1)
        if status.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Private accessibility registry did not start")
        time.sleep(0.02)
    marker = lab / f"{unit}.pid"
    args = ["/usr/bin/python3",
            str(Path(__file__).with_name("agent_launch.py")), str(marker), "--register", "--", *sys.argv[4:]]
    os.execvpe(args[0], args, environment)


if __name__ == "__main__":
    main()
