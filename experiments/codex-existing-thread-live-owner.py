#!/usr/bin/python3
"""Measure a private turn in an owner's already saved, still live thread.

This uses temporary Codex state, a local mock model, and a private Unix socket.
The owner connection remains open for every turn in the same server process.
"""

import asyncio
import http.server
import json
import os
import runpy
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import websockets


HELPERS = runpy.run_path(str(Path(__file__).with_name("codex-existing-thread-tool-ceiling.py")))
Client = HELPERS["Client"]
free_port = HELPERS["free_port"]
response_stream = HELPERS["response_stream"]
start_authority = HELPERS["start_authority"]
stop_authority = HELPERS["stop_authority"]
SOURCE_COMMIT = HELPERS["SOURCE_COMMIT"]


async def submit(client, thread_id, label, allowed_tools=None):
    prior = sum(event.get("method") == "turn/completed" and
                event.get("params", {}).get("threadId") == thread_id
                for event in client.notifications)
    params = {"threadId": thread_id, "input": [{"type": "text", "text": label}]}
    if allowed_tools is not None:
        params["allowedTools"] = allowed_tools
    started = await client.call("turn/start", params)
    turn_id = started["turn"]["id"]
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        completed = [event for event in client.notifications
                     if event.get("method") == "turn/completed" and
                     event.get("params", {}).get("threadId") == thread_id]
        if len(completed) > prior:
            latest = completed[-1]["params"]["turn"]
            if latest["id"] != turn_id or latest["status"] != "completed":
                raise RuntimeError(f"Unexpected completion: {latest}")
            return turn_id
        await asyncio.sleep(0.05)
    raise TimeoutError(f"Disposable turn did not complete: {label}")


async def main():
    source_root_name = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    binary = os.environ.get("ORBIT_CODEX_APP_SERVER_BINARY") or os.environ.get("ORBIT_CODEX_TEST_BINARY")
    if not source_root_name or not binary:
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT and a Codex test binary")
    source_root = Path(source_root_name).resolve()
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Unexpected source commit: {commit}")
    direct = bool(os.environ.get("ORBIT_CODEX_APP_SERVER_BINARY"))
    version = subprocess.run([binary, "--version"], text=True, capture_output=True,
                             check=True).stdout.strip()
    expected = ("codex-app-server" if direct else "codex-cli") + " 0.155.0-alpha.9.2"
    if version != expected:
        raise RuntimeError(f"Unexpected executable version: {version}")

    with tempfile.TemporaryDirectory(prefix="orbit-existing-live-owner-") as temporary:
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
            authority = start_authority(binary, root, environment, socket_path)
            async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                              compression=None) as owner_socket:
                owner = Client(owner_socket)
                await owner.initialize()
                started = await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never", "sandbox": "read-only",
                })
                thread_id = started["thread"]["id"]
                owner_first = await submit(owner, thread_id, "Owner saved original turn")
                async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                                  compression=None) as private_socket:
                    private = Client(private_socket)
                    await private.initialize()
                    resumed = await private.call("thread/resume", {
                        "threadId": thread_id, "excludeTurns": True,
                    })
                    if resumed["thread"]["id"] != thread_id:
                        raise RuntimeError("Private resume changed the thread ID")
                    private_turn = await submit(private, thread_id,
                                                "Private appended existing turn", [])
                    owner_last = await submit(owner, thread_id,
                                              "Owner continued after private turn")
                    read = await owner.call("thread/read", {
                        "threadId": thread_id, "includeTurns": True,
                    })
                    history = json.dumps(read, sort_keys=True)
                    labels = ["Owner saved original turn", "Private appended existing turn",
                              "Owner continued after private turn"]
                    history_contains_all = all(label in history for label in labels)
                    await private.close()
                await owner.close()
            counts = [len(request.get("tools", [])) for request in model_requests]
            inventories = [sorted(tool.get("name", "<unnamed>")
                                  for tool in request.get("tools", []))
                           for request in model_requests]
            evidence = {
                "sourceCommit": commit, "version": version, "sameThread": True,
                "distinctTurns": len({owner_first, private_turn, owner_last}) == 3,
                "ownerConnectionStayedOpen": True, "historyContainsAllThreeInputs": history_contains_all,
                "ownerFirstTools": counts[0] if len(counts) > 0 else None,
                "privateExistingTools": counts[1] if len(counts) > 1 else None,
                "ownerAfterTools": counts[2] if len(counts) > 2 else None,
                "ownerInventoryPreserved": len(inventories) == 3 and inventories[0] == inventories[2],
                "ownerCompletionNotifications": sum(
                    event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in owner.notifications),
                "privateCompletionNotifications": sum(
                    event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in private.notifications),
            }
            print(json.dumps(evidence, sort_keys=True), flush=True)
            assert len(model_requests) == 3, "Expected three model requests"
            assert evidence["distinctTurns"], "Turns were not distinct"
            assert history_contains_all, "Saved thread did not contain all three inputs"
            assert counts[0] > 0 and counts[1] == 0 and counts[2] > 0
            assert evidence["ownerInventoryPreserved"], "Owner tool inventory changed"
        finally:
            stop_authority(authority, socket_path)
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    asyncio.run(main())
