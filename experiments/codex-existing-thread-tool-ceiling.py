#!/usr/bin/python3
"""Measure whether a per-turn tool ceiling preserves the owner's tools.

Every account, project, socket, request and model response is local and temporary.
The contract requires private turns to have zero tools and owner turns in the
same saved thread to retain their original tools.
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
CODEX = os.environ.get("ORBIT_CODEX_TEST_BINARY")
SERVER_BINARY = os.environ.get("ORBIT_CODEX_APP_SERVER_BINARY")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def response_stream(number):
    response_id = f"response_{number}"
    item = {"id": f"message_{number}", "type": "message", "status": "completed",
            "role": "assistant", "content": [{"type": "output_text", "text": "done",
                                             "annotations": []}]}
    pending = {**item, "status": "in_progress", "content": []}
    events = [
        {"type": "response.output_item.added", "response_id": response_id,
         "output_index": 0, "item": pending},
        {"type": "response.output_item.done", "response_id": response_id,
         "output_index": 0, "item": item},
        {"type": "response.completed", "response": {
            "id": response_id, "object": "response", "created_at": int(time.time()),
            "status": "completed", "model": "gpt-5.1", "output": [item],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}}},
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
            if "method" in message and "id" in message:
                raise RuntimeError(f"Unexpected server request: {message['method']}")
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
        message = await asyncio.wait_for(future, 20)
        if "error" in message:
            raise RuntimeError(f"{method}: {message['error']}")
        return message["result"]

    async def initialize(self):
        await self.call("initialize", {
            "clientInfo": {"name": "orbit_fixture", "title": "Orbit fixture", "version": "1"},
            "capabilities": {"experimentalApi": True},
        })
        await self.connection.send(json.dumps({"method": "initialized", "params": {}}))

    async def turn(self, thread_id, label, allowed_tools=None):
        prior = sum(event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in self.notifications)
        params = {"threadId": thread_id, "input": [{"type": "text", "text": label}]}
        if allowed_tools is not None:
            params["allowedTools"] = allowed_tools
        await self.call("turn/start", params)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            completed = [event for event in self.notifications
                         if event.get("method") == "turn/completed" and
                         event.get("params", {}).get("threadId") == thread_id]
            if len(completed) > prior:
                status = completed[-1].get("params", {}).get("turn", {}).get("status")
                if status != "completed":
                    raise RuntimeError(f"Disposable turn ended with {status}")
                return
            await asyncio.sleep(0.05)
        raise TimeoutError(f"Disposable {label} turn did not complete")

    async def close(self):
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)


def start_authority(binary, root, environment, socket_path):
    command = [binary] + ([] if SERVER_BINARY else ["app-server"])
    authority = subprocess.Popen(
        command + ["--listen", "unix://" + str(socket_path)],
        cwd=root, env=environment, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if socket_path.exists():
            return authority
        if authority.poll() is not None:
            raise RuntimeError("Disposable authority exited")
        time.sleep(0.05)
    raise TimeoutError("Disposable authority socket did not open")


def stop_authority(authority, socket_path):
    if authority and authority.poll() is None:
        os.killpg(authority.pid, signal.SIGTERM)
        try:
            authority.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(authority.pid, signal.SIGKILL)
            authority.wait(timeout=3)
    socket_path.unlink(missing_ok=True)


async def main():
    source_root_name = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    if not source_root_name or not (CODEX or SERVER_BINARY):
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT and a Codex test binary")
    source_root = Path(source_root_name).resolve()
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Source worktree has unexpected base: {commit}")
    executable = SERVER_BINARY or CODEX
    version = subprocess.run([executable, "--version"], text=True,
                             capture_output=True, check=True).stdout.strip()
    expected_version = ("codex-app-server" if SERVER_BINARY else "codex-cli") + " 0.155.0-alpha.9.2"
    if version != expected_version:
        raise RuntimeError(f"Unexpected executable version: {version}")

    with tempfile.TemporaryDirectory(prefix="orbit-existing-tool-ceiling-") as temporary:
        root = Path(temporary)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append(body)
                payload = response_stream(len(model_requests))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", free_port()), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        environment = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "MOCK_API_KEY": "disposable", "NO_PROXY": "127.0.0.1,localhost",
        }
        if os.environ.get("ORBIT_COMBINED_EXPERIMENT") == "1":
            environment["CODEX_APP_SERVER_DYNAMIC_TOOL_OWNER_EXPERIMENT"] = "1"
            environment["CODEX_APP_SERVER_TURN_OWNER_EXPERIMENT"] = "1"
        (root / "codex" / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        socket_path = root / "socket" / "app.sock"
        authority = None
        try:
            authority = start_authority(executable, root, environment, socket_path)
            async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                               compression=None) as owner_socket:
                owner = Client(owner_socket)
                await owner.initialize()
                started = await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only",
                })
                thread_id = started["thread"]["id"]
                await owner.turn(thread_id, "Owner before cold resume")
                await owner.close()
            stop_authority(authority, socket_path)
            authority = start_authority(executable, root, environment, socket_path)
            async with (
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                            compression=None) as private_socket,
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                            compression=None) as owner_socket,
            ):
                private = Client(private_socket)
                owner = Client(owner_socket)
                await asyncio.gather(private.initialize(), owner.initialize())
                await private.call("thread/resume", {"threadId": thread_id})
                await private.turn(thread_id, "Private resumed turn", [])
                await owner.call("thread/resume", {"threadId": thread_id})
                await owner.turn(thread_id, "Owner after private resume")
                control = await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only",
                })
                await owner.turn(control["thread"]["id"], "Separate owner control")
                await asyncio.gather(private.close(), owner.close())
            if len(model_requests) != 4:
                raise RuntimeError(f"Expected four mock model requests, got {len(model_requests)}")
            counts = [len(request.get("tools", [])) for request in model_requests]
            inventories = [sorted(tool.get("name", "<unnamed>")
                                  for tool in request.get("tools", []))
                           for request in model_requests]
            evidence = {
                "sourceCommit": commit,
                "cliVersion": version,
                "ownerBeforeTools": counts[0],
                "ownerBeforeInventory": inventories[0],
                "privateExistingTools": counts[1],
                "privateExistingInventory": inventories[1],
                "ownerAfterPrivateTools": counts[2],
                "ownerAfterPrivateInventory": inventories[2],
                "ownerSeparateControlTools": counts[3],
                "ownerSeparateControlInventory": inventories[3],
            }
            print(json.dumps(evidence, sort_keys=True), flush=True)
            assert counts[0] > 0, "Owner baseline advertised no tools"
            assert counts[1] == 0, "Private existing turn advertised tools"
            assert counts[2] > 0, "Private ceiling removed the original owner's tools"
            assert counts[3] > 0, "Separate owner control advertised no tools"
            assert inventories[0] == inventories[2], "Owner's saved thread tool inventory changed"
        finally:
            stop_authority(authority, socket_path)
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    asyncio.run(main())
