#!/usr/bin/python3
"""Check one durable Codex turn across disposable authority restarts.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-authority-restart-probe.py

Both authorities use the same temporary home and a local mock model. The
person's Desktop, profile, account, projects and apps are not opened.
"""

import http.server
import json
import runpy
import subprocess
import tempfile
import threading
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROUTING = runpy.run_path(str(HERE / "codex-exec-routing-probe.py"))
DYNAMIC = runpy.run_path(str(HERE / "codex-dynamic-tool-routing-probe.py"))
CODEX = ROUTING["CODEX"]
JsonRpc = ROUTING["JsonRpc"]
private_environment = ROUTING["private_environment"]
stop_process = ROUTING["stop_process"]
response_stream = DYNAMIC["response_stream"]
MARKER = "orbit_disposable_durable_turn"


def start_authority(directory, environment):
    child = subprocess.Popen([str(CODEX), "app-server", "--listen", "stdio://"],
                             cwd=directory, env=environment, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, bufsize=0)
    rpc = JsonRpc(child)
    rpc.call(1, "initialize", {"clientInfo": {"name": "orbit_restart_probe",
             "title": "Orbit restart probe", "version": "1"},
             "capabilities": {"experimentalApi": True}})
    rpc.send("initialized")
    return child, rpc


def main():
    if not CODEX.is_file():
        raise RuntimeError("Installed Codex CLI is unavailable")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-restart-", dir="/var/tmp") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        project = root / "project"
        authority.mkdir()
        project.mkdir()
        environment = private_environment(authority, "AUTHORITY_ONLY")
        requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                item = {"id": "durable_answer", "type": "message", "status": "completed",
                        "role": "assistant", "content": [{"type": "output_text",
                        "text": MARKER, "annotations": []}]}
                payload = response_stream("durable_response", item)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        worker = threading.Thread(target=model.serve_forever, daemon=True)
        worker.start()
        config = Path(environment["CODEX_HOME"]) / "config.toml"
        config.write_text('model = "gpt-5.1"\nmodel_provider = "mock"\n'
                          'web_search = "disabled"\n[model_providers.mock]\n'
                          'name = "Local Mock"\n'
                          f'base_url = "http://127.0.0.1:{model.server_port}/v1"\n'
                          'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
                          'supports_websockets = false\n')
        first = second = None
        try:
            first, rpc = start_authority(authority, environment)
            started = rpc.call(2, "thread/start", {"ephemeral": False,
                "model": "gpt-5.1", "modelProvider": "mock", "cwd": str(project),
                "approvalPolicy": "never", "sandbox": "read-only"})
            thread_id = started["thread"]["id"]
            rpc.call(3, "turn/start", {"threadId": thread_id, "input": [
                {"type": "text", "text": "Reply with the fixture marker."}]})
            rpc.wait_for_turn(thread_id)
            before = rpc.call(4, "thread/turns/list", {"threadId": thread_id, "limit": 10})
            before_ids = {turn["id"] for turn in before["data"]
                          if turn.get("status") == "completed"}
            if not before_ids or len(requests) != 1:
                raise RuntimeError("The temporary authority did not complete its turn")
            stop_process(first)
            first = None

            second, resumed = start_authority(authority, environment)
            read = resumed.call(2, "thread/read", {"threadId": thread_id,
                                                   "includeTurns": False})
            after = resumed.call(3, "thread/turns/list", {"threadId": thread_id,
                                                          "limit": 10})
            after_ids = {turn["id"] for turn in after["data"]
                         if turn.get("status") == "completed"}
            evidence = {"sameThreadAfterAuthorityRestart":
                        read["thread"]["id"] == thread_id,
                        "sameCompletedTurnAfterRestart": before_ids <= after_ids,
                        "modelRequests": len(requests)}
            print(json.dumps(evidence, sort_keys=True))
            assert evidence["sameThreadAfterAuthorityRestart"]
            assert evidence["sameCompletedTurnAfterRestart"]
            assert evidence["modelRequests"] == 1
        finally:
            stop_process(first)
            stop_process(second)
            model.shutdown()
            model.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    main()
