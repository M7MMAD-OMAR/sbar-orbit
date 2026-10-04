"""Internal scoped launch step, supervised by an already admitted parent action."""
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.application import private_directory, application_environment
from src.native.budget import require_budget
from src.native.host import read_plan
from src.native.lease import LeaseError, NativeLease, manager_environment, process_identity
from src.native.transport import NativeTransport


def main(profile):
    require_budget()
    profile = private_directory(profile)
    spec = read_plan(profile / "launch.json")
    unit = spec["unit"]
    if not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.scope", unit):
        raise RuntimeError("Invalid native application scope")
    transport = NativeTransport(spec["host"])
    subprocess.run(["/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "2",
                    "PIDs", "au", "1", str(os.getpid()), "Slice", "s", "sbarorbit.slice", "0"],
                   env=manager_environment(), capture_output=True, timeout=3, check=True)
    deadline = time.monotonic() + 3
    while True:
        try:
            lease = NativeLease(unit)
            break
        except LeaseError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)
    process = process_identity(os.getpid())
    token = transport._enroll(lease, process)
    environment = application_environment(profile, spec["host"], unit)
    environment["HL_EXEC_RULE_TOKEN"] = token
    if (profile / "config" / "kdeglobals").is_file():
        plugin = Path("/usr/lib64/qt6/plugins/platformthemes/KDEPlasmaPlatformTheme6.so")
        info = plugin.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("KDE platform theme must be an installed trusted library")
        environment["QT_QPA_PLATFORMTHEME"] = "kde"
    for name, bus_type, services in (("session", "session", "<standard_session_servicedirs/>"),
                                     ("a11y", "accessibility", "<servicedir>/usr/share/dbus-1/accessibility-services</servicedir>")):
        config = f'<busconfig><type>{bus_type}</type><listen>unix:path={escape(str(profile / name))}</listen><auth>EXTERNAL</auth>{services}<policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_type="method_call"/><allow receive_type="method_return"/><allow receive_type="error"/><allow receive_type="signal"/></policy></busconfig>'
        path = profile / f"{name}.conf"
        with open(path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            output.write(config)
        subprocess.Popen(["/usr/bin/dbus-daemon", "--nofork", f"--config-file={path}"],
                         env=dict(environment, DBUS_SESSION_BUS_ADDRESS=f"unix:path={profile / name}"),
                         stdin=subprocess.DEVNULL)
    deadline = time.monotonic() + 3
    while not all((profile / name).is_socket() for name in ("session", "a11y")):
        if time.monotonic() >= deadline:
            raise TimeoutError("Private application buses did not start")
        time.sleep(0.02)
    for name in ("session", "a11y"):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(1)
            connection.connect(str(profile / name))
            pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid() or not lease.contains(process_identity(pid)):
            raise RuntimeError("Private bus escaped the application scope")
    subprocess.Popen(["/usr/libexec/at-spi2-registryd"],
                     env=dict(environment, DBUS_SESSION_BUS_ADDRESS=environment["AT_SPI_BUS_ADDRESS"]),
                     stdin=subprocess.DEVNULL)
    deadline = time.monotonic() + 3
    while True:
        reply = subprocess.run(["/usr/bin/busctl", f"--address={environment['AT_SPI_BUS_ADDRESS']}",
                                "status", "org.a11y.atspi.Registry"], capture_output=True, timeout=1)
        if reply.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("Private accessibility registry did not start")
        time.sleep(0.02)
    lease.verify()
    report = {"unit": unit, "process": process, "token": token}
    temporary = profile / "application.pending"
    with open(temporary, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(report, output)
    temporary.replace(profile / "application.json")
    os.execvpe(spec["argv"][0], spec["argv"], environment)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
