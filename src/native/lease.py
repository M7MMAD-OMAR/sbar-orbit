"""Read-only exact-unit process ownership for native-session integration."""
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
from contextlib import contextmanager

from .budget import require_budget


class LeaseError(RuntimeError):
    pass


def manager_environment():
    runtime = Path(f"/run/user/{os.getuid()}")
    bus = runtime / "bus"
    info = bus.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise LeaseError("No owned user manager bus")
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": str(runtime),
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={bus}"}


def unit_properties(unit):
    if not isinstance(unit, str) or not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.(service|scope)", unit):
        raise LeaseError("Not a generated native unit name")
    environment = manager_environment()
    try:
        from gi.repository import Gio, GLib
    except ImportError:
        Gio = GLib = None
    if Gio is not None:
        properties = manager_properties(unit, environment, Gio, GLib)
    else:
        properties = systemctl_properties(unit, environment)
    if properties.get("ActiveState") != "active" or not re.fullmatch(r"[0-9a-f]{32}", properties.get("InvocationID", "")):
        raise LeaseError("Native unit is not active with a valid invocation")
    return properties


def systemctl_properties(unit, environment):
    result = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                             "--property=InvocationID,ControlGroup,ActiveState"],
                            env=environment, capture_output=True, text=True,
                            timeout=3, check=True)
    if len(result.stdout) > 32768:
        raise LeaseError("Manager response is too large")
    properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return properties


def manager_properties(unit, environment, Gio, GLib):
    """Fresh bounded reads, with no connection or unit-state cache."""
    cancel = Gio.Cancellable()
    timer = threading.Timer(3, cancel.cancel)
    timer.daemon = True
    connection = None
    errors = []
    timer.start()
    try:
        connection = Gio.DBusConnection.new_for_address_sync(
            environment["DBUS_SESSION_BUS_ADDRESS"],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, cancel)
        connection.set_exit_on_close(False)

        def call(path, interface, method, arguments, signature):
            reply = connection.call_sync("org.freedesktop.systemd1", path, interface, method,
                                         arguments, GLib.VariantType(signature),
                                         Gio.DBusCallFlags.NO_AUTO_START, 3000, cancel)
            if reply.get_size() > 32768:
                raise LeaseError("Manager response is too large")
            return reply

        path = call("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit",
                    GLib.Variant("(s)", (unit,)), "(o)").unpack()[0]
        expected = "/org/freedesktop/systemd1/unit/" + unit.replace("-", "_2d").replace(".", "_2e")
        if path != expected:
            raise LeaseError("Manager returned a different unit")
        properties = {}
        for name, interface, signature in (
                ("InvocationID", "Unit", "ay"), ("ActiveState", "Unit", "s"),
                ("ControlGroup", "Service" if unit.endswith(".service") else "Scope", "s")):
            value = call(path, "org.freedesktop.DBus.Properties", "Get",
                         GLib.Variant("(ss)", ("org.freedesktop.systemd1." + interface, name)),
                         "(v)").get_child_value(0).get_variant()
            if value.get_type_string() != signature:
                raise LeaseError("Manager property has an invalid type")
            data = value.unpack()
            if name == "InvocationID":
                if len(data) != 16:
                    raise LeaseError("Manager invocation has an invalid size")
                data = bytes(data).hex()
            properties[name] = data
        if cancel.is_cancelled():
            raise LeaseError("Manager query deadline exceeded")
    except Exception as error:
        errors.append(LeaseError(f"Native manager query failed: {error}"))
    finally:
        timer.cancel()
        timer.join()
        if connection is not None:
            close_cancel = Gio.Cancellable()
            close_timer = threading.Timer(3, close_cancel.cancel)
            close_timer.daemon = True
            close_timer.start()
            try:
                connection.close_sync(close_cancel)
            except Exception as error:
                errors.append(LeaseError(f"Native manager connection cleanup failed: {error}"))
            finally:
                close_timer.cancel()
                close_timer.join()
    if errors:
        raise LeaseError("Native manager read or cleanup failed") from ExceptionGroup("Manager errors", errors)
    return properties


def budget_path():
    require_budget()
    text = Path("/proc/self/cgroup").read_text()
    path = next((line[3:] for line in text.splitlines() if line.startswith("0::")), "")
    parts = path.split("/")
    return "/".join(parts[:parts.index("sbarorbit.slice") + 1])


def cgroup_directory(path):
    if not path.startswith("/") or any(part in (".", "..") for part in path.split("/")):
        raise LeaseError("Invalid cgroup path")
    directory = Path("/sys/fs/cgroup") / path.removeprefix("/")
    if directory.resolve() != directory or not directory.is_dir():
        raise LeaseError("Cgroup is not a canonical directory")
    info = directory.stat()
    return directory, (info.st_dev, info.st_ino)


def process_identity(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        fields = text[text.rindex(")") + 2:].split()
        return (pid, int(fields[19])) if fields[0] != "Z" else None
    except (FileNotFoundError, ProcessLookupError):
        return None


class NativeLease:
    """An invocation and directory bind, never the shared runtime or a PID alone."""
    def __init__(self, unit):
        properties = unit_properties(unit)
        group = properties.get("ControlGroup", "")
        if group != f"{budget_path()}/{unit}":
            raise LeaseError("Native unit is outside its exact shared-budget child")
        self.unit = unit
        self.group = group
        self.invocation = properties["InvocationID"]
        self.directory, self.directory_identity = cgroup_directory(group)

    def verify(self):
        properties = unit_properties(self.unit)
        if properties["InvocationID"] != self.invocation or properties["ControlGroup"] != self.group:
            raise LeaseError("Native unit invocation changed")
        directory, identity = cgroup_directory(self.group)
        if directory != self.directory or identity != self.directory_identity:
            raise LeaseError("Native cgroup directory changed")

    def contains(self, process):
        self.verify()
        result = self._contains(process)
        self.verify()
        return result

    def _contains(self, process):
        if not isinstance(process, tuple) or len(process) != 2 or any(type(value) is not int or value <= 0 for value in process):
            return False
        pid = process[0]
        if process_identity(pid) != process:
            return False
        try:
            group = next((line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if line.startswith("0::")), "")
        except (FileNotFoundError, ProcessLookupError):
            return False
        return (group == self.group or group.startswith(self.group + "/")) and process_identity(pid) == process

    def members(self):
        with self.membership() as members:
            return members

    @contextmanager
    def membership(self):
        """Fresh membership, verified across the caller's entire observation."""
        self.verify()
        try:
            result = set()
            directories = [self.directory]
            while directories:
                directory = directories.pop()
                try:
                    for entry in directory.iterdir():
                        if entry.is_dir() and not entry.is_symlink():
                            directories.append(entry)
                    for token in (directory / "cgroup.procs").read_text().split():
                        process = process_identity(int(token))
                        if process and self._contains(process):
                            result.add(process)
                except FileNotFoundError:
                    continue
            yield result
        except BaseException as error:
            try:
                self.verify()
            except BaseException as verification:
                raise BaseExceptionGroup("Native membership observation and revalidation failed", [error, verification])
            raise
        else:
            self.verify()
