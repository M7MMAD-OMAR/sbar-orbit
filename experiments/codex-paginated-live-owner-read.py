#!/usr/bin/python3
"""Read a new fake owner turn through a read-only paginated helper."""

import asyncio
import hashlib
import http.server
import json
import os
import runpy
import signal
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
SOURCE_COMMIT = HELPERS["SOURCE_COMMIT"]
HELPER_SHA256 = "6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd"
OWNER_SHA256 = "c1214554e7ea7412cd9072e8f57f710539226b394260422c8170b5c1e46c4042"
SQLITE_NAMES = tuple(base + suffix for base in ("state_5.sqlite", "thread_history_1.sqlite")
                     for suffix in ("", "-wal", "-shm"))


class StalePageError(Exception):
    pass


def file_fingerprint(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NOATIME
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 65536):
            digest.update(chunk)
        after = os.fstat(descriptor)
        identity = lambda stat: (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
                                 stat.st_mtime_ns, stat.st_ctime_ns)
        if identity(before) != identity(after) or identity(after) != identity(path.lstat()):
            raise StalePageError(f"Changed while fingerprinting: {path.name}")
        return (*identity(after), digest.hexdigest())
    finally:
        os.close(descriptor)


def fingerprint(root):
    paths = [root / name for name in SQLITE_NAMES]
    paths.extend(sorted((root / "sessions").rglob("*.jsonl")))
    if not all(path.is_file() and not path.is_symlink() for path in paths):
        raise StalePageError("Missing or linked live owner source")
    if len(paths) > 1000 or sum(path.stat().st_size for path in paths) > 256 * 1024 * 1024:
        raise StalePageError("Live owner source exceeds test limit")
    return {str(path.relative_to(root)): file_fingerprint(path) for path in paths}


def evidence_fingerprint(snapshot):
    keys = ("device", "inode", "mode", "size", "mtimeNs", "ctimeNs", "sha256")
    return {name: dict(zip(keys, values)) for name, values in snapshot.items()}


def helper_page(root, binary, thread_id):
    request = {"method": "thread/turns/list", "params": {"threadId": thread_id,
               "readOnly": True, "limit": 5, "cursor": None, "sortDirection": "asc",
               "itemsView": "full"}}
    payload = json.dumps(request, separators=(",", ":")).encode()
    command = ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--new-session",
               "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
               "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
               "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/fixture"]
    for name in SQLITE_NAMES:
        command.extend(("--ro-bind", str(root / name), "/fixture/" + name))
    command.extend(("--ro-bind", str(root / "sessions"), "/fixture/sessions",
                    "--ro-bind", str(binary), "/reader", "--setenv", "HOME", "/tmp",
                    "--setenv", "ORBIT_BWRAP_PAGE_HELPER", "1", "--", "/reader",
                    "bwrap_paginated_page_helper_child", "--nocapture"))
    completed = subprocess.run(command, input=str(len(payload)).encode() + b"\n" + payload,
                               capture_output=True, timeout=5, check=True)
    frames = [line for line in completed.stdout.splitlines()
              if line.startswith(b"ORBIT_PAGE_RESPONSE:")]
    if len(frames) != 1:
        raise RuntimeError("Disposable helper returned no unique page frame")
    _, length, body = frames[0].split(b":", 2)
    if int(length) != len(body):
        raise RuntimeError("Disposable helper response length mismatch")
    return json.loads(body)


def guarded_page(root, binary, thread_id, expected_source=None):
    before = fingerprint(root)
    if expected_source is not None and before != expected_source:
        raise StalePageError("A prior page source version is stale")
    try:
        result = helper_page(root, binary, thread_id)
    except BaseException:
        if before != fingerprint(root):
            raise StalePageError("Live owner changed source during failed page") from None
        raise
    after = fingerprint(root)
    if before != after:
        raise StalePageError("Live owner changed source during page")
    return result, before, after


def owner_command(root, binary):
    return ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--share-net",
            "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64", "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", "/tmp", "--bind", str(root), "/fixture",
            "--ro-bind", str(binary), "/app-server", "--chdir", "/fixture/project",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", "/tmp", "--setenv", "CODEX_HOME", "/fixture",
            "--setenv", "XDG_CONFIG_HOME", "/fixture/config",
            "--setenv", "XDG_DATA_HOME", "/fixture/data",
            "--setenv", "XDG_CACHE_HOME", "/fixture/cache",
            "--setenv", "XDG_STATE_HOME", "/fixture/state",
            "--setenv", "XDG_RUNTIME_DIR", "/fixture/runtime",
            "--setenv", "MOCK_API_KEY", "disposable",
            "--setenv", "NO_PROXY", "127.0.0.1,localhost",
            "--", "/app-server", "--listen", "unix:///fixture/app.sock"]


