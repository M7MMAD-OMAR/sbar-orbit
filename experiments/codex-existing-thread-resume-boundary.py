#!/usr/bin/python3
"""Measure read, resume, and turn boundaries with a disposable Codex account."""

import asyncio
import hashlib
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
            "role": "assistant", "content": [{"type": "output_text", "text": f"reply {number}",
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
        try:
            async for raw in self.connection:
                message = json.loads(raw)
                request_id = message.get("id")
                if request_id in self.pending:
                    self.pending.pop(request_id).set_result(message)
                else:
                    self.notifications.append(message)
        except websockets.ConnectionClosed:
            pass

    async def call(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.connection.send(json.dumps({"id": request_id, "method": method,
                                               "params": params}))
        return await asyncio.wait_for(future, 20)

    async def initialize(self, name):
        init = {"clientInfo": {"name": name, "title": name, "version": "1"},
                "capabilities": {"experimentalApi": True}}
        result = await self.call("initialize", init)
        require_result(result, "initialize")
        await self.connection.send(json.dumps({"method": "initialized", "params": {}}))

    async def close(self):
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)


def require_result(reply, method):
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


async def wait_turn(client, thread_id, previous_count):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        completed = sum(event.get("method") == "turn/completed" and
                        event.get("params", {}).get("threadId") == thread_id
                        for event in client.notifications)
        if completed > previous_count:
            return
        await asyncio.sleep(0.05)
    raise TimeoutError("Disposable turn did not complete")


async def submit_turn(client, thread_id, marker, completion_client=None):
    completion_client = completion_client or client
    prior = sum(event.get("method") == "turn/completed" and
                event.get("params", {}).get("threadId") == thread_id
                for event in completion_client.notifications)
    reply = await client.call("turn/start", {
        "threadId": thread_id, "input": [{"type": "text", "text": marker}],
    })
    require_result(reply, "turn/start")
    await wait_turn(completion_client, thread_id, prior)
    return reply


def snapshot(codex_home):
    result = {}
    for path in sorted(codex_home.rglob("*")):
        if not path.is_file() or path.name == "config.toml":
            continue
        try:
            data = path.read_bytes()
            stat = path.stat()
        except FileNotFoundError:
            continue
        result[str(path.relative_to(codex_home))] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data), "mtimeNs": stat.st_mtime_ns,
        }
    return result


async def stable_snapshot(codex_home):
    previous = snapshot(codex_home)
    for _ in range(30):
        await asyncio.sleep(0.1)
        current = snapshot(codex_home)
        if current == previous:
            return current
        previous = current
    raise TimeoutError("Disposable Codex files did not settle")


def changes(before, after):
    return {path: {"before": before.get(path), "after": after.get(path)}
            for path in sorted(before.keys() | after.keys())
            if before.get(path) != after.get(path)}


