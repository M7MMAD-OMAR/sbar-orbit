#!/usr/bin/python3
"""Private-lab process identities, including compositor-launched clients."""
import os
import signal
import time
from pathlib import Path
from lab import guard


def identity(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        fields = stat[stat.rindex(")") + 2:].split()
        return (pid, int(fields[19])) if fields[0] != "Z" else None
    except (FileNotFoundError, ProcessLookupError):
        return None


def processes(launch_id=None, root_identity=None):
    guard(os.environ)
    lab = Path(os.environ["XDG_RUNTIME_DIR"]).parent
    expected = f"XDG_RUNTIME_DIR={lab}/run".encode()
    found = set()
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            environment = []
        try:
            cgroup = Path(f"/proc/{pid}/cgroup").read_text()
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Headless compositor processes may disable environment inspection.
        # Their lab-specific systemd scope remains authoritative ownership.
        owned_scope = f"/ghostlab-{lab.name}-" in cgroup
        if (expected in environment or owned_scope) and (item := identity(pid)):
            belongs = launch_id is None or f"ORBIT_AGENT_LAUNCH_ID={launch_id}".encode() in environment or item == root_identity
            if belongs:
                found.add(item)
    return found


def launch_identity(marker):
    """Retain the pre-exec root PID and start time, never match a PID alone."""
    import json
    try:
        value = json.loads(Path(marker).read_text())
    except json.JSONDecodeError:
        return None  # The launcher has not completed its small marker write.
    if not isinstance(value, list) or len(value) != 2 or any(type(part) is not int or part <= 0 for part in value):
        raise ValueError("Invalid launch process identity")
    return tuple(value)


def terminate(items):
    """Only signal the same live identity, with its private runtime revalidated."""
    guard(os.environ)
    items = set(items)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        current = processes()
        for item in items & current:
            pid, _ = item
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                if identity(pid) == item:
                    signal.pidfd_send_signal(fd, sig)
            finally:
                os.close(fd)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            alive = {item for item in items if identity(item[0]) == item}
            if not alive:
                return
            time.sleep(0.05)
    raise RuntimeError(f"Private lab processes remain alive: {sorted(alive)}")