async def main():
    source = Path(os.environ["ORBIT_CODEX_SOURCE_ROOT"]).resolve()
    owner_binary = Path(os.environ["ORBIT_CODEX_APP_SERVER_BINARY"]).resolve()
    helper_binary = Path(os.environ["ORBIT_CODEX_PAGE_HELPER_BINARY"]).resolve()
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source,
                                            text=True).strip()
    if source_commit != SOURCE_COMMIT:
        raise RuntimeError("Unexpected Codex source commit")
    if hashlib.sha256(helper_binary.read_bytes()).hexdigest() != HELPER_SHA256:
        raise RuntimeError("Unexpected test-only page helper binary")
    if hashlib.sha256(owner_binary.read_bytes()).hexdigest() != OWNER_SHA256:
        raise RuntimeError("Unexpected fake owner binary")
    version = subprocess.check_output([str(owner_binary), "--version"], text=True).strip()
    if version != "codex-app-server 0.155.0-alpha.9.2":
        raise RuntimeError("Unexpected disposable owner binary")

    with tempfile.TemporaryDirectory(prefix="orbit-paginated-live-owner-") as temporary:
        root = Path(temporary) / "fixture"
        root.mkdir(mode=0o700)
        for name in ("project", "config", "data", "cache", "state", "runtime"):
            (root / name).mkdir(mode=0o700)
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
        root.joinpath("config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n')
        owner = subprocess.Popen(owner_command(root, owner_binary),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            socket = root / "app.sock"
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
                first_label = "Owner fixture turn before live read"
                second_label = "Owner fixture turn after live read"
                await rpc.turn(thread_id, first_label)
                first, first_before, first_after = guarded_page(root, helper_binary, thread_id)
                first_text = json.dumps(first)
                if first_label not in first_text or second_label in first_text:
                    raise RuntimeError("Baseline paginated page has wrong turn content")
                await rpc.turn(thread_id, second_label)
                after_owner = fingerprint(root)
                owner_changed = [name for name in first_after
                                 if first_after[name] != after_owner.get(name)]
                if not any(name.startswith("thread_history_1.sqlite") for name in owner_changed):
                    raise RuntimeError("New owner turn did not change paginated history")
                old_page_rejected = False
                try:
                    guarded_page(root, helper_binary, thread_id, first_after)
                except StalePageError:
                    old_page_rejected = True
                if not old_page_rejected:
                    raise RuntimeError("Prior page source version was accepted after an owner turn")
                second, second_before, second_after = guarded_page(root, helper_binary, thread_id)
                second_text = json.dumps(second)
                if first_label not in second_text or second_label not in second_text:
                    raise RuntimeError("New owner turn did not appear without a snapshot refresh")
                if len(first.get("data", [])) != 1 or len(second.get("data", [])) != 2:
                    raise RuntimeError("Unexpected saved paginated turn count")
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited before second read completed")
                await rpc.close()
                print(json.dumps({"sourceCommit": source_commit, "ownerVersion": version,
                    "ownerSha256": OWNER_SHA256,
                    "helperSha256": HELPER_SHA256, "ownerConnectedDuringBothReads": True,
                    "firstPageTurns": len(first["data"]), "secondPageTurns": len(second["data"]),
                    "newCompletedOwnerTurnVisible": True, "manualPageSnapshotRefresh": False,
                    "oldPageVersionRejected": old_page_rejected,
                    "ownerChangedFilesBetweenReads": owner_changed,
                    "firstReadChangedFiles": [name for name in first_before
                                              if first_before[name] != first_after[name]],
                    "secondReadChangedFiles": [name for name in second_before
                                               if second_before[name] != second_after[name]],
                    "watchedFiles": sorted(second_after), "crossStoreAtomic": False,
                    "ownerModelRequests": len(requests),
                    "fileMetadata": {
                        "firstReadBefore": evidence_fingerprint(first_before),
                        "firstReadAfter": evidence_fingerprint(first_after),
                        "afterSecondOwnerTurn": evidence_fingerprint(after_owner),
                        "secondReadBefore": evidence_fingerprint(second_before),
                        "secondReadAfter": evidence_fingerprint(second_after)},
                    }, sort_keys=True), flush=True)
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
