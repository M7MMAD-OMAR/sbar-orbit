#!/usr/bin/python3
"""One disposable owner and two reopened private Codex UI reads."""

import asyncio
import base64
import datetime
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
import uuid
from pathlib import Path

import websockets

LIVE = runpy.run_path(str(Path(__file__).with_name("codex-paginated-live-owner-read.py")))
Client = LIVE["Client"]
fingerprint = LIVE["fingerprint"]
response_stream = LIVE["response_stream"]
SOURCE_COMMIT = LIVE["SOURCE_COMMIT"]
OWNER_SHA256 = LIVE["OWNER_SHA256"]
HELPER_SHA256 = LIVE["HELPER_SHA256"]


def jwt(claims):
    encoded = lambda value: base64.urlsafe_b64encode(json.dumps(value,
        separators=(",", ":")).encode()).decode().rstrip("=")
    return encoded({"alg": "none", "typ": "JWT"}) + "." + encoded(claims) + ".fixture"


def owner_command(root, binary, socket_directory):
    return ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--share-net",
            "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64", "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/run/user",
            "--dir", str(socket_directory.parent), "--bind", str(socket_directory),
            str(socket_directory), "--bind", str(root), "/fixture",
            "--ro-bind", str(binary), "/app-server", "--chdir", "/fixture/project",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", "/tmp", "--setenv", "CODEX_HOME", "/fixture",
            "--setenv", "XDG_CONFIG_HOME", "/fixture/config",
            "--setenv", "XDG_DATA_HOME", "/fixture/data",
            "--setenv", "XDG_CACHE_HOME", "/fixture/cache",
            "--setenv", "XDG_STATE_HOME", "/fixture/state",
            "--setenv", "XDG_RUNTIME_DIR", str(socket_directory),
            "--setenv", "MOCK_API_KEY", "disposable",
            "--setenv", "NO_PROXY", "127.0.0.1,localhost",
            "--", "/app-server", "--listen", "unix://" + str(socket_directory / "app.sock")]


