#!/usr/bin/python3
"""Route a disposable model-selected Codex MCP call into one bound Orbit session.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bound-mcp-model-probe.py

The model is a loopback fixture. Codex state and the broker are temporary.
"""

import http.server
import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


project = Path(__file__).resolve().parents[1]
bound = runpy.run_path(str(Path(__file__).with_name("codex-bound-mcp-routing-probe.py")))
shell = runpy.run_path(str(Path(__file__).with_name("codex-exec-routing-probe.py")))
dynamic = runpy.run_path(str(Path(__file__).with_name("codex-dynamic-tool-routing-probe.py")))
CODEX = shell["CODEX"]
JsonRpc = shell["JsonRpc"]
private_environment = shell["private_environment"]
stop_process = shell["stop_process"]
free_port = shell["free_port"]
response_stream = dynamic["response_stream"]
UnixHttpServer = bound["UnixHttpServer"]
BrokerHandler = bound["BrokerHandler"]
SESSION_ID = bound["FIRST_SESSION"]
SESSION_MCP = project / "src" / "session-mcp.ts"


def main():
    sandbox_mode = "read-only" if "--read-only" in sys.argv[1:] else "danger-full-access"
    bun = shutil.which("bun")
    if not CODEX.is_file() or not bun or not SESSION_MCP.is_file():
        raise RuntimeError("Codex, Bun or the bound adapter is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-bound-model-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        authority.mkdir()
        socket = root / "broker.sock"
        broker = UnixHttpServer(str(socket), BrokerHandler)
        broker.requests = []
        broker_worker = threading.Thread(target=broker.serve_forever, daemon=True)
        broker_worker.start()
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                tools = body.get("tools", [])
                names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
                namespace = next((tool for tool in tools if isinstance(tool, dict)
                                  and tool.get("name") == "mcp__orbit_private"), None)
                available = ([tool.get("name") for tool in namespace.get("tools", [])]
                             if namespace else [])
                model_requests.append({"names": names, "tools": tools,
                                       "input": body.get("input", [])})
                number = len(model_requests)
                if number == 1:
                    if "orbit_act" in available:
                        item = {"id": "model_tool", "type": "function_call",
                                "status": "completed", "call_id": "model_orbit_call",
                                "namespace": "mcp__orbit_private",
                                "name": "orbit_act", "arguments": json.dumps({
                                    "requestId": "model-step",
                                    "action": {"type": "pointer", "x": 5, "y": 6},
                                })}
                    else:
                        item = {"id": "model_no_tool", "type": "message",
                                "status": "completed", "role": "assistant", "content": [
                                    {"type": "output_text", "text": "no tool", "annotations": []}]}
                else:
                    item = {"id": "model_answer", "type": "message", "status": "completed",
                            "role": "assistant", "content": [{"type": "output_text",
                            "text": "done", "annotations": []}]}
                payload = response_stream(f"response_{number}", item)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model_port = free_port()
        model = http.server.ThreadingHTTPServer(("127.0.0.1", model_port), MockModel)
        model_worker = threading.Thread(target=model.serve_forever, daemon=True)
        model_worker.start()
        environment = private_environment(authority, "AUTHORITY_ONLY")
        (Path(environment["CODEX_HOME"]) / "config.toml").write_text(
            'model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
            '[model_providers.mock]\nname = "Local Mock"\n'
            f'base_url = "http://127.0.0.1:{model_port}/v1"\n'
            'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
            'supports_websockets = false\n'
        )
        child = subprocess.Popen([str(CODEX), "app-server", "--listen", "stdio://"],
                                 cwd=authority, env=environment, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 bufsize=0, start_new_session=True)
        try:
            rpc = JsonRpc(child)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_bound_model_probe", "title": "Orbit bound model probe",
                "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.send("initialized")
            thread = rpc.call(2, "thread/start", {
                "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
                "cwd": str(authority), "approvalPolicy": "never",
                "sandbox": sandbox_mode, "config": {"mcp_servers": {
                    "orbit_private": {"command": bun, "args": [str(SESSION_MCP)],
                                      "env": {"ORBIT_SOCKET": str(socket),
                                              "ORBIT_SESSION_ID": SESSION_ID,
                                              "ORBIT_USAGE_DIR": str(root / "usage")}},
                }},
            })["thread"]
            rpc.call(3, "turn/start", {"threadId": thread["id"],
                                       "input": [{"type": "text", "text": "Call the private Orbit action tool."}]})
            rpc.wait_for_turn(thread["id"])
            delivered = [request["params"]["sessionId"] for request in broker.requests]
            followup = json.dumps(model_requests[1]["input"]) if len(model_requests) > 1 else ""
            first_namespace = next((tool for tool in model_requests[0]["tools"]
                                    if tool.get("name") == "mcp__orbit_private"), None)
            tool_events = [message.get("params", {}).get("item") for message in rpc.messages
                           if message.get("method") == "item/completed"
                           and message.get("params", {}).get("threadId") == thread["id"]
                           and message.get("params", {}).get("item", {}).get("type")
                           == "mcpToolCall"]
            result = {"advertised": first_namespace is not None and
                      any(tool.get("name") == "orbit_act"
                          for tool in first_namespace.get("tools", [])),
                      "sandbox": sandbox_mode,
                      "modelRequests": len(model_requests),
                      "delivered": delivered,
                      "followupSawSession": SESSION_ID in followup,
                      "mcpCallStatus": tool_events[0]["status"] if tool_events else None}
            print(json.dumps(result, sort_keys=True))
            assert result["advertised"] is True
            assert result["modelRequests"] == 2
            if sandbox_mode == "read-only":
                assert result["delivered"] == []
                assert result["followupSawSession"] is False
                assert result["mcpCallStatus"] == "failed"
            else:
                assert result["delivered"] == [SESSION_ID]
                assert result["followupSawSession"] is True
                assert result["mcpCallStatus"] == "completed"
        finally:
            stop_process(child)
            model.shutdown()
            model.server_close()
            model_worker.join(timeout=2)
            broker.shutdown()
            broker.server_close()
            broker_worker.join(timeout=2)


if __name__ == "__main__":
    main()
