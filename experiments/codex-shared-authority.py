"""Probe two local clients against one Codex app-server using disposable state.

Run through Orbit's resource budget:
  bun run scripts/limited.ts /usr/bin/python3 experiments/codex-shared-authority.py

The child receives a temporary HOME and CODEX_HOME. The script never opens the
person's Codex profile or desktop app.
"""

import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import websockets


CLI = "/usr/lib/chatgpt/resources/codex"


async def request(connection, request_id, method, params, notifications):
    await connection.send(json.dumps({"id": request_id, "method": method, "params": params}))
    while True:
        message = json.loads(await asyncio.wait_for(connection.recv(), timeout=10))
        if message.get("id") == request_id:
            return message
        if isinstance(message.get("method"), str):
            notifications.append(message["method"])


async def main():
    if not Path(CLI).is_file():
        raise SystemExit("Installed Codex CLI is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-authority-") as raw:
        root = Path(raw)
        for name in ("home", "codex", "socket", "config", "data", "cache", "state", "runtime", "project"):
            (root / name).mkdir(mode=0o700)
        socket = root / "socket" / "app.sock"
        environment = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_RUNTIME_DIR": str(root / "runtime"),
            "LANG": "C.UTF-8",
            "RUST_LOG": "error",
        }
        authority = subprocess.Popen(
            [CLI, "app-server", "--listen", "unix://" + str(socket)],
            env=environment,
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            for _ in range(200):
                if socket.exists():
                    break
                if authority.poll() is not None:
                    raise RuntimeError("Disposable Codex authority exited before opening its socket")
                await asyncio.sleep(0.05)
            else:
                raise RuntimeError("Disposable Codex authority did not open its socket")
            await asyncio.sleep(0.15)
            async with (
                websockets.unix_connect(str(socket), uri="ws://localhost/rpc", compression=None) as first,
                websockets.unix_connect(str(socket), uri="ws://localhost/rpc", compression=None) as second,
            ):
                first_notifications = []
                second_notifications = []
                initialize = {
                    "clientInfo": {"name": "orbit-disposable-probe", "title": "Orbit Disposable Probe", "version": "1"},
                    "capabilities": {"experimentalApi": True},
                }
                first_result, second_result = await asyncio.gather(
                    request(first, 1, "initialize", initialize, first_notifications),
                    request(second, 1, "initialize", initialize, second_notifications),
                )
                if "result" not in first_result or "result" not in second_result:
                    raise RuntimeError("A disposable client could not initialize")
                await first.send(json.dumps({"method": "initialized"}))
                await second.send(json.dumps({"method": "initialized"}))
                started = await request(first, 2, "thread/start", {
                    "cwd": str(root / "project"),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                }, first_notifications)
                thread_id = started.get("result", {}).get("thread", {}).get("id")
                if not isinstance(thread_id, str):
                    raise RuntimeError("Disposable thread did not start")
                read = await request(second, 2, "thread/read", {
                    "threadId": thread_id,
                    "includeTurns": False,
                }, second_notifications)
                execution = await request(second, 3, "command/exec", {
                    "command": ["/usr/bin/python3", "-c", "import os; print(os.environ.get('HOME', ''))"],
                    "cwd": str(root / "project"),
                    "sandboxPolicy": {"type": "readOnly"},
                    "timeoutMs": 5000,
                }, second_notifications)
                result = {
                    "twoClientsInitialized": True,
                    "sameCodexHome": first_result["result"].get("codexHome") == second_result["result"].get("codexHome"),
                    "secondClientReadFirstThread": read.get("result", {}).get("thread", {}).get("id") == thread_id,
                    "secondClientSawStartNotification": "thread/started" in second_notifications,
                    "commandUsedAuthorityHome": execution.get("result", {}).get("stdout", "").strip() == str(root / "home"),
                    "readError": read.get("error", {}).get("message"),
                    "commandError": execution.get("error", {}).get("message"),
                }
                print(json.dumps(result, sort_keys=True))
                if not all(result[key] for key in (
                    "twoClientsInitialized", "sameCodexHome", "secondClientReadFirstThread",
                    "secondClientSawStartNotification", "commandUsedAuthorityHome",
                )):
                    raise RuntimeError("Shared authority probe did not meet its assertions")
        finally:
            if authority.poll() is None:
                os.killpg(authority.pid, signal.SIGTERM)
                try:
                    authority.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(authority.pid, signal.SIGKILL)
                    authority.wait(timeout=5)


if __name__ == "__main__":
    asyncio.run(main())