def launch_authority(root, env):
    socket_path = root / "socket" / "app.sock"
    socket_path.unlink(missing_ok=True)
    authority = subprocess.Popen(
        [CODEX, "app-server", "--listen", "unix://" + str(socket_path)],
        cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if socket_path.exists():
            return authority, socket_path
        if authority.poll() is not None:
            raise RuntimeError("Disposable app server exited")
        time.sleep(0.05)
    raise TimeoutError("Disposable app server socket did not open")


def stop_authority(authority):
    if authority.poll() is None:
        os.killpg(authority.pid, signal.SIGTERM)
        try:
            authority.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(authority.pid, signal.SIGKILL)
            authority.wait(timeout=5)


async def main():
    source_root = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    if not source_root:
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT")
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Unexpected source commit: {commit}")
    version = subprocess.run([CODEX, "--version"], text=True,
                             capture_output=True, check=True).stdout.strip()
    if version != "codex-cli 0.155.0-alpha.9.2":
        raise RuntimeError(f"Unexpected CLI version: {version}")

    with tempfile.TemporaryDirectory(prefix="orbit-resume-boundary-") as directory:
        root = Path(directory)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)
        requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                payload = model_response(len(requests))
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
        env = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "MOCK_API_KEY": "disposable", "NO_PROXY": "127.0.0.1,localhost",
        }
        (root / "codex" / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        evidence = {"sourceCommit": commit, "cliVersion": version}
        authority = None
        try:
            authority, socket_path = launch_authority(root, env)
            async with (websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                            compression=None) as owner_socket,
                        websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                            compression=None) as private_socket):
                owner = Client(owner_socket)
                private = Client(private_socket)
                await asyncio.gather(owner.initialize("orbit_owner_fixture"),
                                     private.initialize("orbit_private_fixture"))
                started = require_result(await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only",
                }), "thread/start")
                thread_id = started["thread"]["id"]
                evidence["threadId"] = thread_id
                await submit_turn(owner, thread_id, "Save synthetic conversation")
                before_loaded_read = await stable_snapshot(root / "codex")
                loaded_read = await private.call("thread/read", {
                    "threadId": thread_id, "includeTurns": False,
                })
                require_result(loaded_read, "loaded thread/read")
                evidence["loadedReadChanges"] = changes(before_loaded_read,
                                                          snapshot(root / "codex"))
                loaded_turn = await submit_turn(private, thread_id,
                                                "Private turn without resume while loaded",
                                                completion_client=owner)
                evidence["loadedTurnWithoutResumeAccepted"] = "result" in loaded_turn
                evidence["ownerCompletionNotificationsAfterPrivateTurn"] = sum(
                    event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in owner.notifications
                )
                evidence["privateCompletionNotificationsBeforeResume"] = sum(
                    event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in private.notifications
                )
                before_loaded_resume = await stable_snapshot(root / "codex")
                loaded_resume = await private.call("thread/resume", {
                    "threadId": thread_id, "excludeTurns": True,
                })
                require_result(loaded_resume, "loaded thread/resume")
                evidence["loadedResumeChanges"] = changes(before_loaded_resume,
                                                            snapshot(root / "codex"))
                evidence["loadedResumeModel"] = loaded_resume["result"].get("model")
                evidence["ownerModelAfterLoadedResume"] = require_result(
                    await owner.call("thread/read", {"threadId": thread_id,
                                                     "includeTurns": False}),
                    "owner thread/read")["thread"].get("model")
                await owner.close()
                await private.close()
            stop_authority(authority)
            authority = None

            authority, socket_path = launch_authority(root, env)
            async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                             compression=None) as private_socket:
                private = Client(private_socket)
                await private.initialize("orbit_private_fixture")
                before_cold_read = await stable_snapshot(root / "codex")
                cold_read = await private.call("thread/read", {
                    "threadId": thread_id, "includeTurns": False,
                })
                require_result(cold_read, "cold thread/read")
                after_cold_read = snapshot(root / "codex")
                evidence["coldReadChanges"] = changes(before_cold_read, after_cold_read)
                cold_turn = await private.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Turn before resume"}],
                })
                evidence["coldTurnBeforeResume"] = cold_turn.get("error")
                before_cold_resume = await stable_snapshot(root / "codex")
                rollout_paths = list((root / "codex" / "sessions").rglob("rollout-*.jsonl"))
                if len(rollout_paths) != 1:
                    raise RuntimeError(f"Expected one synthetic rollout, got {len(rollout_paths)}")
                rollout_before = rollout_paths[0].read_bytes()
                cold_resume = await private.call("thread/resume", {
                    "threadId": thread_id, "excludeTurns": True,
                })
                require_result(cold_resume, "cold thread/resume")
                after_cold_resume = snapshot(root / "codex")
                rollout_after = rollout_paths[0].read_bytes()
                evidence["coldResumeRolloutAppended"] = rollout_after.startswith(rollout_before)
                added = rollout_after[len(rollout_before):]
                evidence["coldResumeRolloutRecords"] = [
                    {"type": record.get("type"),
                     "eventType": record.get("payload", {}).get("type")}
                    for line in added.splitlines() if line.strip()
                    for record in [json.loads(line)]
                ]
                evidence["coldResumeChanges"] = changes(before_cold_resume,
                                                          after_cold_resume)
                resumed_turn = await submit_turn(private, thread_id,
                                                 "Turn after explicit resume")
                evidence["turnAfterResumeAccepted"] = "result" in resumed_turn
                evidence["coldResumeModel"] = cold_resume["result"].get("model")
                evidence["modelRequestCount"] = len(requests)
                await private.close()
        finally:
            if authority is not None:
                stop_authority(authority)
            model.shutdown()
            model.server_close()

        print(json.dumps(evidence, sort_keys=True), flush=True)
        assert evidence["loadedTurnWithoutResumeAccepted"]
        assert evidence["coldTurnBeforeResume"] is not None
        assert evidence["turnAfterResumeAccepted"]


if __name__ == "__main__":
    asyncio.run(main())
