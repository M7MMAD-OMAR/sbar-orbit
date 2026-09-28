#!/usr/bin/python3
"""Test private namespace model egress without forwarding its executor port.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-pasta-egress-probe.py

The remote endpoint is a loopback fixture on this host. No Codex account or
desktop process is started. Pasta is configured to forward no guest TCP or UDP
ports to the host.
"""

import http.server
import json
import os
import signal
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path


MARKER = "orbit_disposable_model_endpoint"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def can_connect(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


CHILD = '''import json, socket, subprocess, sys, time, urllib.request
from pathlib import Path
host_port, private_port, state_file, stop_file = sys.argv[1:]
routes = ""
for _ in range(60):
    routes = subprocess.check_output(["/usr/bin/ip", "-4", "route", "show", "default"], text=True)
    if routes.strip():
        break
    time.sleep(0.05)
words = routes.split()
if "via" not in words:
    addresses = subprocess.check_output(["/usr/bin/ip", "-4", "addr"], text=True)
    raise RuntimeError(f"Private namespace has no mapped host gateway: {routes!r}; addresses={addresses!r}")
gateway = words[words.index("via") + 1]
with urllib.request.urlopen(f"http://{gateway}:{host_port}/", timeout=3) as response:
    body = response.read().decode()
listener = socket.socket()
listener.bind(("127.0.0.1", int(private_port)))
listener.listen(1)
Path(state_file).write_text(json.dumps({"gateway": gateway, "modelReply": body}))
while not Path(stop_file).exists():
    time.sleep(0.05)
listener.close()
'''


def main():
    if not Path("/usr/bin/pasta").is_file():
        raise RuntimeError("pasta is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-pasta-probe-") as temporary:
        root = Path(temporary)
        host_port = free_port()
        private_port = free_port()
        if can_connect(private_port):
            raise RuntimeError("Disposable private port is already reachable on host")

        class ModelFixture(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                data = MARKER.encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", host_port), ModelFixture)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        child_script = root / "child.py"
        child_script.write_text(CHILD)
        state_file = root / "state.json"
        stop_file = root / "stop"
        child = subprocess.Popen(
            ["/usr/bin/pasta", "-q", "-f", "--config-net", "-t", "none", "-u", "none",
             "/usr/bin/python3", str(child_script), str(host_port), str(private_port),
             str(state_file), str(stop_file)],
            cwd=root, env={"PATH": "/usr/bin:/bin", "HOME": str(root),
                           "LANG": "C.UTF-8", "NO_PROXY": "*"},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and not state_file.exists():
                if child.poll() is not None:
                    raise RuntimeError(f"pasta child exited: {child.stderr.read().decode()[-1000:]}")
                time.sleep(0.05)
            if not state_file.exists():
                raise TimeoutError("Private namespace did not reach model fixture")
            state = json.loads(state_file.read_text())
            host_can_reach_executor = can_connect(private_port)
            result = {"modelReplyCorrect": state["modelReply"] == MARKER,
                      "hostCanReachPrivateExecutorPort": host_can_reach_executor,
                      "guestGateway": state["gateway"]}
            print(json.dumps(result, sort_keys=True))
            assert result["modelReplyCorrect"] is True
            assert host_can_reach_executor is False
        finally:
            stop_file.touch()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    main()
