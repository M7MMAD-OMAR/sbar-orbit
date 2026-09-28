#!/usr/bin/python3
"""Red fixture: one saved thread, two clients, one side effecting tool request.

The safe contract is that only the client starting a turn receives its tool call.
All homes, sockets, credentials, and model responses are temporary local fixtures.
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


def response_stream(number, item):
    response_id = f"response_{number}"
    pending = {**item, "status": "in_progress"}
    if item["type"] == "function_call":
        pending["arguments"] = ""
    else:
        pending["content"] = []
    events = [{"type": "response.output_item.added", "response_id": response_id,
               "output_index": 0, "item": pending}]
    if item["type"] == "function_call":
        events.extend([
            {"type": "response.function_call_arguments.delta", "response_id": response_id,
             "item_id": item["id"], "output_index": 0, "delta": item["arguments"]},
            {"type": "response.function_call_arguments.done", "response_id": response_id,
             "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]},
        ])
    events.extend([
        {"type": "response.output_item.done", "response_id": response_id,
         "output_index": 0, "item": item},
        {"type": "response.completed", "response": {
            "id": response_id, "object": "response", "created_at": int(time.time()),
            "status": "completed", "model": "gpt-5.1", "output": [item],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        }},
    ])
    return ("".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                    for event in events) + "data: [DONE]\n\n").encode()


class Client:
    def __init__(self, socket_connection, label, other_reply_sent, model_followup_seen):
        self.socket_connection = socket_connection
        self.label = label
        self.other_reply_sent = other_reply_sent
        self.model_followup_seen = model_followup_seen
        self.next_id = 1
        self.pending = {}
        self.notifications = []
        self.tool_calls = []
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.socket_connection:
            message = json.loads(raw)
            if "method" in message and "id" in message:
                if message["method"] != "item/tool/call":
                    raise RuntimeError(f"Unexpected server request: {message['method']}")
                self.tool_calls.append(message["params"])
                if self.label == "OWNER":
                    try:
                        await asyncio.wait_for(self.other_reply_sent.wait(), 0.75)
                    except asyncio.TimeoutError:
                        pass
                    if self.other_reply_sent.is_set():
                        try:
                            await asyncio.wait_for(self.model_followup_seen.wait(), 5)
                        except asyncio.TimeoutError:
                            pass
                await self.socket_connection.send(json.dumps({"id": message["id"], "result": {
                    "contentItems": [{"type": "inputText", "text": self.label + "_CALLBACK"}],
                    "success": True,
                }}))
                if self.label == "OTHER":
                    self.other_reply_sent.set()
            elif "id" in message and message["id"] in self.pending:
                self.pending.pop(message["id"]).set_result(message)
            else:
                self.notifications.append(message)

    async def call(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.socket_connection.send(json.dumps({"id": request_id, "method": method,
                                                     "params": params}))
        message = await asyncio.wait_for(future, 20)
        if "error" in message:
            raise RuntimeError(f"{method}: {message['error']}")
        return message["result"]

    async def initialized(self):
        await self.socket_connection.send(json.dumps({"method": "initialized", "params": {}}))


async def main():
    source_root_name = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    if not source_root_name:
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT to the exact-tag Codex source worktree")
    source_root = Path(source_root_name).resolve()
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Source worktree is not the exact tag: {commit}")
    version = subprocess.run([CODEX, "--version"], text=True,
                             capture_output=True, check=True).stdout.strip()
    if version != "codex-cli 0.155.0-alpha.9.2":
        raise RuntimeError(f"Test executable has a different version: {version}")
    with tempfile.TemporaryDirectory(prefix="orbit-red-two-client-") as temporary:
        root = Path(temporary)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)
        model_requests = []
        loop = asyncio.get_running_loop()
        other_reply_sent = asyncio.Event()
        model_followup_seen = asyncio.Event()

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append(body)
                number = len(model_requests)
                if number > 2:
                    loop.call_soon_threadsafe(model_followup_seen.set)
                item = ({"id": "call_2", "type": "function_call", "status": "completed",
                         "call_id": "callid_2", "name": "orbit_private_tool", "arguments": "{}"}
                        if number == 2 else
                        {"id": f"message_{number}", "type": "message", "status": "completed",
                         "role": "assistant", "content": [{"type": "output_text", "text": "done",
                                                          "annotations": []}]})
                payload = response_stream(number, item)
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
                owner = Client(owner_socket, "OWNER", other_reply_sent, model_followup_seen)
                other = Client(other_socket, "OTHER", other_reply_sent, model_followup_seen)
                init = {"clientInfo": {"name": "orbit_red_fixture", "title": "Orbit red fixture",
                                       "version": "1"}, "capabilities": {"experimentalApi": True}}
                await asyncio.gather(owner.call("initialize", init), other.call("initialize", init))
                await asyncio.gather(owner.initialized(), other.initialized())
                tools = [{"type": "function", "name": "orbit_private_tool",
                          "description": "Return the receiving client marker",
                          "inputSchema": {"type": "object", "properties": {}}}]
                started = await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1", "modelProvider": "mock",
                    "approvalPolicy": "never", "sandbox": "read-only", "dynamicTools": tools,
                })
                thread_id = started["thread"]["id"]
                async def wait_for_completed_turns(count):
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        completed = [event for event in owner.notifications
                                     if event.get("method") == "turn/completed" and
                                     event.get("params", {}).get("threadId") == thread_id]
                        if len(completed) >= count:
                            return
                        await asyncio.sleep(0.05)
                    raise TimeoutError(f"Only {len(completed)} disposable turns completed")

                await owner.call("turn/start", {"threadId": thread_id,
                                                "input": [{"type": "text", "text": "Warm up."}]})
                await wait_for_completed_turns(1)
                await other.call("thread/resume", {"threadId": thread_id})
                await owner.call("turn/start", {"threadId": thread_id,
                                                "input": [{"type": "text", "text": "Call the tool."}]})
                await wait_for_completed_turns(2)
                followup = json.dumps(model_requests[-1].get("input", []))
                evidence = {"sourceCommit": commit, "cliVersion": version,
                            "ownerToolCalls": len(owner.tool_calls),
                            "otherToolCalls": len(other.tool_calls),
                            "sameCallId": bool(owner.tool_calls and other.tool_calls and
                                               owner.tool_calls[0]["callId"] ==
                                               other.tool_calls[0]["callId"]),
                            "modelSawOwnerResult": "OWNER_CALLBACK" in followup,
                            "modelSawOtherResult": "OTHER_CALLBACK" in followup,
                            "completed": True}
                print(json.dumps(evidence, sort_keys=True), flush=True)
                owner.reader.cancel()
                other.reader.cancel()
                await asyncio.gather(owner.reader, other.reader, return_exceptions=True)
                assert evidence["ownerToolCalls"] == 1, "Turn owner did not get its tool request"
                assert not evidence["modelSawOtherResult"], "Model accepted a nonowner tool result"
                assert evidence["otherToolCalls"] == 0, "Nonowner got a side effecting tool request"
                assert evidence["modelSawOwnerResult"], "Model missed the turn owner result"
        finally:
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
