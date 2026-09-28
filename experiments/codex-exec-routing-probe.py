#!/usr/bin/python3
"""Probe Codex app-server shell routing with only disposable local fixtures.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-exec-routing-probe.py

The mock model returns one exec_command call. A marker present only in the
executor process environment distinguishes it from the app-server process.
"""

import http.server
import json
import os
import selectors
import signal
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path


CODEX = Path("/usr/lib/chatgpt/resources/codex")
EXECUTOR_MARKER = "orbit_disposable_executor"
HOST_MARKER = "orbit_disposable_host"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def private_environment(directory, marker):
    home = directory / "home"
    home.mkdir()
    (home / "codex").mkdir()
    environment = dict(
        os.environ,
        HOME=str(home),
        CODEX_HOME=str(home / "codex"),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_CACHE_HOME=str(home / ".cache"),
        XDG_DATA_HOME=str(home / ".local/share"),
        MOCK_API_KEY="disposable-key",
        ORBIT_EXEC_MARKER=marker,
    )
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        environment[key] = "http://127.0.0.1:9"
    environment["NO_PROXY"] = "127.0.0.1,localhost"
    return environment


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

    def pump(self, timeout=0.2):
        if not self.selector.select(timeout):
            return
        data = os.read(self.fd, 65536)
        if not data:
            raise RuntimeError("app-server closed stdout")
        self.buffer.extend(data)
        while b"\n" in self.buffer:
            line, _, remaining = self.buffer.partition(b"\n")
            self.buffer[:] = remaining
            if line:
                self.messages.append(json.loads(line))

    def send(self, method, params=None, request_id=None):
        message = {"method": method}
        if params is not None:
            message["params"] = params
        if request_id is not None:
            message["id"] = request_id
        self.child.stdin.write((json.dumps(message) + "\n").encode())
        self.child.stdin.flush()

    def call(self, request_id, method, params):
        self.send(method, params, request_id)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.pump()
            for index, message in enumerate(self.messages):
                if message.get("id") == request_id:
                    result = self.messages.pop(index)
                    if "error" in result:
                        raise RuntimeError(f"{method}: {result['error']}")
                    return result["result"]
        raise TimeoutError(f"{method} response timed out")

    def wait_for_turn(self, thread_id):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            self.pump()
            if any(
                message.get("method") == "turn/completed"
                and message.get("params", {}).get("threadId") == thread_id
                for message in self.messages
            ):
                return
        raise TimeoutError("turn/completed was not received")


