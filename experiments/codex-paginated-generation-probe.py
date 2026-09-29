#!/usr/bin/python3
"""Exercise two cursor pages while a disposable Codex owner adds a turn."""

import asyncio
import hashlib
import http.server
import json
import os
import runpy
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import websockets


HERE = Path(__file__).parent
BASE = runpy.run_path(str(HERE / "codex-paginated-live-owner-read.py"))
PAGE = runpy.run_path(str(HERE / "codex-paginated-live-page.py"))
PROTOTYPE = runpy.run_path(str(HERE / "codex-paginated-generation-prototype.py"))
Client = BASE["Client"]
read_page = PAGE["read_page"]
FixtureCoordinator = PROTOTYPE["FixtureCoordinator"]
Unavailable = PROTOTYPE["Unavailable"]


def request(thread_id, cursor, limit):
    return {"method": "thread/turns/list", "params": {
        "threadId": thread_id, "readOnly": True, "limit": limit,
        "cursor": cursor, "sortDirection": "asc", "itemsView": "full"}}


def verify_binaries():
    source = Path(os.environ["ORBIT_CODEX_SOURCE_ROOT"]).resolve()
    owner = Path(os.environ["ORBIT_CODEX_APP_SERVER_BINARY"]).resolve()
    helper = Path(os.environ["ORBIT_CODEX_PAGE_HELPER_BINARY"]).resolve()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source,
                                     text=True).strip()
    if commit != BASE["SOURCE_COMMIT"]:
        raise RuntimeError("Unexpected disposable source commit")
    if hashlib.sha256(owner.read_bytes()).hexdigest() != BASE["OWNER_SHA256"]:
        raise RuntimeError("Unexpected disposable owner binary")
    if hashlib.sha256(helper.read_bytes()).hexdigest() != BASE["HELPER_SHA256"]:
        raise RuntimeError("Unexpected disposable page helper")
    return owner, helper, commit


async def main(mode):
    owner_binary, helper_binary, commit = verify_binaries()
    with tempfile.TemporaryDirectory(prefix="orbit-paginated-generation-") as temporary:
        root = Path(temporary)
        profile = root / "owner"
        profile.mkdir(mode=0o700)
        for name in ("project", "config", "data", "cache", "state", "runtime"):
            (profile / name).mkdir(mode=0o700)
        requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                payload = BASE["response_stream"](len(requests))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", BASE["free_port"]()), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        (profile / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n')
        owner = subprocess.Popen(BASE["owner_command"](profile, owner_binary),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            socket = profile / "app.sock"
            deadline = time.monotonic() + 12
            while not socket.exists() and time.monotonic() < deadline:
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited before socket opened")
                await asyncio.sleep(0.05)
            if not socket.exists():
                raise TimeoutError("Fake owner socket did not open")
            async with websockets.unix_connect(str(socket), uri="ws://localhost/rpc",
                                              compression=None) as connection:
                rpc = Client(connection)
                await rpc.initialize()
                started = await rpc.call("thread/start", {
                    "cwd": "/fixture/project", "model": "gpt-5.1",
                    "modelProvider": "mock", "approvalPolicy": "never", "sandbox": "read-only"})
                thread_id = started["thread"]["id"]
                labels = ["Generation fixture turn one", "Generation fixture turn two",
                          "Generation fixture turn three"]
                if mode == "red":
                    for label in labels[:2]:
                        await rpc.turn(thread_id, label)
                    first = read_page(profile, helper_binary, request(thread_id, None, 1))
                    cursor = first.get("nextCursor")
                    if not cursor or labels[0] not in json.dumps(first):
                        raise RuntimeError("First cursor page lacks first turn or cursor")
                    await rpc.turn(thread_id, labels[2])
                    second = read_page(profile, helper_binary, request(thread_id, cursor, 2))
                    leaked = labels[2] in json.dumps(second)
                    result = {"mode": mode, "sourceCommit": commit,
                              "firstPageTurns": len(first["data"]),
                              "secondPageTurns": len(second["data"]),
                              "newTurnLeakedIntoSecondPage": leaked,
                              "ownerModelRequests": len(requests)}
                elif mode == "green":
                    snapshots = root / "snapshots"
                    snapshots.mkdir(mode=0o700)
                    coordinator = FixtureCoordinator(profile, snapshots, helper_binary, owner)
                    for label in labels[:2]:
                        await coordinator.turn(rpc, thread_id, label)
                    generation = await coordinator.open(thread_id)
                    try:
                        captured_before = BASE["fingerprint"](generation.root)
                        owner_before_third = BASE["fingerprint"](profile)
                        first = coordinator.page(generation.token, None, 1)
                        cursor = first.get("nextCursor")
                        if not cursor or labels[0] not in json.dumps(first):
                            raise RuntimeError("Captured first page lacks first turn or cursor")
                        await coordinator.turn(rpc, thread_id, labels[2])
                        owner_after_third = BASE["fingerprint"](profile)
                        second = coordinator.page(generation.token, cursor, 2)
                        captured_after = BASE["fingerprint"](generation.root)
                        owner_changed = sorted(name for name in owner_before_third
                                               if owner_before_third[name] != owner_after_third.get(name))
                        captured_changed = sorted(name for name in captured_before
                                                  if captured_before[name] != captured_after.get(name))
                        leaked = labels[2] in json.dumps(second)
                        if leaked or len(second.get("data", [])) != 1 or captured_changed or not owner_changed:
                            raise RuntimeError("Owner turn leaked into captured generation")
                        fresh = await coordinator.open(thread_id)
                        try:
                            wrong_cursor_rejected = False
                            try:
                                coordinator.page(fresh.token, cursor, 2)
                            except Unavailable:
                                wrong_cursor_rejected = True
                            latest = coordinator.page(fresh.token, None, 5)
                        finally:
                            coordinator.close(fresh.token)
                        if not wrong_cursor_rejected or labels[2] not in json.dumps(latest):
                            raise RuntimeError("Generation cursor or refresh check failed")
                        result = {"mode": mode, "sourceCommit": commit,
                                  "firstPageTurns": len(first["data"]),
                                  "secondPageTurns": len(second["data"]),
                                  "newTurnLeakedIntoSecondPage": leaked,
                                  "newGenerationTurns": len(latest["data"]),
                                  "crossGenerationCursorRejected": wrong_cursor_rejected,
                                  "capturedRolloutPrefixBytes": generation.prefix_bytes,
                                  "capturedReadChangedFiles": captured_changed,
                                  "ownerChangedFilesAfterThirdTurn": owner_changed,
                                  "capturedSnapshotFileCount": len(captured_after),
                                  "ownerModelRequests": len(requests)}
                    finally:
                        coordinator.close(generation.token)
                else:
                    raise ValueError("Expected red or green mode")
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited before page two")
                print(json.dumps(result, sort_keys=True), flush=True)
                await rpc.close()
        finally:
            if owner.poll() is None:
                os.killpg(owner.pid, signal.SIGTERM)
                try:
                    owner.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(owner.pid, signal.SIGKILL)
                    owner.wait(timeout=3)
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
