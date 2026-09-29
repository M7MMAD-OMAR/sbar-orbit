#!/usr/bin/python3
"""Serve one fixture response inside the owner's private network namespace."""

import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


MARKER = "Orbit completed fixture answer"
TOOL_RESULT = "Orbit toy action completed in private fixture"
PORT = 43837


class Model(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/backend-api/wham/accounts/check":
            body = {"accounts": [{"id": "fixture_selected", "plan_type": "plus",
                "workspace_backend_origin": "https://fixture.invalid",
                "account_routing_override": "NO_CONSTRAINT"}],
                "default_account_id": "fixture_selected", "account_ordering": ["fixture_selected"]}
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
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        tools = request.get("tools", [])
        record = os.environ.get("ORBIT_MODEL_RECORD")
        names = {tool.get("name"): [nested.get("name") for nested in tool.get("tools", [])]
                 if isinstance(tool.get("tools"), list) else None for tool in tools}
        previous = json.loads(Path(record).read_text()) if record and Path(record).is_file() else {"requests": []}
        tool_outputs = [item for item in request.get("input", []) if isinstance(item, dict)
                        and item.get("type") == "function_call_output"
                        and item.get("call_id") == "fixture_orbit_call"]
        input_text = json.dumps(tool_outputs, separators=(",", ":"))
        result_seen = TOOL_RESULT in input_text if os.environ.get("ORBIT_EXPECT_ORBIT_TOOL") == "1" else (
            "applied" in input_text and "true" in input_text)
        previous["requests"].append({"toolCount": len(tools), "toolNames": names,
                                     "toolResultSeen": result_seen})
        previous["toolCount"] = len(tools)
        if record:
            Path(record).write_text(json.dumps(previous))
        if os.environ.get("ORBIT_EXPECT_EMPTY_TOOLS") == "1" and tools:
            self.send_error(400, "Restricted fixture thread exposed model tools")
            return
        positive_tool = os.environ.get("ORBIT_EXPECT_ORBIT_TOOL") == "1" or os.environ.get("ORBIT_EXPECT_REAL_ORBIT") == "1"
        if positive_tool and len(previous["requests"]) == 1:
            if names != {"mcp__orbit_private": ["orbit_act"]}:
                self.send_error(400, "Positive fixture exposed a different tool inventory")
                return
            arguments = {"requestId": "positive-tool-fixture"}
            if os.environ.get("ORBIT_EXPECT_REAL_ORBIT") == "1":
                arguments = {"requestId": "real-orbit-pointer-fixture",
                             "action": {"type": "pointer", "x": 317, "y": 219}}
            item = {"id": "fixture_orbit_tool", "type": "function_call", "status": "completed",
                    "call_id": "fixture_orbit_call", "namespace": "mcp__orbit_private",
                    "name": "orbit_act", "arguments": json.dumps(arguments)}
        else:
            if positive_tool and not previous["requests"][-1]["toolResultSeen"]:
                self.send_error(400, "Toy action result did not reach the model")
                return
            answer = [MARKER, "Orbit owner preflight answer", "Orbit private follow-up answer",
                      "Orbit owner inventory answer"][min(len(previous["requests"]) - 1, 3)]
            item = {"id": "fixture_answer", "type": "message", "status": "completed",
                    "role": "assistant", "content": [{"type": "output_text",
                    "text": answer, "annotations": []}]}
        response_id = f"fixture_response_{len(previous['requests'])}"
        events = [
            {"type": "response.output_item.added", "response_id": response_id,
             "output_index": 0, "item": {**item, "content": [], "status": "in_progress"}},
            {"type": "response.output_item.done", "response_id": response_id,
             "output_index": 0, "item": item},
            {"type": "response.completed", "response": {
                "id": response_id, "object": "response", "created_at": int(time.time()),
                "status": "completed", "model": request.get("model", "gpt-5.1"),
                "output": [item], "usage": {"input_tokens": 1,
                "output_tokens": 4, "total_tokens": 5}}},
        ]
        payload = ("".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                           for event in events) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Model)
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
try:
    raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)
finally:
    server.shutdown()
    server.server_close()
    worker.join(timeout=2)
