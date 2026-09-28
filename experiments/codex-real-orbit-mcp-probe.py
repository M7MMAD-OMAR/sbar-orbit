#!/usr/bin/python3
"""Prove a mock-model Codex tool call changes a real private Orbit browser.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-real-orbit-mcp-probe.py

The Codex home, broker, browser profile, and web page are disposable fixtures.
No installed desktop application or personal browser profile is opened.
"""

import asyncio
import http.client
import http.server
import json
import runpy
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import websockets


PROJECT = Path(__file__).resolve().parents[1]
SHELL = runpy.run_path(str(Path(__file__).with_name("codex-exec-routing-probe.py")))
DYNAMIC = runpy.run_path(str(Path(__file__).with_name("codex-dynamic-tool-routing-probe.py")))
CODEX = SHELL["CODEX"]
JsonRpc = SHELL["JsonRpc"]
private_environment = SHELL["private_environment"]
stop_process = SHELL["stop_process"]
response_stream = DYNAMIC["response_stream"]
SESSION_MCP = PROJECT / "src" / "session-mcp.ts"
BROKER_FIXTURE = PROJECT / "experiments" / "codex-real-broker-fixture.ts"


class UnixHttpConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost", timeout=30)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def broker_call(socket_path, method, params=None):
    connection = UnixHttpConnection(socket_path)
    try:
        connection.request("POST", "/rpc", json.dumps({
            "method": method, "params": params or {},
        }), {"Content-Type": "application/json"})
        response = connection.getresponse()
        body = json.loads(response.read())
        if response.status != 200 or not body.get("ok"):
            raise RuntimeError(f"{method}: {body}")
        return body["result"]
    finally:
        connection.close()


def wait_for_broker(socket_path, child, log_path):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f"broker exited: {log_path.read_text()}")
        if socket_path.exists():
            try:
                broker_call(str(socket_path), "session.list")
                return
            except OSError:
                pass
        time.sleep(0.1)
    raise TimeoutError(f"broker did not start: {log_path.read_text()}")


def wait_for_turn(rpc, thread_id):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        rpc.pump()
        for message in rpc.messages:
            if message.get("method") == "turn/completed" and message.get(
                "params", {}).get("threadId") == thread_id:
                return message["params"]["turn"]
    raise TimeoutError("Codex turn did not complete")


async def shared_request(connection, request_id, method, params, events):
    await connection.send(json.dumps({"id": request_id, "method": method,
                                      "params": params}))
    while True:
        message = json.loads(await asyncio.wait_for(connection.recv(), timeout=10))
        if message.get("id") == request_id:
            return message
        if isinstance(message.get("method"), str):
            events.append(message)


