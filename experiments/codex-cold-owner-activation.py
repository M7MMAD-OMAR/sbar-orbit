#!/usr/bin/python3
"""Test owner activation of a cold saved thread with a disposable Codex account."""

import asyncio
import hashlib
import http.server
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import websockets


BASE_PATH = Path(__file__).with_name("codex-cold-read-subscribe.py")
SPEC = importlib.util.spec_from_file_location("cold_read_fixture", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cold read fixture is unavailable")
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)

SETTINGS = ("model", "modelProvider", "cwd", "approvalPolicy", "sandbox",
            "reasoningEffort")


def selected_settings(response):
    return {key: response.get(key) for key in SETTINGS}


async def main():
    source_root = os.environ.get("ORBIT_CODEX_SOURCE_ROOT")
    if not source_root:
        raise RuntimeError("Set ORBIT_CODEX_SOURCE_ROOT")
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source_root,
                            text=True, capture_output=True, check=True).stdout.strip()
    if commit != fixture.SOURCE_COMMIT:
        raise RuntimeError(f"Unexpected source commit: {commit}")
    version = subprocess.run([fixture.CODEX, "--version"], text=True,
                             capture_output=True, check=True).stdout.strip()
    if version != "codex-cli 0.155.0-alpha.9.2":
        raise RuntimeError(f"Unexpected CLI version: {version}")

    with tempfile.TemporaryDirectory(prefix="orbit-cold-owner-activation-") as directory:
        root = Path(directory)
        for name in ("home", "codex", "config", "data", "cache", "state", "runtime",
                     "project", "socket"):
            (root / name).mkdir(mode=0o700)
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model_requests.append(body)
                payload = fixture.model_response(len(model_requests))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", fixture.free_port()), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        env = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "MOCK_API_KEY": "disposable", "NO_PROXY": "127.0.0.1,localhost",
            "CODEX_APP_SERVER_ORBIT_COLD_ATTACH_EXPERIMENT": "1",
            "CODEX_APP_SERVER_TURN_OWNER_EXPERIMENT": "1",
            "CODEX_APP_SERVER_DYNAMIC_TOOL_OWNER_EXPERIMENT": "1",
        }
        config = root / "codex" / "config.toml"
        config.write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
        evidence = {"sourceCommit": commit, "cliVersion": version}
        authority = None
        try:
            authority, socket_path = fixture.launch_authority(root, env)
            evidence["ownerPidBeforeRestart"] = authority.pid
            async with websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                            compression=None) as owner_socket:
                owner = fixture.Client(owner_socket)
                await owner.initialize("orbit_owner_fixture")
                started = fixture.require_result(await owner.call("thread/start", {
                    "cwd": str(root / "project"), "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never",
                    "sandbox": "read-only",
                }), "owner thread/start")
                thread_id = started["thread"]["id"]
                evidence["threadId"] = thread_id
                evidence["settingsAtStart"] = selected_settings(started)
                await fixture.submit_turn(owner, thread_id, "Owner saved conversation")
                await owner.close()
            fixture.stop_authority(authority)
            authority = None

            authority, socket_path = fixture.launch_authority(root, env)
            evidence["ownerPidAfterRestart"] = authority.pid
            async with (
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                             compression=None) as owner_socket,
                websockets.unix_connect(str(socket_path), uri="ws://localhost/rpc",
                                             compression=None) as private_socket,
            ):
                owner = fixture.Client(owner_socket)
                private = fixture.Client(private_socket)
                await asyncio.gather(owner.initialize("orbit_owner_fixture"),
                                     private.initialize("orbit_private_attached"))
                before_attach = await fixture.stable_snapshot(root / "codex")
                cold = fixture.require_result(await private.call("thread/read", {
                    "threadId": thread_id, "includeTurns": False, "readOnly": True,
                }), "private cold thread/read")
                evidence["coldStatus"] = cold["thread"].get("status")
                evidence["coldReadTrackedChanges"] = fixture.tracked_changes(
                    fixture.changes(before_attach, fixture.snapshot(root / "codex")))
                denied = await private.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Must fail before owner activation"}],
                    "allowedTools": [],
                })
                evidence["coldTurnDenied"] = "error" in denied
                owner_resume = fixture.require_result(await owner.call("thread/resume", {
                    "threadId": thread_id, "excludeTurns": True,
                }), "owner cold thread/resume")
                evidence["settingsAfterOwnerActivation"] = selected_settings(owner_resume)
                evidence["configHashAfterActivation"] = hashlib.sha256(config.read_bytes()).hexdigest()
                private_before = sum(event.get("method") == "turn/completed" and
                                     event.get("params", {}).get("threadId") == thread_id
                                     for event in private.notifications)
                private_turn = fixture.require_result(await private.call("turn/start", {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Private first follow-up after owner activation"}],
                    "allowedTools": [],
                }), "private first turn/start")
                await fixture.wait_turn(private, thread_id, private_before)
                evidence["privateTurnId"] = private_turn["turn"]["id"]
                evidence["privateCompletionCount"] = sum(
                    event.get("method") == "turn/completed" and
                    event.get("params", {}).get("threadId") == thread_id
                    for event in private.notifications)
                evidence["modelToolCounts"] = [len(request.get("tools", []))
                                               for request in model_requests]
                owner_again = fixture.require_result(await owner.call("thread/resume", {
                    "threadId": thread_id, "excludeTurns": True,
                }), "owner loaded thread/resume")
                evidence["settingsAfterPrivateTurn"] = selected_settings(owner_again)
                evidence["configHashAfterPrivateTurn"] = hashlib.sha256(config.read_bytes()).hexdigest()
                await owner.close()
                await private.close()
            rollout = list((root / "codex" / "sessions").rglob(f"*{thread_id}.jsonl"))
            evidence["savedPrivateMarker"] = len(rollout) == 1 and (
                b"Private first follow-up after owner activation" in rollout[0].read_bytes())
            evidence["modelRequestCount"] = len(model_requests)
        finally:
            if authority is not None:
                fixture.stop_authority(authority)
            model.shutdown()
            model.server_close()

    print(json.dumps(evidence, sort_keys=True), flush=True)
    assert evidence["ownerPidBeforeRestart"] != evidence["ownerPidAfterRestart"]
    assert evidence["coldReadTrackedChanges"] == {}
    assert evidence["coldTurnDenied"]
    assert evidence["settingsAtStart"] == evidence["settingsAfterOwnerActivation"]
    assert evidence["settingsAtStart"] == evidence["settingsAfterPrivateTurn"]
    assert evidence["configHashAfterActivation"] == config_hash
    assert evidence["configHashAfterPrivateTurn"] == config_hash
    assert evidence["privateCompletionCount"] >= 1
    assert evidence["modelToolCounts"][0] > 0
    assert evidence["modelToolCounts"][1] == 0
    assert evidence["savedPrivateMarker"]
    assert evidence["modelRequestCount"] == 2


if __name__ == "__main__":
    asyncio.run(main())
