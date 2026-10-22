"""Read-only identities for normal registered launchers and activation servers."""
import os
from pathlib import Path
import re
import subprocess
import time

from .lease import cgroup_directory, manager_environment, process_identity, systemctl_properties

BUS_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+")


def bus_call(method, name, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Application bus identity deadline exceeded")
    result = subprocess.run(["/usr/bin/gdbus", "call", "--address", manager_environment()["DBUS_SESSION_BUS_ADDRESS"],
        "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus." + method, name],
        capture_output=True, text=True, timeout=remaining, check=True)
    if len(result.stdout) > 4096:
        raise ValueError("Application bus identity response is too large")
    return result.stdout.strip()


def bus_owner(name, deadline):
    match = re.fullmatch(r"\('(:[0-9]+\.[0-9]+)',\)", bus_call("GetNameOwner", name, deadline))
    if not match:
        raise ValueError("Application bus owner response is invalid")
    return match[1]


def bus_number(method, name, deadline):
    match = re.fullmatch(r"\((?:uint32 )?([0-9]+),\)", bus_call(method, name, deadline))
    if not match:
        raise ValueError("Application bus credential response is invalid")
    return int(match[1])


class RegisteredClient:
    def __init__(self, name, owner, process):
        self.name, self.owner, self.process = name, owner, process

    def verify(self):
        try:
            return process_identity(self.process[0]) == self.process and bus_owner(self.name, time.monotonic() + 1) == self.owner
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            return False


def registered_client(name):
    if name is None:
        return None
    if not isinstance(name, str) or not BUS_NAME.fullmatch(name):
        raise ValueError("Registered application bus name is invalid")
    try:
        deadline = time.monotonic() + 3
        owner = bus_owner(name, deadline)
        if bus_number("GetConnectionUnixUser", owner, deadline) != os.getuid():
            return None
        process = process_identity(bus_number("GetConnectionUnixProcessID", owner, deadline))
        if process is not None and bus_owner(name, deadline) == owner:
            return RegisteredClient(name, owner, process)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # No running service is normal: the registered executable may start it.
        return None
    return None


class OriginalLaunchScope:
    """An owner-lifetime application scope, with no stop, kill or cleanup authority."""
    def __init__(self, unit):
        if not re.fullmatch(r"orbit-open-[0-9a-f]{32}\.scope", unit):
            raise ValueError("Original launch scope identity is invalid")
        self.unit = unit
        self.binding = None

    def properties(self):
        result = systemctl_properties(self.unit, manager_environment())
        group = result.get("ControlGroup", "")
        prefix = f"/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/"
        if (result.get("ActiveState") != "active" or not re.fullmatch(r"[0-9a-f]{32}", result.get("InvocationID", ""))
                or not group.startswith(prefix) or not group.endswith("/" + self.unit)):
            raise ValueError("Original launch scope is not the current owned invocation")
        directory, identity = cgroup_directory(group)
        binding = (result["InvocationID"], group, directory, identity)
        if self.binding is None:
            self.binding = binding
        if self.binding != binding:
            raise ValueError("Original launch scope was replaced")
        return binding

    def contains(self, pid):
        process = process_identity(pid)
        if process is None:
            return False
        try:
            before = self.properties()
            group = next((line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if line.startswith("0::")), "")
            return (group == before[1] or group.startswith(before[1] + "/")) and process_identity(pid) == process and self.properties() == before
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            return False
