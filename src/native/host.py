#!/usr/bin/python3
"""Read-only endpoint binding for the final native owner-session integration."""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time

from .lease import process_identity as identity


class HostError(RuntimeError):
    pass


def component(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", value) or value in (".", ".."):
        raise HostError("Invalid compositor endpoint component")
    return value


def metadata(path, directory=False):
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISSOCK(info.st_mode)
    if not valid_type or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise HostError("Endpoint must have trusted ownership, type and permissions")
    return [info.st_dev, info.st_ino]


def peer(connection):
    pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    process = identity(pid)
    if uid != os.getuid() or process is None:
        raise HostError("Compositor peer is not a live process owned by this user")
    return list(process)


def inspect_host(environment):
    """Only connect endpoints and send j/version. Never enumerate or act on windows."""
    runtime_text = environment.get("XDG_RUNTIME_DIR", "")
    if not isinstance(runtime_text, str):
        raise HostError("Runtime directory must be a string")
    runtime = Path(runtime_text)
    if not runtime.is_absolute() or str(runtime.resolve()) != runtime_text:
        raise HostError("Runtime directory must be absolute and canonical")
    signature = component(environment.get("HYPRLAND_INSTANCE_SIGNATURE"))
    display = component(environment.get("WAYLAND_DISPLAY"))
    directories = (runtime, runtime / "hypr", runtime / "hypr" / signature)
    directory_identities = [metadata(path, directory=True) for path in directories]
    ipc = runtime / "hypr" / signature / ".socket.sock"
    wayland = runtime / display
    ipc_identity, wayland_identity = metadata(ipc), metadata(wayland)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(wayland))
        wayland_peer = peer(connection)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        deadline = time.monotonic() + 3
        connection.settimeout(3)
        connection.connect(str(ipc))
        ipc_peer = peer(connection)
        if ipc_peer != wayland_peer:
            raise HostError("IPC and Wayland endpoints belong to different compositor processes")
        connection.sendall(b"j/version")
        data = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HostError("Compositor version request exceeded its deadline")
            connection.settimeout(remaining)
            chunk = connection.recv(4096)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 32768:
                raise HostError("Compositor version response is too large")
    version = json.loads(data)
    if not isinstance(version, dict) or not isinstance(version.get("abiHash"), str) or not version["abiHash"]:
        raise HostError("Compositor did not report its ABI")
    if not isinstance(version.get("commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", version["commit"]):
        raise HostError("Compositor did not report a full commit identity")
    if not isinstance(version.get("version"), str) or not version["version"]:
        raise HostError("Compositor did not report a version")
    if [metadata(path, directory=True) for path in directories] != directory_identities:
        raise HostError("Compositor directories changed during preflight")
    if metadata(ipc) != ipc_identity or metadata(wayland) != wayland_identity or identity(ipc_peer[0]) != tuple(ipc_peer):
        raise HostError("Compositor endpoints changed during preflight")
    return {"schema": 1, "runtime": str(runtime), "signature": signature, "display": display,
            "compositor": ipc_peer, "ipc_socket": ipc_identity, "wayland_socket": wayland_identity,
            "abi_hash": version["abiHash"], "commit": version["commit"], "version": version["version"],
            "owner_activation": "not performed", "isolation": "not measured", "theme_match": "not measured",
            "performance": "not measured"}


def verify_host(plan):
    if not isinstance(plan, dict) or type(plan.get("schema")) is not int or plan.get("schema") != 1:
        raise HostError("Unknown native preparation plan")
    current = inspect_host({"XDG_RUNTIME_DIR": plan.get("runtime"),
                            "HYPRLAND_INSTANCE_SIGNATURE": plan.get("signature"),
                            "WAYLAND_DISPLAY": plan.get("display")})
    keys = ("runtime", "signature", "display", "compositor", "ipc_socket", "wayland_socket", "abi_hash", "commit", "version")
    if any(plan.get(key) != current[key] for key in keys):
        raise HostError("Native preparation plan is stale")
    return current


def read_plan(path):
    """Refuse special files, symlinks and unbounded plan input."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise HostError("Preparation plan must be a regular file")
        data = stream.read(65537)
    if len(data) > 65536:
        raise HostError("Preparation plan is too large")
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("plan", "check"))
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "check":
            if args.plan is None:
                parser.error("check requires --plan")
            result = verify_host(read_plan(args.plan))
        else:
            result = inspect_host(os.environ)
        print(json.dumps(result, indent=2))
    except (HostError, OSError, ValueError, TypeError) as error:
        print(json.dumps({"error": str(error), "owner_activation": "not performed"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
