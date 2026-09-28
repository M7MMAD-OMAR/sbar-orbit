"""Test a Codex executor route inside a disposable private network namespace.

Run through Orbit's shared budget:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex_private_net_route_probe.py

The real app-server and exec-server use only temporary homes. A loopback mock
model returns one shell tool call. No Desktop app or original profile is used.
"""

import importlib.util
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


HERE = Path(__file__).resolve().parent
ROUTE_PROBE = HERE / "codex-exec-routing-probe.py"


def import_route_probe():
    spec = importlib.util.spec_from_file_location("codex_exec_routing_probe", ROUTE_PROBE)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the disposable Codex routing probe")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_for_file(path, child, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        if child.poll() is not None:
            raise RuntimeError(f"Private namespace process exited with {child.returncode}")
        time.sleep(0.05)
    raise TimeoutError(f"Private namespace did not create {path.name}")


def open_host_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def namespace_listener_held_by(pid, port):
    suffix = f":{port:04X}"
    rows = Path(f"/proc/{pid}/net/tcp").read_text().splitlines()[1:]
    inodes = {
        columns[9] for row in rows if (columns := row.split())[1].endswith(suffix)
        and columns[3] == "0A"
    }
    if not inodes:
        return False
    return any(
        os.readlink(fd) in {f"socket:[{inode}]" for inode in inodes}
        for fd in Path(f"/proc/{pid}/fd").iterdir()
    )


def inner(root, port):
    subprocess.run(["/usr/sbin/ip", "link", "set", "lo", "up"], check=True)
    probe = import_route_probe()
    original_free_port = probe.free_port
    original_wait = probe.wait_for_listener
    calls = 0

    def chosen_port():
        nonlocal calls
        calls += 1
        if calls == 2:
            return port
        candidate = original_free_port()
        while candidate == port:
            candidate = original_free_port()
        return candidate

    def gated_wait(selected_port, server):
        original_wait(selected_port, server)
        (root / "ready.json").write_text(json.dumps({
            "port": selected_port,
            "execServerPid": server.pid,
            "namespace": os.readlink("/proc/self/ns/net"),
        }))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if (root / "continue").exists():
                return
            if server.poll() is not None:
                raise RuntimeError("Private exec-server exited before host boundary check")
            time.sleep(0.05)
        raise TimeoutError("Host boundary check did not complete")

    probe.free_port = chosen_port
    probe.wait_for_listener = gated_wait
    probe.main()


def outer():
    if not shutil.which("unshare") or not ROUTE_PROBE.is_file():
        raise RuntimeError("Namespace or routing probe is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-private-net-") as temporary:
        root = Path(temporary)
        port = open_host_port()
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        child = subprocess.Popen(
            ["unshare", "--user", "--map-root-user", "--net", sys.executable,
             str(Path(__file__).resolve()), "--inner", str(root), str(port)],
            cwd=HERE.parent, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        )
        try:
            wait_for_file(root / "ready.json", child)
            ready = json.loads((root / "ready.json").read_text())
            executor_pid = ready["execServerPid"]
            host_namespace = os.readlink("/proc/self/ns/net")
            executor_namespace = os.readlink(f"/proc/{executor_pid}/ns/net")
            if executor_namespace == host_namespace or executor_namespace != ready["namespace"]:
                raise AssertionError("Exec-server was not in the private network namespace")
            if not namespace_listener_held_by(executor_pid, port):
                raise AssertionError("Private listener was not owned by the exec-server")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    raise AssertionError("A host process reached the private exec-server port")
            except (ConnectionRefusedError, TimeoutError, OSError):
                pass
            (root / "continue").write_text("ok")
            stdout, stderr = child.communicate(timeout=30)
            if child.returncode != 0:
                raise RuntimeError(f"Private route failed: {stderr.decode(errors='replace')}")
            lines = [line for line in stdout.decode().splitlines() if line.startswith("{")]
            if not lines:
                raise RuntimeError("Private route returned no result")
            routed = json.loads(lines[-1])
            if routed.get("result") != "pass" or routed.get("modelRequests") != 2 or \
                    not routed.get("followupSawExecutorOnly"):
                raise AssertionError(f"Private route did not pass: {routed}")
            print(json.dumps({
                "appServerAndExecutorSharedPrivateNetwork": True,
                "hostSiblingCouldNotReachExecutor": True,
                "executorListenerOwnedByChild": True,
                "modelDrivenShellRouted": True,
                "originalProfileUsed": False,
                "desktopAppUsed": False,
            }, sort_keys=True))
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.communicate(timeout=3)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--inner":
        inner(Path(sys.argv[2]), int(sys.argv[3]))
    else:
        outer()
