#!/usr/bin/python3
"""Measure status notification routing with two disposable Codex threads."""

import asyncio
import http.server
import json
import os
import runpy
import subprocess
import tempfile
import threading
from pathlib import Path

import websockets


ROOT = Path(__file__).resolve().parent
HELPERS = runpy.run_path(str(ROOT / "codex-cold-read-subscribe.py"))
Client = HELPERS["Client"]
free_port = HELPERS["free_port"]
launch_authority = HELPERS["launch_authority"]
model_response = HELPERS["model_response"]
require_result = HELPERS["require_result"]
stop_authority = HELPERS["stop_authority"]
submit_turn = HELPERS["submit_turn"]
SOURCE_COMMIT = HELPERS["SOURCE_COMMIT"]
CODEX = os.environ.get("ORBIT_CODEX_TEST_BINARY", "/usr/lib/chatgpt/resources/codex")


def status_count(client, thread_id):
    return sum(event.get("method") == "thread/status/changed" and
               event.get("params", {}).get("threadId") == thread_id
               for event in client.notifications)


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

    with tempfile.TemporaryDirectory(prefix="orbit-notification-scope-") as directory:
        root = Path(directory)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)

        class MockModel(http.server.BaseHTTPRequestHandler):
            requests = 0

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                type(self).requests += 1
                payload = model_response(type(self).requests)
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
            "CODEX_APP_SERVER_ORBIT_STATUS_SCOPE_EXPERIMENT":
                os.environ.get("ORBIT_STATUS_SCOPE_EXPERIMENT", ""),
        }
        (root / "codex" / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        authority = None
        evidence = {"sourceCommit": commit, "cliVersion": version,
                    "experiment": env["CODEX_APP_SERVER_ORBIT_STATUS_SCOPE_EXPERIMENT"]}
        try:
            authority, socket_path = launch_authority(root, env)
            async with (
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                        compression=None) as owner_socket,
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                        compression=None) as private_socket,
            ):
                owner = Client(owner_socket)
                private = Client(private_socket)
                await asyncio.gather(owner.initialize("orbit_owner_fixture"),
                                     private.initialize("orbit_private_attached"))
                thread_params = {"cwd": str(root / "project"), "model": "gpt-5.1",
                                 "modelProvider": "mock", "approvalPolicy": "never",
                                 "sandbox": "read-only"}
                first = require_result(await owner.call("thread/start", thread_params),
                                       "first thread/start")["thread"]["id"]
                await submit_turn(owner, first, "Save first owner thread")
                require_result(await private.call("thread/resume", {
                    "threadId": first, "excludeTurns": True,
                }), "private thread/resume")
                await submit_turn(owner, first, "Subscribed owner turn",
                                  completion_client=private)
                second = require_result(await owner.call("thread/start", thread_params),
                                        "second thread/start")["thread"]["id"]
                await submit_turn(owner, second, "Unrelated owner turn")
                await asyncio.sleep(0.2)
                evidence.update({
                    "subscribedThreadStatusAtPrivate": status_count(private, first),
                    "unrelatedThreadStatusAtPrivate": status_count(private, second),
                    "unrelatedThreadStatusAtOwner": status_count(owner, second),
                    "subscribedCompletionAtPrivate": sum(
                        event.get("method") == "turn/completed" and
                        event.get("params", {}).get("threadId") == first
                        for event in private.notifications),
                    "modelRequestCount": MockModel.requests,
                })
                await owner.close()
                await private.close()
        finally:
            if authority is not None:
                stop_authority(authority)
            model.shutdown()
            model.server_close()

    print(json.dumps(evidence, sort_keys=True), flush=True)
    assert evidence["subscribedThreadStatusAtPrivate"] >= 1
    assert evidence["subscribedCompletionAtPrivate"] >= 1
    assert evidence["unrelatedThreadStatusAtOwner"] >= 1
    assert evidence["modelRequestCount"] == 3
    assert evidence["unrelatedThreadStatusAtPrivate"] == 0


if __name__ == "__main__":
    asyncio.run(main())