async def main():
    source = Path(os.environ["ORBIT_CODEX_SOURCE_ROOT"]).resolve()
    owner_binary = Path(os.environ["ORBIT_CODEX_APP_SERVER_BINARY"]).resolve()
    helper_binary = Path(os.environ["ORBIT_CODEX_PAGE_HELPER_BINARY"]).resolve()
    copied_app = Path(os.environ["ORBIT_CODEX_COPIED_DESKTOP"]).resolve()
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() != SOURCE_COMMIT:
        raise RuntimeError("Unexpected disposable Codex source")
    for path, expected in ((owner_binary, OWNER_SHA256), (helper_binary, HELPER_SHA256)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Unexpected disposable Codex binary")
    if not str(copied_app).startswith("/var/tmp/codex-private-smoke-") or not copied_app.is_file():
        raise RuntimeError("Copied private Desktop is unavailable")
    output = Path(tempfile.mkdtemp(prefix="codex-live-ui-evidence-", dir="/var/tmp"))
    with tempfile.TemporaryDirectory(prefix="orbit-paginated-live-") as temporary:
        root = Path(temporary) / "fixture"
        root.mkdir(mode=0o700)
        for name in ("project", "config", "data", "cache", "state", "runtime"):
            (root / name).mkdir(mode=0o700)
        socket_directory = Path(tempfile.mkdtemp(prefix="orbit-codex-live-",
                                                  dir=f"/run/user/{os.getuid()}"))
        socket_directory.chmod(0o700)
        owner_socket = socket_directory / "app.sock"
        state_socket = socket_directory / "app.sock.state"
        project_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        state_data = {"local-projects": {project_id: {"id": project_id,
            "name": "Shared Fixture Project", "rootPaths": ["/fixture/project"],
            "createdAt": now, "updatedAt": now}}, "project-order": [project_id]}
        requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/backend-api/wham/accounts/check":
                    body = {"accounts": [{"id": "fixture_selected", "plan_type": "plus",
                        "workspace_backend_origin": "https://fixture.invalid",
                        "account_routing_override": "NO_CONSTRAINT"}],
                        "default_account_id": "fixture_selected",
                        "account_ordering": ["fixture_selected"]}
                elif self.path == "/backend-api/wham/config/bundle":
                    body = {"requirements_toml": {}}
                else:
                    self.send_error(404)
                    return
                payload = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                if self.path != "/v1/responses":
                    self.send_error(404)
                    return
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                answer = ("Orbit completed fixture answer" if len(requests) == 1
                          else "Owner second answer became visible")
                payload = response_stream(len(requests)).replace(b'"text": "done"',
                    ('"text": "' + answer + '"').encode())
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        port = model.server_address[1]
        root.joinpath("config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            f'chatgpt_base_url = "http://127.0.0.1:{port}/backend-api/"\n'
            '[model_providers.mock]\nname = "Local Mock"\nrequires_openai_auth = true\n'
            f'base_url = "http://127.0.0.1:{port}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\n')
        claims = {"exp": int(time.time()) + 86400, "iat": int(time.time()),
            "sub": "fixture-user", "https://api.openai.com/profile": {
                "email": "orbit-owner" + chr(64) + "fixture.invalid", "name": "Orbit Fixture Owner"},
            "https://api.openai.com/auth": {"chatgpt_user_id": "fixture-user",
                "user_id": "fixture-user", "chatgpt_plan_type": "plus"}}
        token = jwt(claims)
        (root / "auth.json").write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {
            "id_token": token, "access_token": token,
            "refresh_token": "fixture-refresh-unusable", "account_id": "fixture_selected"},
            "last_refresh": datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        (root / "auth.json").chmod(0o600)
        pref = output / "dconf"
        pref.mkdir()
        keyfiles = output / "keyfiles"
        keyfiles.mkdir()
        (keyfiles / "prefs").write_text("[org/gnome/desktop/interface]\n"
            "color-scheme='prefer-dark'\ngtk-theme='adw-gtk3-dark'\n")
        subprocess.run(["dconf", "compile", str(pref / "user"), str(keyfiles)], check=True)

        async def state_client(reader, writer):
            try:
                while line := await reader.readline():
                    request = json.loads(line)
                    method = request.get("method")
                    if method == "hello":
                        stat = root.stat()
                        result = {"version": 1, "ownerCodexHome": str(root),
                                  "ownerIdentity": {"dev": stat.st_dev, "ino": stat.st_ino}}
                    elif method == "snapshot":
                        result = state_data
                    elif method == "read":
                        result = state_data.get(request.get("params", {}).get("key"))
                    else:
                        result = None
                    writer.write((json.dumps({"id": request.get("id"), "result": result}) + "\n").encode())
                    await writer.drain()
            finally:
                writer.close()

        state_server = await asyncio.start_unix_server(state_client, str(state_socket))
        state_socket.chmod(0o600)
        owner = subprocess.Popen(owner_command(root, owner_binary, socket_directory),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 12
            while not owner_socket.exists() and time.monotonic() < deadline:
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner exited: " +
                                       owner.stderr.read(1024).decode(errors="replace"))
                await asyncio.sleep(0.05)
            if not owner_socket.exists():
                raise TimeoutError("Fake owner socket did not open")
            owner_socket.chmod(0o600)
            async with websockets.unix_connect(str(owner_socket), uri="ws://localhost/rpc",
                                              compression=None) as connection:
                rpc = Client(connection)
                await rpc.initialize()
                account = await rpc.call("account/read", {"refreshToken": False})
                routing = account.get("workspaceRouting") or {}
                if routing.get("chatgptAccountId") != "fixture_selected":
                    raise RuntimeError("Fake account workspace routing unavailable")
                started = await rpc.call("thread/start", {"cwd": "/fixture/project",
                    "model": "gpt-5.1", "modelProvider": "mock",
                    "approvalPolicy": "never", "sandbox": "read-only"})
                thread_id = started["thread"]["id"]
                await rpc.turn(thread_id, "Private fixture conversation")
                raw_metadata = await rpc.call("thread/read", {"threadId": thread_id,
                    "includeTurns": False})
                raw_thread = raw_metadata.get("thread") or {}
                raw_project_id = raw_thread.get("projectId")
                (output / "raw-owner-metadata.json").write_text(json.dumps({
                    "projectId": raw_project_id, "cwd": raw_thread.get("cwd"),
                    "name": raw_thread.get("name"), "historyMode": raw_thread.get("historyMode"),
                    "pathPresent": raw_thread.get("path") is not None}))
                first_source = fingerprint(root)
                first_count = len(requests)
                first_ui = await run_ui(owner_socket, root, helper_binary, copied_app,
                                        pref / "user", output, "first", thread_id)
                if "Orbit completed fixture answer" not in first_ui["screenshotText"]:
                    raise RuntimeError("First private UI did not show the initial owner answer")
                after_first_read = fingerprint(root)
                if first_source != after_first_read:
                    raise RuntimeError("First private UI read changed live owner source")
                await rpc.turn(thread_id, "Owner fixture second live turn")
                second_source = fingerprint(root)
                changed = [key for key in first_source if first_source[key] != second_source.get(key)]
                if not any(key.startswith("thread_history_1.sqlite") for key in changed):
                    raise RuntimeError("Owner did not update live history WAL")
                stale = subprocess.run(["/usr/bin/python3",
                    str(Path(__file__).with_name("codex-paginated-live-page.py")),
                    str(root), str(helper_binary)], input=json.dumps({"method": "thread/turns/list",
                    "params": {"threadId": thread_id, "readOnly": True, "limit": 5,
                    "cursor": None, "sortDirection": "asc", "itemsView": "full"},
                    "fixtureExpectedFingerprint": first_source}), capture_output=True, text=True, timeout=6)
                if stale.returncode == 0 or "STALE: previous page version changed" not in stale.stderr:
                    raise RuntimeError("Previous page version was not rejected as stale")
                second_ui = await run_ui(owner_socket, root, helper_binary, copied_app,
                                         pref / "user", output, "second", thread_id)
                if "Owner fixture second live turn" not in second_ui["screenshotText"] or \
                   "Owner second answer became visible" not in second_ui["screenshotText"]:
                    raise RuntimeError("Reopened private UI did not show the completed live turn")
                after_reads = fingerprint(root)
                if second_source != after_reads:
                    raise RuntimeError("Private UI read changed live owner source")
                if owner.poll() is not None:
                    raise RuntimeError("Fake owner stopped before private UI reopened")
                await rpc.close()
                print(json.dumps({"ownerConnectedThroughBothUIs": True, "firstScreenshot":
                    first_ui["screenshot"], "secondScreenshot": second_ui["screenshot"],
                    "secondScrolledUpScreenshot": second_ui["scrolledUp"],
                    "secondScrolledDownScreenshot": second_ui["scrolledDown"],
                    "firstTurnVisibleAfterScroll": "Orbit completed fixture answer" in
                        (second_ui["scrolledUpText"] or ""),
                    "secondTurnVisibleAfterScroll": "Owner second answer became visible" in
                        (second_ui["scrolledDownText"] or ""),
                    "firstDesktopPid": first_ui["desktopPid"],
                    "secondDesktopPid": second_ui["desktopPid"],
                    "secondDesktopPidStartTick": second_ui["desktopPidStartTick"],
                    "rawProjectId": raw_project_id,
                    "projectedProjectId": second_ui["projectedMetadata"]["projectId"],
                    "projectedCwd": second_ui["projectedMetadata"]["cwd"],
                    "firstPrivateAuthFile": first_ui["privateAuthFile"],
                    "secondPrivateAuthFile": second_ui["privateAuthFile"],
                    "firstOwnerModelRequests": first_count, "secondOwnerModelRequests": len(requests),
                    "ownerChangedFilesBetweenTurns": changed,
                    "firstReadChangedFiles": [], "secondReadChangedFiles": [],
                    "oldPageRejectedStale": True, "ownerSourceAfterSecondTurn": second_source,
                    "ownerSourceAfterPrivateRead": after_reads, "evidenceDirectory": str(output)},
                    sort_keys=True), flush=True)
        finally:
            if owner.poll() is None:
                os.killpg(owner.pid, signal.SIGTERM)
                try:
                    owner.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(owner.pid, signal.SIGKILL)
                    owner.wait(timeout=3)
            state_server.close()
            await state_server.wait_closed()
            model.shutdown()
            model.server_close()
            try:
                state_socket.unlink()
                owner_socket.unlink(missing_ok=True)
                socket_directory.rmdir()
            except OSError:
                pass


async def run_ui(socket, root, binary, app, preferences, output, label, thread_id):
    command = ["bun", str(Path(__file__).with_name("codex-paginated-live-private-ui.ts")),
               str(socket), str(root), str(binary), str(app), str(preferences), str(output), label,
               thread_id]
    completed = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True,
                                        timeout=85, cwd=str(Path(__file__).parent.parent))
    if completed.returncode:
        raise RuntimeError(f"Private UI {label} failed: " + completed.stderr[-3000:])
    return json.loads(completed.stdout.strip().splitlines()[-1])


if __name__ == "__main__":
    asyncio.run(main())
