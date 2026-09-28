"""Prove a host Unix client can use a private Codex authority and executor.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex_private_unix_client_probe.py

All Codex homes and the model are disposable. The person's Desktop and profile
are never opened. This tests transport, not the installed Desktop integration.
"""

import asyncio
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

import websockets


CODEX = Path("/usr/lib/chatgpt/resources/codex")
EXECUTOR_MARKER = "orbit_private_executor"
AUTHORITY_MARKER = "orbit_private_authority"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def private_environment(directory, marker):
    home = directory / "home"
    (home / ".codex").mkdir(parents=True)
    runtime = directory / "runtime"
    runtime.mkdir(mode=0o700)
    return {
        "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
        "HOME": str(home), "CODEX_HOME": str(home / ".codex"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_RUNTIME_DIR": str(runtime),
        "ORBIT_EXEC_MARKER": marker, "MOCK_API_KEY": "disposable-key",
        "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost",
    }


def stop_process(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)


def wait_for_listener(port, child):
    for _ in range(100):
        if child.poll() is not None:
            raise RuntimeError(f"Disposable exec-server exited with {child.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError("Disposable exec-server listener did not start")


class MockModel(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        input_text = json.dumps(request.get("input", []))
        requests = self.server.requests
        requests.append({
            "executorSeen": EXECUTOR_MARKER in input_text,
            "authoritySeen": AUTHORITY_MARKER in input_text,
        })
        response_id = f"resp_disposable_{len(requests)}"
        if len(requests) == 1:
            arguments = json.dumps({
                "cmd": 'printf %s "$ORBIT_EXEC_MARKER"',
                "workdir": str(self.server.executor_directory),
                "yield_time_ms": 1000,
            })
            item = {
                "id": "fc_disposable", "type": "function_call", "status": "completed",
                "call_id": "call_disposable", "name": "exec_command",
                "arguments": arguments,
            }
            events = [
                {"type": "response.output_item.added", "response_id": response_id,
                 "output_index": 0, "item": {**item, "arguments": "", "status": "in_progress"}},
                {"type": "response.function_call_arguments.delta", "response_id": response_id,
                 "item_id": item["id"], "output_index": 0, "delta": arguments},
                {"type": "response.function_call_arguments.done", "response_id": response_id,
                 "item_id": item["id"], "output_index": 0, "arguments": arguments},
                {"type": "response.output_item.done", "response_id": response_id,
                 "output_index": 0, "item": item},
            ]
        else:
            item = {
                "id": "msg_disposable", "type": "message", "status": "completed",
                "role": "assistant", "content": [
                    {"type": "output_text", "text": "done", "annotations": []}],
            }
            events = [
                {"type": "response.output_item.added", "response_id": response_id,
                 "output_index": 0, "item": {**item, "content": [], "status": "in_progress"}},
                {"type": "response.output_item.done", "response_id": response_id,
                 "output_index": 0, "item": item},
            ]
        events.append({
            "type": "response.completed",
            "response": {
                "id": response_id, "object": "response",
                "created_at": int(time.time()), "status": "completed",
                "model": request.get("model", "gpt-5.1"), "output": [item],
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
            },
        })
        payload = (
            "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
            + "data: [DONE]\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def log_message(self, *_args):
        pass


def inner(root, executor_port):
    subprocess.run(["/usr/sbin/ip", "link", "set", "lo", "up"], check=True)
    authority = root / "authority"
    executor = root / "executor"
    authority.mkdir()
    executor.mkdir()
    socket_path = root / "app.sock"
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
    model.requests = []
    model.executor_directory = executor
    threading.Thread(target=model.serve_forever, daemon=True).start()
    exec_child = app_child = None
    try:
        exec_child = subprocess.Popen(
            [str(CODEX), "exec-server", "--listen", f"ws://127.0.0.1:{executor_port}"],
            cwd=executor, env=private_environment(executor, EXECUTOR_MARKER),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        wait_for_listener(executor_port, exec_child)
        app_env = private_environment(authority, AUTHORITY_MARKER)
        (Path(app_env["CODEX_HOME"]) / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model.server_port}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        app_child = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "unix://" + str(socket_path)],
            cwd=authority, env=app_env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            if socket_path.exists():
                break
            if app_child.poll() is not None:
                raise RuntimeError(f"Disposable app-server exited with {app_child.returncode}")
            time.sleep(0.05)
        else:
            raise TimeoutError("Disposable app-server Unix socket did not start")
        (root / "ready.json").write_text(json.dumps({
            "execServerPid": exec_child.pid, "appServerPid": app_child.pid,
            "executorPort": executor_port, "socket": str(socket_path),
        }))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (root / "done").exists():
                (root / "model.json").write_text(json.dumps(model.requests))
                return
            if exec_child.poll() is not None or app_child.poll() is not None:
                raise RuntimeError("Disposable Codex service exited before the host client finished")
            time.sleep(0.05)
        raise TimeoutError("Host Unix client did not finish")
    finally:
        stop_process(app_child)
        stop_process(exec_child)
        model.shutdown()
        model.server_close()


def listener_held_by(pid, port):
    suffix = f":{port:04X}"
    rows = Path(f"/proc/{pid}/net/tcp").read_text().splitlines()[1:]
    inodes = {
        columns[9] for row in rows if (columns := row.split())[1].endswith(suffix)
        and columns[3] == "0A"
    }
    return bool(inodes) and any(
        os.readlink(fd) in {f"socket:[{inode}]" for inode in inodes}
        for fd in Path(f"/proc/{pid}/fd").iterdir()
    )


async def request(connection, request_id, method, params, events):
    await connection.send(json.dumps({"id": request_id, "method": method, "params": params}))
    while True:
        message = json.loads(await asyncio.wait_for(connection.recv(), timeout=12))
        if message.get("id") == request_id:
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message["result"]
        events.append(message)


async def host_client(root, info):
    events = []
    async with websockets.unix_connect(info["socket"], uri="ws://localhost/rpc", compression=None) as connection:
        await request(connection, 1, "initialize", {
            "clientInfo": {"name": "orbit_host_unix_probe", "title": "Orbit Host Unix Probe", "version": "1"},
            "capabilities": {"experimentalApi": True},
        }, events)
        await connection.send(json.dumps({"method": "initialized"}))
        await request(connection, 2, "environment/add", {
            "environmentId": "private", "execServerUrl": f"ws://127.0.0.1:{info['executorPort']}",
        }, events)
        started = await request(connection, 3, "thread/start", {
            "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
            "environments": [{"environmentId": "private", "cwd": str(root / "executor")}],
            "cwd": str(root / "executor"), "approvalPolicy": "never", "sandbox": "read-only",
        }, events)
        thread = started["thread"]
        if thread["environments"][0]["environmentId"] != "private":
            raise AssertionError("Thread did not select the private executor")
        await request(connection, 4, "turn/start", {
            "threadId": thread["id"],
            "input": [{"type": "text", "text": "Run a diagnostic marker command."}],
        }, events)
        deadline = time.monotonic() + 20
        while not any(event.get("method") == "turn/completed" for event in events):
            if time.monotonic() > deadline:
                raise TimeoutError("Host client did not receive turn completion")
            events.append(json.loads(await asyncio.wait_for(connection.recv(), timeout=5)))
        completed = next(event["params"]["turn"] for event in events
                         if event.get("method") == "turn/completed")
        commands = [event["params"]["item"] for event in events
                    if event.get("method") == "item/completed"
                    and event.get("params", {}).get("item", {}).get("type") == "commandExecution"]
        if completed["status"] != "completed" or len(commands) != 1:
            raise AssertionError(f"Selected turn failed: {completed}, {commands}")
        if commands[0]["exitCode"] != 0 or commands[0]["aggregatedOutput"] != EXECUTOR_MARKER:
            raise AssertionError(f"Shell command ran in the wrong environment: {commands[0]}")
        return thread["id"]


def outer():
    if not CODEX.is_file() or not shutil.which("unshare"):
        raise RuntimeError("Installed Codex CLI or unshare is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-private-unix-") as temporary:
        root = Path(temporary)
        port = free_port()
        child = subprocess.Popen(
            ["unshare", "--user", "--map-root-user", "--net", sys.executable,
             str(Path(__file__).resolve()), "--inner", str(root), str(port)],
            cwd=root, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 15
            while not (root / "ready.json").exists():
                if child.poll() is not None:
                    raise RuntimeError(f"Private service exited: {child.stderr.read().decode()}")
                if time.monotonic() > deadline:
                    raise TimeoutError("Private service did not start")
                time.sleep(0.05)
            info = json.loads((root / "ready.json").read_text())
            host_namespace = os.readlink("/proc/self/ns/net")
            app_namespace = os.readlink(f"/proc/{info['appServerPid']}/ns/net")
            exec_namespace = os.readlink(f"/proc/{info['execServerPid']}/ns/net")
            if app_namespace == host_namespace or exec_namespace != app_namespace:
                raise AssertionError("Codex services were not in the same private network")
            if not listener_held_by(info["execServerPid"], port):
                raise AssertionError("Executor did not own the private listener")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    raise AssertionError("Host sibling reached the private executor")
            except (ConnectionRefusedError, TimeoutError, OSError):
                pass
            thread_id = asyncio.run(host_client(root, info))
            (root / "done").write_text("ok")
            _, stderr = child.communicate(timeout=10)
            if child.returncode != 0:
                raise RuntimeError(f"Private service failed: {stderr.decode(errors='replace')}")
            requests = json.loads((root / "model.json").read_text())
            if len(requests) != 2 or not requests[1]["executorSeen"] or requests[1]["authoritySeen"]:
                raise AssertionError(f"Mock model did not receive executor-only output: {requests}")
            print(json.dumps({
                "hostUnixClientSelectedPrivateThread": bool(thread_id),
                "modelDrivenShellRanInPrivateExecutor": True,
                "hostSiblingCouldNotReachExecutorTcp": True,
                "appServerAndExecutorSharedPrivateNetwork": True,
                "originalProfileUsed": False,
                "desktopAppUsed": False,
            }, sort_keys=True))
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.communicate(timeout=3)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--inner":
        inner(Path(sys.argv[2]), int(sys.argv[3]))
    else:
        outer()
