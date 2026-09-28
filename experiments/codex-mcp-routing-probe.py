#!/usr/bin/python3
"""Measure where a Codex MCP tool runs for a remote executor thread.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-mcp-routing-probe.py

All Codex state, the test MCP server and both process homes are temporary.
No model call, desktop window or personal profile is used.
"""

import json
import os
import selectors
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path


CODEX = Path("/usr/lib/chatgpt/resources/codex")
TOY_MCP = '''import json, os, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "orbit-routing-probe", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "where", "description": "Report temporary process location",
                             "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        location = {"cwd": os.getcwd(), "home": os.environ.get("HOME"),
                    "marker": os.environ.get("ORBIT_EXEC_MARKER")}
        result = {"content": [{"type": "text", "text": json.dumps(location)}]}
    else:
        continue
    if "id" in request:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
'''


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def private_environment(directory, marker):
    private_home = directory / "home"
    private_home.mkdir()
    (private_home / "codex").mkdir()
    runtime = directory / "runtime"
    runtime.mkdir(mode=0o700)
    return {
        "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
        "HOME": str(private_home), "CODEX_HOME": str(private_home / "codex"),
        "XDG_CONFIG_HOME": str(private_home / "config"),
        "XDG_CACHE_HOME": str(private_home / "cache"),
        "XDG_DATA_HOME": str(private_home / "data"),
        "XDG_STATE_HOME": str(private_home / "state"),
        "XDG_RUNTIME_DIR": str(runtime), "ORBIT_EXEC_MARKER": marker,
        "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost",
    }


def wait_for_listener(port, child):
    for _ in range(100):
        if child.poll() is not None:
            raise RuntimeError(f"exec-server exited with {child.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError("exec-server listener did not start")


def stop_process(child):
    if child is None or child.poll() is not None:
        return
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


class JsonRpc:
    def __init__(self, child):
        self.child = child
        self.fd = child.stdout.fileno()
        os.set_blocking(self.fd, False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.fd, selectors.EVENT_READ)
        self.buffer = bytearray()
        self.messages = []

    def call(self, request_id, method, params):
        request = {"id": request_id, "method": method, "params": params}
        self.child.stdin.write((json.dumps(request) + "\n").encode())
        self.child.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.selector.select(0.2):
                data = os.read(self.fd, 65536)
                if not data:
                    raise RuntimeError("app-server closed stdout")
                self.buffer.extend(data)
                while b"\n" in self.buffer:
                    line, _, remaining = self.buffer.partition(b"\n")
                    self.buffer[:] = remaining
                    if line:
                        self.messages.append(json.loads(line))
            for index, message in enumerate(self.messages):
                if message.get("id") == request_id:
                    response = self.messages.pop(index)
                    if "error" in response:
                        raise RuntimeError(f"{method}: {response['error']}")
                    return response["result"]
        raise TimeoutError(f"{method} did not respond")

    def notify(self, method):
        self.child.stdin.write((json.dumps({"method": method, "params": {}}) + "\n").encode())
        self.child.stdin.flush()


def main():
    if not CODEX.is_file():
        raise RuntimeError(f"Installed Codex binary is missing: {CODEX}")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-mcp-route-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        executor = root / "executor"
        authority.mkdir()
        executor.mkdir()
        mcp_script = root / "toy_mcp.py"
        mcp_script.write_text(TOY_MCP)
        port = unused_port()
        exec_server = app_server = None
        try:
            exec_server = subprocess.Popen(
                [str(CODEX), "exec-server", "--listen", f"ws://127.0.0.1:{port}"],
                cwd=executor, env=private_environment(executor, "EXECUTOR_ONLY"),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
            wait_for_listener(port, exec_server)
            authority_env = private_environment(authority, "AUTHORITY_ONLY")
            config = Path(authority_env["CODEX_HOME"]) / "config.toml"
            config.write_text(
                '[mcp_servers.route_probe]\ncommand = "/usr/bin/python3"\n'
                f'args = ["-u", {json.dumps(str(mcp_script))}]\n'
            )
            app_server = subprocess.Popen(
                [str(CODEX), "app-server", "--listen", "stdio://"],
                cwd=authority, env=authority_env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            rpc = JsonRpc(app_server)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_mcp_route_probe", "title": "Orbit MCP route probe", "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.notify("initialized")
            rpc.call(2, "environment/add", {
                "environmentId": "remote", "execServerUrl": f"ws://127.0.0.1:{port}",
            })
            thread = rpc.call(3, "thread/start", {
                "ephemeral": True,
                "environments": [{"environmentId": "remote", "cwd": str(executor)}],
            })["thread"]
            result = rpc.call(4, "mcpServer/tool/call", {
                "threadId": thread["id"], "server": "route_probe",
                "tool": "where", "arguments": {},
            })
            location = json.loads(result["content"][0]["text"])
            selected = thread["environments"][0]["environmentId"] == "remote"
            mcp_cwd_is_authority = location["cwd"] == str(authority)
            mcp_home_is_authority = location["home"] == authority_env["HOME"]
            mcp_cwd_is_executor = location["cwd"] == str(executor)
            mcp_home_is_executor = location["home"] == str(executor / "home")
            evidence = {
                "remoteEnvironmentSelected": selected,
                "mcpCwdIsAuthority": mcp_cwd_is_authority,
                "mcpHomeIsAuthority": mcp_home_is_authority,
                "mcpCwdIsExecutor": mcp_cwd_is_executor,
                "mcpHomeIsExecutor": mcp_home_is_executor,
                "mcpMarker": location["marker"],
            }
            print(json.dumps(evidence, sort_keys=True))
            assert selected and mcp_cwd_is_authority and mcp_home_is_authority
            assert not mcp_cwd_is_executor and not mcp_home_is_executor
        finally:
            stop_process(app_server)
            stop_process(exec_server)


if __name__ == "__main__":
    main()
