#!/usr/bin/python3
"""Probe client delivery of dynamic tool calls on a shared Codex authority.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-dynamic-tool-routing-probe.py

The authority, mock model and both clients use disposable local state.
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


CODEX = "/usr/lib/chatgpt/resources/codex"


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def response_stream(response_id, item):
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
    def __init__(self, connection, label):
        self.connection = connection
        self.label = label
        self.pending = {}
        self.notifications = []
        self.callbacks = []
        self.next_id = 1
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for line in self.connection:
            message = json.loads(line)
            if "method" in message and "id" in message:
                if message["method"] != "item/tool/call":
                    raise RuntimeError(f"Unexpected server request: {message['method']}")
                self.callbacks.append(message.get("params", {}))
                await self.connection.send(json.dumps({"id": message["id"], "result": {
                    "contentItems": [{"type": "inputText", "text": self.label + "_CALLBACK"}],
                    "success": True,
                }}))
            elif "id" in message and message["id"] in self.pending:
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
        response = await asyncio.wait_for(future, 10)
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response["result"]

    async def notify(self, method):
        await self.connection.send(json.dumps({"method": method, "params": {}}))


async def wait_for_turn(clients, thread_id, turn_number):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        completions = [event for client in clients for event in client.notifications
                       if event.get("method") == "turn/completed"
                       and event.get("params", {}).get("threadId") == thread_id]
        if len(completions) >= turn_number:
            return completions
        await asyncio.sleep(0.05)
    raise TimeoutError("turn/completed was not observed")


async def main():
    if not Path(CODEX).is_file():
        raise RuntimeError("Installed Codex CLI is missing")
    with tempfile.TemporaryDirectory(prefix="orbit-dynamic-route-") as temporary:
        root = Path(temporary)
        for name in ("home", "codex", "config", "data", "cache", "state",
                     "runtime", "project", "socket"):
            (root / name).mkdir(mode=0o700)
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append({
                    "tools": json.dumps(body.get("tools", [])),
                    "input": json.dumps(body.get("input", [])),
                })
                number = len(model_requests)
                if number % 2:
                    item = {"id": f"call_{number}", "type": "function_call",
                            "status": "completed", "call_id": f"callid_{number}",
                            "name": "orbit_private_tool", "arguments": "{}"}
                else:
                    item = {"id": f"message_{number}", "type": "message",
                            "status": "completed", "role": "assistant", "content": [
                                {"type": "output_text", "text": "done", "annotations": []},
                            ]}
                payload = response_stream(f"response_{number}", item)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model_port = unused_port()
        model = http.server.ThreadingHTTPServer(("127.0.0.1", model_port), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        environment = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "HOME": str(root / "home"), "CODEX_HOME": str(root / "codex"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_RUNTIME_DIR": str(root / "runtime"),
            "MOCK_API_KEY": "disposable", "NO_PROXY": "127.0.0.1,localhost",
        }
        (root / "codex" / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model_port}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        socket_path = root / "socket" / "app.sock"
        authority = subprocess.Popen(
            [CODEX, "app-server", "--listen", "unix://" + str(socket_path)],
            cwd=root, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
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
                                        compression=None) as first_socket,
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                        compression=None) as second_socket,
            ):
                first = Client(first_socket, "FIRST")
                second = Client(second_socket, "SECOND")
                initialize = {"clientInfo": {
                    "name": "orbit_dynamic_probe", "title": "Orbit Dynamic Probe",
                    "version": "1",
                }, "capabilities": {"experimentalApi": True}}
                await asyncio.gather(first.call("initialize", initialize),
                                     second.call("initialize", initialize))
                await asyncio.gather(first.notify("initialized"),
                                     second.notify("initialized"))
                dynamic_tools = [{"type": "function", "name": "orbit_private_tool",
                                  "description": "Return the receiving client marker",
                                  "inputSchema": {"type": "object", "properties": {}}}]
                started = await first.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only", "dynamicTools": dynamic_tools,
                })
                thread_id = started["thread"]["id"]
                prompt = {"threadId": thread_id, "input": [
                    {"type": "text", "text": "Call the diagnostic tool."},
                ]}
                await first.call("turn/start", prompt)
                first_completions = await wait_for_turn([first], thread_id, 1)
                first_phase_callbacks = [len(first.callbacks), len(second.callbacks)]
                await second.call("thread/resume", {"threadId": thread_id})
                await second.call("turn/start", prompt)
                second_completions = await wait_for_turn([second], thread_id, 1)
                second_followup = model_requests[3]["input"]
                second_result_owner = (
                    "FIRST" if "FIRST_CALLBACK" in second_followup else
                    "SECOND" if "SECOND_CALLBACK" in second_followup else "UNKNOWN"
                )
                evidence = {
                    "modelRequests": len(model_requests),
                    "toolAdvertised": all("orbit_private_tool" in request["tools"]
                                          for request in model_requests[::2]),
                    "firstClientCallbacks": len(first.callbacks),
                    "secondClientCallbacks": len(second.callbacks),
                    "firstPhaseCallbacks": first_phase_callbacks,
                    "secondCallIdMatches": first.callbacks[1]["callId"] == second.callbacks[0]["callId"],
                    "firstCallbackInModelFollowup": "FIRST_CALLBACK" in model_requests[1]["input"],
                    "secondResultOwner": second_result_owner,
                    "firstTurnStatus": first_completions[-1]["params"]["turn"]["status"],
                    "secondTurnStatus": second_completions[-1]["params"]["turn"]["status"],
                }
                print(json.dumps(evidence, sort_keys=True))
                first.reader.cancel()
                second.reader.cancel()
                await asyncio.gather(first.reader, second.reader, return_exceptions=True)
                assert evidence["modelRequests"] == 4
                assert evidence["toolAdvertised"]
                assert evidence["firstPhaseCallbacks"] == [1, 0]
                assert evidence["firstClientCallbacks"] == 2
                assert evidence["secondClientCallbacks"] == 1
                assert evidence["secondCallIdMatches"]
                assert evidence["firstCallbackInModelFollowup"]
                assert evidence["secondResultOwner"] in ("FIRST", "SECOND")
                assert evidence["firstTurnStatus"] == evidence["secondTurnStatus"] == "completed"
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
