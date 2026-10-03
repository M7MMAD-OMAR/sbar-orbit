"""Read-only exact-unit process ownership for native-session integration."""
import os
from pathlib import Path
import re
import stat
import subprocess

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
    if not isinstance(unit, str) or not re.fullmatch(r"orbit-native-[0-9a-f]{32}\.service", unit):
        raise LeaseError("Not a generated native unit name")
    result = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                             "--property=InvocationID,ControlGroup,ActiveState"],
                            env=manager_environment(), capture_output=True, text=True,
                            timeout=3, check=True)
    if len(result.stdout) > 32768:
        raise LeaseError("Manager response is too large")
    properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if properties.get("ActiveState") != "active" or not re.fullmatch(r"[0-9a-f]{32}", properties.get("InvocationID", "")):
        raise LeaseError("Native unit is not active with a valid invocation")
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
        self.verify()
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
        self.verify()
        return result