def main():
    if not CODEX.is_file():
        raise RuntimeError(f"Codex binary is missing: {CODEX}")

    with tempfile.TemporaryDirectory(prefix="orbit-codex-route-") as root:
        base = Path(root)
        executor_dir = base / "executor"
        host_dir = base / "host"
        executor_dir.mkdir()
        host_dir.mkdir()
        requests = []
        model_port = free_port()

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                input_text = json.dumps(body.get("input", []))
                requests.append(
                    {
                        "path": self.path,
                        "executor_seen": EXECUTOR_MARKER in input_text,
                        "host_seen": HOST_MARKER in input_text,
                    }
                )
                number = len(requests)
                response_id = f"resp_disposable_{number}"
                events = []
                if number == 1:
                    arguments = json.dumps(
                        {
                            "cmd": 'printf %s "$ORBIT_EXEC_MARKER"',
                            "workdir": str(executor_dir),
                            "yield_time_ms": 1000,
                        }
                    )
                    item = {
                        "id": "fc_disposable",
                        "type": "function_call",
                        "status": "completed",
                        "call_id": "call_disposable",
                        "name": "exec_command",
                        "arguments": arguments,
                    }
                    events.extend(
                        [
                            {
                                "type": "response.output_item.added",
                                "response_id": response_id,
                                "output_index": 0,
                                "item": {**item, "arguments": "", "status": "in_progress"},
                            },
                            {
                                "type": "response.function_call_arguments.delta",
                                "response_id": response_id,
                                "item_id": item["id"],
                                "output_index": 0,
                                "delta": arguments,
                            },
                            {
                                "type": "response.function_call_arguments.done",
                                "response_id": response_id,
                                "item_id": item["id"],
                                "output_index": 0,
                                "arguments": arguments,
                            },
                            {
                                "type": "response.output_item.done",
                                "response_id": response_id,
                                "output_index": 0,
                                "item": item,
                            },
                        ]
                    )
                else:
                    item = {
                        "id": "msg_disposable",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": "done", "annotations": []}
                        ],
                    }
                    events.extend(
                        [
                            {
                                "type": "response.output_item.added",
                                "response_id": response_id,
                                "output_index": 0,
                                "item": {**item, "content": [], "status": "in_progress"},
                            },
                            {
                                "type": "response.output_item.done",
                                "response_id": response_id,
                                "output_index": 0,
                                "item": item,
                            },
                        ]
                    )
                events.append(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": response_id,
                            "object": "response",
                            "created_at": int(time.time()),
                            "status": "completed",
                            "model": body.get("model", "gpt-5.1"),
                            "output": [item],
                            "usage": {
                                "input_tokens": 1,
                                "output_tokens": 2,
                                "total_tokens": 3,
                            },
                        },
                    }
                )
                payload = (
                    "".join(
                        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                        for event in events
                    )
                    + "data: [DONE]\n\n"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", model_port), MockModel)
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        exec_server = None
        app_server = None
        try:
            executor_port = free_port()
            exec_server = subprocess.Popen(
                [str(CODEX), "exec-server", "--listen", f"ws://127.0.0.1:{executor_port}"],
                cwd=executor_dir,
                env=private_environment(executor_dir, EXECUTOR_MARKER),
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            wait_for_listener(executor_port, exec_server)
            app_env = private_environment(host_dir, HOST_MARKER)
            (Path(app_env["CODEX_HOME"]) / "config.toml").write_text(
                'model = "gpt-5.1"\n'
                'model_provider = "mock"\n'
                'web_search = "disabled"\n'
                '[model_providers.mock]\n'
                'name = "Local Mock"\n'
                f'base_url = "http://127.0.0.1:{model_port}/v1"\n'
                'env_key = "MOCK_API_KEY"\n'
                'wire_api = "responses"\n'
                'supports_websockets = false\n'
            )
            app_server = subprocess.Popen(
                [str(CODEX), "app-server", "--listen", "stdio://"],
                cwd=host_dir,
                env=app_env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
                start_new_session=True,
            )
            rpc = JsonRpc(app_server)
            rpc.call(
                1,
                "initialize",
                {
                    "clientInfo": {
                        "name": "orbit_route_probe",
                        "title": "Orbit route probe",
                        "version": "0.0.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
            )
            rpc.send("initialized")
            rpc.call(
                2,
                "environment/add",
                {
                    "environmentId": "disposable",
                    "execServerUrl": f"ws://127.0.0.1:{executor_port}",
                },
            )
            started = rpc.call(
                3,
                "thread/start",
                {
                    "ephemeral": True,
                    "model": "gpt-5.1",
                    "modelProvider": "mock",
                    "environments": [
                        {"environmentId": "disposable", "cwd": str(executor_dir)}
                    ],
                    "cwd": str(executor_dir),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                },
            )
            thread_id = started["thread"]["id"]
            rpc.call(
                4,
                "turn/start",
                {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Run a diagnostic marker command."}],
                },
            )
            rpc.wait_for_turn(thread_id)
            thread_events = [
                message
                for message in rpc.messages
                if message.get("params", {}).get("threadId") == thread_id
            ]
            completed = next(
                message["params"]["turn"]
                for message in thread_events
                if message.get("method") == "turn/completed"
            )
            commands = [
                message["params"]["item"]
                for message in thread_events
                if message.get("method") == "item/completed"
                and message.get("params", {}).get("item", {}).get("type")
                == "commandExecution"
            ]
            assert completed["status"] == "completed", completed
            assert len(commands) == 1, commands
            assert commands[0]["status"] == "completed", commands[0]
            assert commands[0]["exitCode"] == 0, commands[0]
            assert commands[0]["aggregatedOutput"] == EXECUTOR_MARKER, commands[0]
            assert len(requests) == 2, requests
            assert requests[0]["path"] == requests[1]["path"] == "/v1/responses"
            assert requests[1]["executor_seen"] is True, requests
            assert requests[1]["host_seen"] is False, requests
            print(
                json.dumps(
                    {
                        "result": "pass",
                        "commandOutput": commands[0]["aggregatedOutput"],
                        "modelRequests": len(requests),
                        "followupSawExecutorOnly": True,
                    }
                )
            )
        finally:
            stop_process(app_server)
            stop_process(exec_server)
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    main()