async def shared_authority_turn(app, socket_path, authority, bun, broker_socket,
                                session_id, root):
    deadline = time.monotonic() + 15
    while not socket_path.exists() and time.monotonic() < deadline:
        if app.poll() is not None:
            raise RuntimeError("Disposable Codex authority exited before opening its socket")
        await asyncio.sleep(0.05)
    if not socket_path.exists():
        raise TimeoutError("Disposable Codex authority did not open its socket")
    async with (
        websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                compression=None) as first,
        websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                compression=None) as second,
    ):
        first_events = []
        second_events = []
        initialized = {"clientInfo": {"name": "orbit-shared-browser-probe",
                     "title": "Orbit Shared Browser Probe", "version": "1"},
                     "capabilities": {"experimentalApi": True}}
        first_init, second_init = await asyncio.gather(
            shared_request(first, 1, "initialize", initialized, first_events),
            shared_request(second, 1, "initialize", initialized, second_events),
        )
        if "result" not in first_init or "result" not in second_init:
            raise RuntimeError(f"Disposable clients did not initialize: {first_init}, {second_init}")
        await first.send(json.dumps({"method": "initialized"}))
        await second.send(json.dumps({"method": "initialized"}))
        started = await shared_request(first, 2, "thread/start", {
            "ephemeral": False, "model": "gpt-5.1", "modelProvider": "mock",
            "cwd": str(authority), "approvalPolicy": "never",
            "sandbox": "danger-full-access", "config": {"mcp_servers": {
                "orbit_private": {"command": bun, "args": [str(SESSION_MCP)],
                                  "env": {"ORBIT_SOCKET": str(broker_socket),
                                          "ORBIT_SESSION_ID": session_id,
                                          "ORBIT_USAGE_DIR": str(root / "usage")}},
            }},
        }, first_events)
        thread_id = started.get("result", {}).get("thread", {}).get("id")
        if not isinstance(thread_id, str):
            raise RuntimeError(f"Disposable thread did not start: {started}")
        initial_read = await shared_request(second, 2, "thread/read", {
            "threadId": thread_id, "includeTurns": False,
        }, second_events)
        if initial_read.get("result", {}).get("thread", {}).get("id") != thread_id:
            raise RuntimeError(f"Second client could not read thread: {initial_read}")
        turn_start = await shared_request(first, 3, "turn/start", {
            "threadId": thread_id, "input": [{"type": "text",
            "text": "Click the private fixture button."}],
        }, first_events)
        if "result" not in turn_start:
            raise RuntimeError(f"Turn did not start: {turn_start}")
        completed = None
        while completed is None:
            event = json.loads(await asyncio.wait_for(first.recv(), timeout=60))
            if isinstance(event.get("method"), str):
                first_events.append(event)
                if event["method"] == "turn/completed" and event.get(
                        "params", {}).get("threadId") == thread_id:
                    completed = event["params"]["turn"]
        final_read = await shared_request(second, 3, "thread/read", {
            "threadId": thread_id, "includeTurns": False,
        }, second_events)
        thread = final_read.get("result", {}).get("thread", {})
        turns_page = await shared_request(second, 4, "thread/turns/list", {
            "threadId": thread_id, "limit": 10,
        }, second_events)
        turns = turns_page.get("result", {}).get("data", [])
        completed_turn_read = any(turn.get("id") == completed.get("id") and
                                  turn.get("status") == "completed" for turn in turns)
        idle_seen = any(event.get("method") == "thread/status/changed" and
                        event.get("params", {}).get("threadId") == thread_id and
                        event.get("params", {}).get("status", {}).get("type") ==
                        "idle" for event in second_events)
        await second.close()
        async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                           compression=None) as reopened:
            reopened_events = []
            reconnect_init = await shared_request(reopened, 1, "initialize",
                                                  initialized, reopened_events)
            await reopened.send(json.dumps({"method": "initialized"}))
            reconnect_read = await shared_request(reopened, 2, "thread/read", {
                "threadId": thread_id, "includeTurns": False,
            }, reopened_events)
            reconnect_turns = await shared_request(reopened, 3,
                                                  "thread/turns/list", {
                "threadId": thread_id, "limit": 10,
            }, reopened_events)
            reconnect_saw_thread = reconnect_read.get("result", {}).get(
                "thread", {}).get("id") == thread_id
            reconnect_saw_completed = any(turn.get("id") == completed.get("id")
                and turn.get("status") == "completed" for turn in
                reconnect_turns.get("result", {}).get("data", []))
        tool_events = [event.get("params", {}).get("item") for event in first_events
            if isinstance(event, dict) and event.get("method") == "item/completed"
            and event.get("params", {}).get("threadId") == thread_id
            and event.get("params", {}).get("item", {}).get("type") == "mcpToolCall"]
        return {"threadId": thread_id, "completed": completed,
                "toolEvents": tool_events, "shared": {
                    "twoClientsInitialized": True,
                    "sameCodexHome": first_init["result"].get("codexHome") ==
                                     second_init["result"].get("codexHome"),
                    "secondClientReadThread": thread.get("id") == thread_id,
                    "secondClientSawStartNotification": any(event.get("method") ==
                        "thread/started" for event in second_events),
                    "secondClientSawIdleStatus": idle_seen,
                    "secondClientReadCompletedTurn": completed_turn_read,
                    "reconnectedClientReadSameThread": reconnect_saw_thread,
                    "reconnectedClientReadCompletedTurn": reconnect_saw_completed,
                    "reconnectedClientUsedSameHome": reconnect_init.get("result", {}).get(
                        "codexHome") == first_init["result"].get("codexHome"),
                }}


