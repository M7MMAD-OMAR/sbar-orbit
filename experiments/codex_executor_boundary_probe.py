"""Measure whether a disposable Codex exec-server listener is private to its owner.

Run through the shared Orbit budget:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex_executor_boundary_probe.py

This probe creates an empty temporary Codex home, starts no desktop app, and
does not read the user's Codex profile. It expects a second process to reach
the WebSocket listener because both processes share the host network namespace.
"""

import base64
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time


CODEX = Path(os.environ.get("ORBIT_CODEX_BIN") or shutil.which("codex") or "/missing/codex")


def unused_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def listener_held_by(pid, port):
    suffix = f":{port:04X}"
    listening = set()
    for row in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        columns = row.split()
        if columns[1].endswith(suffix) and columns[3] == "0A":
            listening.add(columns[9])
    if not listening:
        return False
    try:
        descriptors = Path(f"/proc/{pid}/fd").iterdir()
        return any(os.readlink(fd) in {f"socket:[{inode}]" for inode in listening}
                   for fd in descriptors)
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return False


def websocket_status(port):
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = ("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
               f"Sec-WebSocket-Key: {key}\r\n\r\n")
    with socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
        connection.sendall(request.encode("ascii"))
        return connection.recv(512).split(b"\r\n", 1)[0].decode("ascii", errors="replace")


def main():
    if not CODEX.is_file():
        raise RuntimeError("Codex CLI is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-executor-boundary-") as temporary:
        root = Path(temporary)
        home = root / "home"
        codex_home = home / ".codex"
        codex_home.mkdir(parents=True)
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        port = unused_loopback_port()
        environment = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(home),
            "CODEX_HOME": str(codex_home), "XDG_RUNTIME_DIR": str(runtime),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_STATE_HOME": str(home / ".local/state"),
        }
        with open(root / "stdout", "wb") as stdout, open(root / "stderr", "wb") as stderr:
            server = subprocess.Popen(
                [str(CODEX), "exec-server", "--listen", f"ws://127.0.0.1:{port}"],
                cwd=home, env=environment, stdin=subprocess.PIPE, stdout=stdout,
                stderr=stderr, start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError("Disposable exec-server exited before opening its listener")
                    if listener_held_by(server.pid, port):
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Disposable exec-server listener was not observed")

                # This client is a distinct process with no inherited socket or server handle.
                client = subprocess.run(
                    [sys.executable, "-c", "import sys; from pathlib import Path; "
                     "sys.path.insert(0, str(Path(sys.argv[1]).parent)); "
                     "from codex_executor_boundary_probe import websocket_status; "
                     "print(websocket_status(int(sys.argv[2])))",
                     str(Path(__file__).resolve()), str(port)],
                    cwd=root, env=environment, capture_output=True, text=True, timeout=4,
                )
                if client.returncode != 0:
                    raise RuntimeError("Sibling process could not reach the listener")
                status = client.stdout.strip()
                if not status.startswith("HTTP/1.1 101"):
                    raise RuntimeError(f"Unexpected WebSocket handshake: {status}")
                print(json.dumps({
                    "listener_owned_by_disposable_server": True,
                    "sibling_process_websocket_status": status,
                    "host_display_variables_passed": False,
                    "original_codex_profile_path_passed": False,
                }))
            finally:
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGTERM)
                try:
                    server.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, signal.SIGKILL)
                    server.communicate(timeout=3)


if __name__ == "__main__":
    main()
