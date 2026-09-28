#!/usr/bin/python3
"""Check whether two Codex threads can use different bound Orbit MCP adapters.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bound-mcp-routing-probe.py

Everything is disposable: two thread IDs, two Orbit session IDs, a fake broker,
and an empty Codex home. No account, desktop application, or model call is used.
"""

import http.server
import json
import runpy
import shutil
import socketserver
import subprocess
import tempfile
import threading
from pathlib import Path


helpers = runpy.run_path(str(Path(__file__).with_name("codex-mcp-routing-probe.py")))
CODEX = helpers["CODEX"]
JsonRpc = helpers["JsonRpc"]
private_environment = helpers["private_environment"]
stop_process = helpers["stop_process"]
PROJECT = Path(__file__).resolve().parents[1]
SESSION_MCP = PROJECT / "src" / "session-mcp.ts"
FIRST_SESSION = "11111111-1111-4111-8111-111111111111"
SECOND_SESSION = "22222222-2222-4222-8222-222222222222"


class UnixHttpServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


class BrokerHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.server.requests.append(body)
        reply = json.dumps({"ok": True, "result": {"sessionId": body["params"]["sessionId"]}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


def invoke(rpc, request_id, thread_id):
    result = rpc.call(request_id, "mcpServer/tool/call", {
        "threadId": thread_id, "server": "orbit_private", "tool": "orbit_act",
        "arguments": {"requestId": str(request_id), "action": {
            "type": "pointer", "x": 5, "y": 6,
        }},
    })
    return json.loads(result["content"][0]["text"])["sessionId"]


def main():
    bun = shutil.which("bun")
    if not CODEX.is_file() or not bun or not SESSION_MCP.is_file():
        raise RuntimeError("Codex, Bun or the bound adapter is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-bound-mcp-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        authority.mkdir()
        socket = root / "broker.sock"
        broker = UnixHttpServer(str(socket), BrokerHandler)
        broker.requests = []
        worker = threading.Thread(target=broker.serve_forever, daemon=True)
        worker.start()
        environment = private_environment(authority, "AUTHORITY_ONLY")
        child = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "stdio://"],
            cwd=authority, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            rpc = JsonRpc(child)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_bound_mcp_probe", "title": "Orbit bound MCP probe", "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.notify("initialized")
            threads = []
            for index, session_id in enumerate((FIRST_SESSION, SECOND_SESSION)):
                thread = rpc.call(2 + index, "thread/start", {
                    "ephemeral": True,
                    "config": {"mcp_servers": {"orbit_private": {
                        "command": bun, "args": [str(SESSION_MCP)],
                        "env": {"ORBIT_SOCKET": str(socket),
                                "ORBIT_SESSION_ID": session_id,
                                "ORBIT_USAGE_DIR": str(root / "usage")},
                    }}},
                })["thread"]
                threads.append(thread["id"])
            first = invoke(rpc, 4, threads[0])
            second = invoke(rpc, 5, threads[1])
            first_again = invoke(rpc, 6, threads[0])
            delivered = [request["params"]["sessionId"] for request in broker.requests]
            result = {"first": first, "second": second,
                      "firstAgain": first_again, "delivered": delivered}
            print(json.dumps(result, sort_keys=True))
            assert [first, second, first_again] == [FIRST_SESSION, SECOND_SESSION, FIRST_SESSION]
            assert delivered == [FIRST_SESSION, SECOND_SESSION, FIRST_SESSION]
        finally:
            stop_process(child)
            broker.shutdown()
            broker.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    main()
