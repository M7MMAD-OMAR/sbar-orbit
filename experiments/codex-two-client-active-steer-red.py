#!/usr/bin/python3
"""Red fixture for a second client steering a turn started by the owner.

Everything runs with a temporary home, a local model, and a disposable socket.
The safe contract rejects the second client's input while the owner turn runs.
"""

import asyncio
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

import websockets


SOURCE_COMMIT = "4607249e430dac1c961df4dc615beae88e33cec8"
CODEX = os.environ.get("ORBIT_CODEX_TEST_BINARY", "/usr/lib/chatgpt/resources/codex")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def model_response(number):
    item = {"id": f"message_{number}", "type": "message", "status": "completed",
            "role": "assistant", "content": [{"type": "output_text", "text": "done",
                                        "annotations": []}]}
    response_id = f"response_{number}"
    response = {"id": response_id, "object": "response", "created_at": int(time.time()),
                "status": "completed", "model": "gpt-5.1", "output": [item],
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}}
    events = [
        {"type": "response.output_item.added", "response_id": response_id,
         "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
        {"type": "response.output_item.done", "response_id": response_id,
         "output_index": 0, "item": item},
        {"type": "response.completed", "response": response},
    ]
    return ("".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                    for event in events) + "data: [DONE]\n\n").encode()


class Client:
    def __init__(self, connection):
        self.connection = connection
        self.next_id = 1
        self.pending = {}
        self.notifications = []
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.connection:
            message = json.loads(raw)
            if "id" in message and message["id"] in self.pending:
                self.pending.pop(message["id"]).set_result(message)
            else:
                self.notifications.append(message)

    async def call(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.connection.send(json.dumps({"id": request_id, "method": method,
                                               "params": params}))
        return await asyncio.wait_for(future, 15)

    async def initialized(self):
        await self.connection.send(json.dumps({"method": "initialized", "params": {}}))


async def main():
    source_root_name = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    if not source_root_name:
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT to the exact-tag source worktree")
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root_name,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Source worktree is not the exact tag: {commit}")
    version = subprocess.run([CODEX, "--version"], text=True,
                             capture_output=True, check=True).stdout.strip()
    if version != "codex-cli 0.155.0-alpha.9.2":
        raise RuntimeError(f"Unexpected CLI version: {version}")

    with tempfile.TemporaryDirectory(prefix="orbit-active-steer-red-") as temporary:
        root = Path(temporary)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)
        request_arrived = threading.Event()
        release_response = threading.Event()
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append(body)
                number = len(model_requests)
                if number == 2:
                    request_arrived.set()
                    if not release_response.wait(20):
                        self.send_error(504)
                        return
                payload = model_response(number)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        port = free_port()
        model = http.server.ThreadingHTTPServer(("127.0.0.1", port), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        environment = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "MOCK_API_KEY": "disposable", "NO_PROXY": "127.0.0.1,localhost",
        }
        (root / "codex" / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{port}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        socket_path = root / "socket" / "app.sock"
        authority = subprocess.Popen(
            [CODEX, "app-server", "--listen", "unix://" + str(socket_path)],
            cwd=root, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            for _ in range(100):
                if socket_path.exists():
                    break
                if authority.poll() is not None:
                    raise RuntimeError("Disposable authority exited")
                await asyncio.sleep(0.05)
            else:
                raise TimeoutError("Disposable authority socket did not open")
            async with (
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                        compression=None) as owner_socket,
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                        compression=None) as other_socket,
            ):
                owner = Client(owner_socket)
                other = Client(other_socket)
                init = {"clientInfo": {"name": "orbit_steer_fixture",
                                       "title": "Orbit steer fixture", "version": "1"},
                        "capabilities": {"experimentalApi": True}}
                for result in await asyncio.gather(owner.call("initialize", init),
                                                   other.call("initialize", init)):
                    if "error" in result:
                        raise RuntimeError(result["error"])
                await asyncio.gather(owner.initialized(), other.initialized())
                started = await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only",
                })
                thread_id = started["result"]["thread"]["id"]
                warmup = await owner.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Save this disposable conversation."}],
                })
                if "error" in warmup:
                    raise RuntimeError(warmup["error"])
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if any(event.get("method") == "turn/completed" and
                           event.get("params", {}).get("threadId") == thread_id
                           for event in owner.notifications):
                        break
                    await asyncio.sleep(0.05)
                else:
                    raise TimeoutError("Warm-up turn did not persist the disposable thread")
                resumed = await other.call("thread/resume", {"threadId": thread_id})
                if "error" in resumed:
                    raise RuntimeError(resumed["error"])
                first = await owner.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Owner turn."}],
                })
                if "error" in first:
                    raise RuntimeError(first["error"])
                if not await asyncio.to_thread(request_arrived.wait, 10):
                    raise TimeoutError("Owner turn did not reach the disposable model")
                second = await other.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "OTHER_STEER_MARKER"}],
                })
                evidence = {
                    "sourceCommit": commit,
                    "cliVersion": version,
                    "ownerTurnId": first.get("result", {}).get("turn", {}).get("id"),
                    "otherTurnId": second.get("result", {}).get("turn", {}).get("id"),
                    "otherRejected": "error" in second,
                    "modelRequestsBeforeRelease": len(model_requests),
                }
                print(json.dumps(evidence, sort_keys=True), flush=True)
                owner.reader.cancel()
                other.reader.cancel()
                await asyncio.gather(owner.reader, other.reader, return_exceptions=True)
                assert evidence["otherRejected"], "Second client steered the owner's active turn"
        finally:
            release_response.set()
            if authority.poll() is None:
                os.killpg(authority.pid, signal.SIGTERM)
                try:
                    authority.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(authority.pid, signal.SIGKILL)
                    authority.wait(timeout=3)
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    asyncio.run(main())
