#!/usr/bin/python3
"""Read a stable mixed-generation fake Codex profile with the existing helper."""

import asyncio
import hashlib
import http.server
import json
import os
import runpy
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import websockets


BASE = runpy.run_path(str(Path(__file__).with_name("codex-paginated-live-owner-read.py")))
Client = BASE["Client"]
SOURCE_COMMIT = BASE["SOURCE_COMMIT"]
OWNER_SHA256 = BASE["OWNER_SHA256"]
HELPER_SHA256 = BASE["HELPER_SHA256"]
SQLITE_NAMES = BASE["SQLITE_NAMES"]
fingerprint = BASE["fingerprint"]
guarded_page = BASE["guarded_page"]
owner_command = BASE["owner_command"]
free_port = BASE["free_port"]
response_stream = BASE["response_stream"]


def hashes(snapshot):
    return {name: fields[-1] for name, fields in snapshot.items()}


def copy_stable(owner_root, destination, names, include_sessions=False):
    for attempt in range(3):
        before = fingerprint(owner_root)
        for name in names:
            shutil.copy2(owner_root / name, destination / name)
        if include_sessions:
            shutil.rmtree(destination / "sessions", ignore_errors=True)
            shutil.copytree(owner_root / "sessions", destination / "sessions", symlinks=False)
        after = fingerprint(owner_root)
        if before == after:
            return hashes(after)
        if attempt < 2:
            time.sleep(0.05)
    raise RuntimeError("Fake owner changed during a generation copy")


async def main():
    source = Path(os.environ["ORBIT_CODEX_SOURCE_ROOT"]).resolve()
    owner_binary = Path(os.environ["ORBIT_CODEX_APP_SERVER_BINARY"]).resolve()
    helper_binary = Path(os.environ["ORBIT_CODEX_PAGE_HELPER_BINARY"]).resolve()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source,
                                     text=True).strip()
    if commit != SOURCE_COMMIT:
        raise RuntimeError("Unexpected disposable Codex source commit")
    if hashlib.sha256(owner_binary.read_bytes()).hexdigest() != OWNER_SHA256:
        raise RuntimeError("Unexpected fake owner binary")
    if hashlib.sha256(helper_binary.read_bytes()).hexdigest() != HELPER_SHA256:
        raise RuntimeError("Unexpected read-only page helper binary")
    version = subprocess.check_output([str(owner_binary), "--version"], text=True).strip()
    if version != "codex-app-server 0.155.0-alpha.9.2":
        raise RuntimeError("Unexpected disposable Codex owner version")

    with tempfile.TemporaryDirectory(prefix="orbit-paginated-live-mismatch-") as temporary:
        root = Path(temporary)
        owner_root = root / "owner"
        mixed_root = root / "mixed"
        owner_root.mkdir(mode=0o700)
        mixed_root.mkdir(mode=0o700)
        for name in ("project", "config", "data", "cache", "state", "runtime"):
            (owner_root / name).mkdir(mode=0o700)

        requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                payload = response_stream(len(requests))
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
        (owner_root / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n')
        owner = subprocess.Popen(owner_command(owner_root, owner_binary),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            socket = owner_root / "app.sock"
            deadline = time.monotonic() + 12
            while not socket.exists() and time.monotonic() < deadline:
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited before socket opened: " +
                                       owner.stderr.read(1024).decode(errors="replace"))
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
                first_label = "Fake owner committed first turn"
                second_label = "Fake owner committed second turn"
                await rpc.turn(thread_id, first_label)
                first_page, first_before, first_after = guarded_page(
                    owner_root, helper_binary, thread_id)
                if len(first_page.get("data", [])) != 1 or first_label not in json.dumps(first_page):
                    raise RuntimeError("Fake first generation did not contain exactly one turn")
                history_names = [name for name in SQLITE_NAMES if name.startswith("thread_history")]
                first_hashes = copy_stable(owner_root, mixed_root, history_names)

                await rpc.turn(thread_id, second_label)
                second_page, second_before, second_after = guarded_page(
                    owner_root, helper_binary, thread_id)
                if len(second_page.get("data", [])) != 2 or second_label not in json.dumps(second_page):
                    raise RuntimeError("Fake second generation did not contain two turns")
                state_names = [name for name in SQLITE_NAMES if name.startswith("state_5")]
                second_hashes = copy_stable(owner_root, mixed_root, state_names,
                                            include_sessions=True)
                mixed_before = fingerprint(mixed_root)
                mixed_hashes = hashes(mixed_before)
                if not any(first_hashes[name] != second_hashes[name] for name in history_names):
                    raise RuntimeError("Fake history generations did not differ")
                if not any(first_hashes[name] != second_hashes[name] for name in state_names):
                    raise RuntimeError("Fake state generations did not differ")
                for name in history_names:
                    if mixed_hashes[name] != first_hashes[name]:
                        raise RuntimeError("Mixed fixture lost first generation history")
                for name in state_names:
                    if mixed_hashes[name] != second_hashes[name]:
                        raise RuntimeError("Mixed fixture lost second generation state")
                for name in mixed_hashes:
                    if name.startswith("sessions/") and mixed_hashes[name] != second_hashes[name]:
                        raise RuntimeError("Mixed fixture lost second generation rollout")

                mixed_page = None
                mixed_error = None
                try:
                    mixed_page, _, mixed_after = guarded_page(
                        mixed_root, helper_binary, thread_id)
                except Exception as error:
                    mixed_error = f"{type(error).__name__}: {error}"
                    mixed_after = fingerprint(mixed_root)
                if mixed_after != mixed_before:
                    raise RuntimeError("Read-only helper changed the mixed fixture")
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited before mixed read")

                accepted_stale = (mixed_page is not None and
                                  len(mixed_page.get("data", [])) == 1 and
                                  first_label in json.dumps(mixed_page) and
                                  second_label not in json.dumps(mixed_page))
                result = {
                    "sourceCommit": commit,
                    "ownerVersion": version,
                    "ownerSha256": OWNER_SHA256,
                    "helperSha256": HELPER_SHA256,
                    "scenario": "stable state and rollout from second owner turn with first turn history",
                    "fakeOwnerConnectedDuringMixedRead": True,
                    "firstPageTurns": len(first_page["data"]),
                    "secondPageTurns": len(second_page["data"]),
                    "mixedPageTurns": len(mixed_page.get("data", [])) if mixed_page else None,
                    "mixedReadError": mixed_error,
                    "acceptedStalePage": accepted_stale,
                    "mixedPageHasSecondTurn": second_label in json.dumps(mixed_page),
                    "firstHistorySecondStateAndRollout": True,
                    "firstReadChangedFiles": [name for name in first_before
                                              if first_before[name] != first_after[name]],
                    "secondReadChangedFiles": [name for name in second_before
                                               if second_before[name] != second_after[name]],
                    "mixedReadChangedFiles": [name for name in mixed_before
                                              if mixed_before[name] != mixed_after[name]],
                    "firstHistoryHashes": {name: first_hashes[name] for name in history_names},
                    "secondHistoryHashes": {name: second_hashes[name] for name in history_names},
                    "secondStateHashes": {name: second_hashes[name] for name in state_names},
                    "mixedHashes": mixed_hashes,
                    "ownerModelRequests": len(requests),
                }
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
    asyncio.run(main())