def main(shared_clients=False):
    bun = shutil.which("bun")
    if not bun or not CODEX.is_file() or not SESSION_MCP.is_file():
        raise RuntimeError("Bun, installed Codex, or the session adapter is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-real-mcp-", dir="/var/tmp") as temporary:
        root = Path(temporary)
        broker_dir = root / "broker"
        authority = root / "authority"
        broker_dir.mkdir()
        authority.mkdir()
        broker_socket = root / "broker.sock"
        broker_log_path = root / "broker.log"
        clicks = []
        fixture_requests = []
        model_requests = []

        class Fixture(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                fixture_requests.append({"method": "GET", "path": self.path})
                page = ("<html><body><button id='increment' onclick=\"fetch('/clicked', "
                        "{method:'POST'}).then(r=>r.text()).then(t=>document.querySelector("
                        "'#state').textContent=t)\">Increment</button>"
                        "<p id='state'>0</p></body></html>")
                payload = page.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                fixture_requests.append({"method": "POST", "path": self.path})
                if urlsplit(self.path).path != "/clicked":
                    self.send_error(404)
                    return
                clicks.append(time.monotonic())
                payload = str(len(clicks)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        fixture_worker = threading.Thread(target=fixture.serve_forever, daemon=True)
        fixture_worker.start()
        origin = f"http://127.0.0.1:{fixture.server_port}"

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append(body)
                if len(model_requests) == 1:
                    item = {"id": "fixture_tool", "type": "function_call",
                            "status": "completed", "call_id": "fixture_call",
                            "namespace": "mcp__orbit_private", "name": "orbit_act",
                            "arguments": json.dumps({
                                "requestId": "fixture-click",
                                "action": {"type": "click", "selector": "#increment"},
                            })}
                else:
                    item = {"id": "fixture_answer", "type": "message",
                            "status": "completed", "role": "assistant", "content": [
                                {"type": "output_text", "text": "done", "annotations": []}]}
                payload = response_stream(f"fixture_response_{len(model_requests)}", item)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        model_worker = threading.Thread(target=model.serve_forever, daemon=True)
        model_worker.start()
        broker = None
        app = None
        session_id = None
        try:
            broker_env = private_environment(broker_dir, "BROKER_ONLY")
            with broker_log_path.open("wb") as broker_log:
                broker = subprocess.Popen([bun, str(BROKER_FIXTURE),
                    str(broker_socket), str(root / "accounts")], cwd=broker_dir,
                    env=broker_env, stdin=subprocess.PIPE, stdout=broker_log,
                    stderr=subprocess.STDOUT, start_new_session=True)
                wait_for_broker(broker_socket, broker, broker_log_path)
                created = broker_call(str(broker_socket), "session.create", {
                    "backend": "browser", "taskName": "Disposable Codex MCP fixture",
                    "policy": {"mode": "autonomous", "origins": [origin],
                               "allow": ["read", "navigate", "write"]},
                })
                session_id = created["sessionId"]
                broker_call(str(broker_socket), "session.act", {
                    "sessionId": session_id, "requestId": "setup-navigate",
                    "action": {"type": "navigate", "url": origin},
                })
                before = broker_call(str(broker_socket), "session.act", {
                    "sessionId": session_id, "requestId": "before-read",
                    "action": {"type": "read", "selector": "#state"},
                })
                assert before == {"text": "0"}, before

                environment = private_environment(authority, "AUTHORITY_ONLY")
                (Path(environment["CODEX_HOME"]) / "config.toml").write_text(
                    'model = "gpt-5.1"\nmodel_provider = "mock"\n'
                    'web_search = "disabled"\n[model_providers.mock]\n'
                    'name = "Local Mock"\n'
                    f'base_url = "http://127.0.0.1:{model.server_port}/v1"\n'
                    'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
                    'supports_websockets = false\n'
                )
                app_socket = root / "app.sock"
                listen = "unix://" + str(app_socket) if shared_clients else "stdio://"
                app = subprocess.Popen([str(CODEX), "app-server", "--listen", listen],
                                       cwd=authority, env=environment,
                                       stdin=subprocess.DEVNULL if shared_clients else subprocess.PIPE,
                                       stdout=subprocess.DEVNULL if shared_clients else subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, bufsize=0,
                                       start_new_session=True)
                if shared_clients:
                    shared_result = asyncio.run(shared_authority_turn(
                        app, app_socket, authority, bun, broker_socket, session_id, root))
                    completed = shared_result["completed"]
                    tool_events = shared_result["toolEvents"]
                else:
                    rpc = JsonRpc(app)
                    rpc.call(1, "initialize", {"clientInfo": {
                        "name": "orbit_real_mcp_probe", "title": "Orbit real MCP probe",
                        "version": "1",
                    }, "capabilities": {"experimentalApi": True}})
                    rpc.send("initialized")
                    thread = rpc.call(2, "thread/start", {
                        "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
                        "cwd": str(authority), "approvalPolicy": "never",
                        "sandbox": "danger-full-access", "config": {"mcp_servers": {
                            "orbit_private": {"command": bun, "args": [str(SESSION_MCP)],
                                              "env": {"ORBIT_SOCKET": str(broker_socket),
                                                      "ORBIT_SESSION_ID": session_id,
                                                      "ORBIT_USAGE_DIR": str(root / "usage")}},
                        }},
                    })["thread"]
                    rpc.call(3, "turn/start", {"threadId": thread["id"], "input": [
                        {"type": "text", "text": "Click the private fixture button."}]})
                    completed = wait_for_turn(rpc, thread["id"])
                    tool_events = [message.get("params", {}).get("item")
                        for message in rpc.messages if message.get("method") == "item/completed"
                        and message.get("params", {}).get("threadId") == thread["id"]
                        and message.get("params", {}).get("item", {}).get("type") == "mcpToolCall"]
                deadline = time.monotonic() + 5
                while not clicks and time.monotonic() < deadline:
                    time.sleep(0.05)
                after = None
                for attempt in range(20):
                    after = broker_call(str(broker_socket), "session.act", {
                        "sessionId": session_id, "requestId": f"after-read-{attempt}",
                        "action": {"type": "read", "selector": "#state"},
                    })
                    if after == {"text": "1"}:
                        break
                    time.sleep(0.05)
                tools = model_requests[0].get("tools", []) if model_requests else []
                namespace = next((tool for tool in tools if tool.get("name") ==
                                  "mcp__orbit_private"), None)
                advertised = namespace is not None and any(tool.get("name") ==
                    "orbit_act" for tool in namespace.get("tools", []))
                result = {"advertised": advertised,
                          "turnStatus": completed["status"],
                          "mcpCallStatus": tool_events[0]["status"] if tool_events else None,
                          "modelRequests": len(model_requests),
                          "fixtureClicks": len(clicks),
                          "fixtureRequests": fixture_requests,
                          "before": before, "after": after,
                          "boundSession": session_id}
                if shared_clients:
                    result["sharedAuthority"] = shared_result["shared"]
                print(json.dumps(result, sort_keys=True))
                assert result["advertised"] is True, result
                assert result["turnStatus"] == "completed", result
                assert result["mcpCallStatus"] == "completed", result
                assert result["modelRequests"] == 2, result
                assert result["fixtureClicks"] == 1, result
                assert result["after"] == {"text": "1"}, result
                if shared_clients:
                    assert all(value is True for value in shared_result["shared"].values()), result
        finally:
            stop_process(app)
            if session_id:
                try:
                    broker_call(str(broker_socket), "session.stop", {"sessionId": session_id})
                except Exception:
                    pass
            if broker and broker.poll() is None and broker.stdin:
                broker.stdin.close()
                try:
                    broker.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    stop_process(broker)
            stop_process(broker)
            model.shutdown()
            model.server_close()
            model_worker.join(timeout=2)
            fixture.shutdown()
            fixture.server_close()
            fixture_worker.join(timeout=2)


if __name__ == "__main__":
    main()
