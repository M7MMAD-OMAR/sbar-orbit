#!/usr/bin/python3
"""Claim a raw agent process in the private lab before exec creates a client."""
import os
import json
import socket
import sys
from pathlib import Path
from lab import guard
from process_scope import identity

guard(os.environ)
os.setpgid(0, 0)
register = sys.argv[2] == "--register"
separator = 3 if register else 2
assert sys.argv[separator] == "--" and len(sys.argv) > separator + 1
pidfile = Path(sys.argv[1])
assert pidfile.parent.resolve() == Path(os.environ["XDG_RUNTIME_DIR"]).parent.resolve()
pidfile.write_text(json.dumps(identity(os.getpid())))
if register:
    unit = os.environ.get("ORBIT_NATIVE_UNIT")
    lease = None
    if unit:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        from src.native.lease import NativeLease
        lease = NativeLease(unit)
        assert lease.contains(identity(os.getpid())), "Launcher is outside its native lease"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(f"{os.environ['XDG_RUNTIME_DIR']}/hypr/{os.environ['HYPRLAND_INSTANCE_SIGNATURE']}/.socket.sock")
        command = f"ghost-register-scope-process {os.getpid()} {unit}" if unit else f"ghost-register-process {os.getpid()}"
        connection.sendall(command.encode())
        result = b""
        while data := connection.recv(4096):
            result += data
    assert result.decode().strip() == "ok", result.decode()
    if lease:
        assert lease.contains(identity(os.getpid())), "Native lease changed during registration"
os.execvpe(sys.argv[separator + 1], sys.argv[separator + 1:], os.environ)
