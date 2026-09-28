#!/usr/bin/python3
"""Capture model-visible tools for private Codex threads on one test authority.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-model-tool-inventory-probe.py

The model, broker, Codex home, plugin marketplace and threads are disposable.
The installed plugin payloads are copied read only. No personal app is opened.
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


PROJECT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).parent
SHELL = runpy.run_path(str(HERE / "codex-exec-routing-probe.py"))
DYNAMIC = runpy.run_path(str(HERE / "codex-dynamic-tool-routing-probe.py"))
BOUND = runpy.run_path(str(HERE / "codex-bound-mcp-routing-probe.py"))
BUNDLED = runpy.run_path(str(HERE / "codex-bundled-tool-boundary-probe.py"))
CODEX = SHELL["CODEX"]
JsonRpc = SHELL["JsonRpc"]
private_environment = SHELL["private_environment"]
stop_process = SHELL["stop_process"]
free_port = SHELL["free_port"]
response_stream = DYNAMIC["response_stream"]
UnixHttpServer = BOUND["UnixHttpServer"]
BrokerHandler = BOUND["BrokerHandler"]
SESSION_ID = BOUND["FIRST_SESSION"]
SESSION_MCP = PROJECT / "src" / "session-mcp.ts"
MARKETPLACE = BUNDLED["MARKETPLACE"]
plugin_command = BUNDLED["plugin_command"]
TOY_MCP = BUNDLED["TOY_MCP"]
wait_for_listener = BUNDLED["helpers"]["wait_for_listener"]
HOST_SERVERS = ("codex_app", "cua_repl", "node_repl")
PLUGIN_NAMES = ("codex-app-tools", "unified-computer-use", "browser", "chrome")


def inventory(tools):
    result = {}
    for tool in tools:
        name = tool.get("name")
        if not isinstance(name, str):
            continue
        nested = tool.get("tools")
        result[name] = sorted(item.get("name") for item in nested
                              if isinstance(item, dict) and isinstance(item.get("name"), str)) \
            if isinstance(nested, list) else None
    return dict(sorted(result.items()))


def copy_plugins(root, environment):
    marketplace = root / "marketplace"
    catalog = marketplace / ".agents" / "plugins"
    catalog.mkdir(parents=True)
    (marketplace / "plugins").mkdir()
    (catalog / "marketplace.json").write_text(json.dumps({
        "name": "orbit-disposable",
        "plugins": [{"name": name,
                     "source": {"source": "local", "path": f"./plugins/{name}"}}
                    for name in PLUGIN_NAMES],
    }))
    for name in PLUGIN_NAMES:
        shutil.copytree(MARKETPLACE / "plugins" / name,
                        marketplace / "plugins" / name)
    plugin_command(environment, "marketplace", "add", str(marketplace))
    for name in PLUGIN_NAMES:
        plugin_command(environment, "add", f"{name}@orbit-disposable")


def main():
    check_feature_flags = "--feature-flags" in sys.argv[1:]
    bun = shutil.which("bun")
    if not CODEX.is_file() or not MARKETPLACE.is_dir() or not bun or not SESSION_MCP.is_file():
        raise RuntimeError("Installed Codex, bundled plugins, Bun or Orbit adapter is missing")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-model-inventory-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        authority.mkdir()
        environment = private_environment(authority, "AUTHORITY_ONLY")
        copy_plugins(root, environment)
        model_requests = []

        class MockModel(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                visible = inventory(body.get("tools", []))
                model_requests.append({"tools": visible, "input": body.get("input", [])})
                number = len(model_requests)
                if number == 2 and "orbit_act" in visible.get("mcp__orbit_private", []):
                    item = {"id": "private_call", "type": "function_call",
                            "status": "completed", "call_id": "private_orbit_call",
                            "namespace": "mcp__orbit_private", "name": "orbit_act",
                            "arguments": json.dumps({
                                "requestId": "inventory-check",
                                "action": {"type": "pointer", "x": 5, "y": 6},
                            })}
                elif number == 4 and check_feature_flags and "exec_command" in visible:
                    item = {"id": "remote_call", "type": "function_call",
                            "status": "completed", "call_id": "remote_exec_call",
                            "name": "exec_command", "arguments": json.dumps({
                                "cmd": 'printf %s "$ORBIT_EXEC_MARKER"',
                                "workdir": str(root / "executor"),
                                "yield_time_ms": 1000,
                            })}
                else:
                    item = {"id": f"message_{number}", "type": "message",
                            "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": "done", "annotations": []}]}
                payload = response_stream(f"response_{number}", item)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, *_args):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", free_port()), MockModel)
        model_worker = threading.Thread(target=model.serve_forever, daemon=True)
        model_worker.start()
        broker_socket = root / "broker.sock"
        broker = UnixHttpServer(str(broker_socket), BrokerHandler)
        broker.requests = []
        broker_worker = threading.Thread(target=broker.serve_forever, daemon=True)
        broker_worker.start()
        config = Path(environment["CODEX_HOME"]) / "config.toml"
        with config.open("a") as output:
            output.write(
                '\nmodel = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n'
                '[model_providers.mock]\nname = "Local Mock"\n'
                f'base_url = "http://127.0.0.1:{model.server_address[1]}/v1"\n'
                'env_key = "MOCK_API_KEY"\nwire_api = "responses"\n'
                'supports_websockets = false\n'
                '[features]\nplugins = true\n'
            )
        toy = root / "toy_mcp.py"
        toy.write_text(TOY_MCP)
        transport = {"command": "/usr/bin/python3", "args": ["-u", str(toy)]}
        executor = None
        remote_port = None
        if check_feature_flags:
            executor_dir = root / "executor"
            executor_dir.mkdir()
            remote_port = free_port()
            executor = subprocess.Popen(
                [str(CODEX), "exec-server", "--listen",
                 f"ws://127.0.0.1:{remote_port}"],
                cwd=executor_dir,
                env=private_environment(executor_dir, "EXECUTOR_ONLY"),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
            wait_for_listener(remote_port, executor)
        child = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "stdio://"],
            cwd=authority, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0, start_new_session=True,
        )
        try:
            rpc = JsonRpc(child)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_model_inventory_probe",
                "title": "Orbit model inventory probe", "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.send("initialized")
            baseline = rpc.call(2, "thread/start", {
                "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
                "cwd": str(authority), "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "config": {"mcp_servers": {
                    name: {**transport, "enabled": True} for name in HOST_SERVERS
                }},
            })["thread"]
            rpc.call(3, "turn/start", {"threadId": baseline["id"], "input": [{
                "type": "text", "text": "Report baseline tool inventory fixture.",
            }]})
            rpc.wait_for_turn(baseline["id"])
            private = rpc.call(4, "thread/start", {
                "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
                "cwd": str(authority), "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "config": {"features": {"plugins": False}, "mcp_servers": {
                    **{name: {**transport, "enabled": False} for name in HOST_SERVERS},
                    "orbit_private": {"command": bun, "args": [str(SESSION_MCP)],
                                      "env": {"ORBIT_SOCKET": str(broker_socket),
                                              "ORBIT_SESSION_ID": SESSION_ID,
                                              "ORBIT_USAGE_DIR": str(root / "usage")}},
                }},
            })["thread"]
            rpc.call(5, "turn/start", {"threadId": private["id"], "input": [{
                "type": "text", "text": "Call private Orbit action fixture.",
            }]})
            rpc.wait_for_turn(private["id"])
            restricted = None
            if check_feature_flags:
                rpc.call(6, "environment/add", {"environmentId": "remote",
                         "execServerUrl": f"ws://127.0.0.1:{remote_port}"})
                restricted = rpc.call(7, "thread/start", {
                    "ephemeral": True, "model": "gpt-5.1", "modelProvider": "mock",
                    "environments": [{"environmentId": "remote",
                                      "cwd": str(root / "executor")}],
                    "approvalPolicy": "never", "sandbox": "danger-full-access",
                    "config": {"features": {"plugins": False, "view_image": False,
                                            "goals": False, "multi_agent": False,
                                            "apps": False, "computer_use": False,
                                            "browser_use": False},
                               "mcp_servers": {
                        **{name: {**transport, "enabled": False}
                           for name in HOST_SERVERS},
                        "orbit_private": {"command": bun, "args": [str(SESSION_MCP)],
                                          "env": {"ORBIT_SOCKET": str(broker_socket),
                                                  "ORBIT_SESSION_ID": SESSION_ID,
                                                  "ORBIT_USAGE_DIR": str(root / "usage")}},
                    }},
                })["thread"]
                rpc.call(8, "turn/start", {"threadId": restricted["id"],
                         "input": [{"type": "text",
                                    "text": "Call the disposable remote exec fixture."}]})
                rpc.wait_for_turn(restricted["id"])
            baseline_tools = model_requests[0]["tools"]
            private_tools = model_requests[1]["tools"]
            host_namespaces = [f"mcp__{name}" for name in HOST_SERVERS]
            result = {
                "installedCodex": str(CODEX),
                "baselineModelTools": baseline_tools,
                "privateModelTools": private_tools,
                "baselineHostNamespacesPresent": [name for name in host_namespaces
                                                  if name in baseline_tools],
                "privateHostNamespacesPresent": [name for name in host_namespaces
                                                 if name in private_tools],
                "privateOrbitActionPresent": "orbit_act" in
                    private_tools.get("mcp__orbit_private", []),
                "privateOrbitDelivered": [item["params"]["sessionId"]
                                          for item in broker.requests],
                "modelRequests": len(model_requests),
            }
            if check_feature_flags:
                restricted_tools = model_requests[3]["tools"]
                followup = json.dumps(model_requests[4]["input"])
                result["restrictedModelTools"] = restricted_tools
                result["restrictedRemoteSelected"] = (
                    restricted["environments"][0]["environmentId"] == "remote")
                result["restrictedRemoteOutputSeen"] = "EXECUTOR_ONLY" in followup
                result["restrictedAuthorityOutputSeen"] = "AUTHORITY_ONLY" in followup
                result["restrictedOrbitActionPresent"] = (
                    "orbit_act" in restricted_tools.get("mcp__orbit_private", []))
                result["restrictedHostNamespacesPresent"] = [
                    name for name in host_namespaces if name in restricted_tools]
            print(json.dumps(result, sort_keys=True))
            assert set(result["baselineHostNamespacesPresent"]) == set(host_namespaces)
            assert not result["privateHostNamespacesPresent"]
            assert result["privateOrbitActionPresent"]
            assert result["privateOrbitDelivered"] == [SESSION_ID]
            assert result["modelRequests"] == (5 if check_feature_flags else 3)
            if check_feature_flags:
                assert result["restrictedRemoteSelected"]
                assert result["restrictedRemoteOutputSeen"]
                assert not result["restrictedAuthorityOutputSeen"]
                assert result["restrictedOrbitActionPresent"]
                assert not result["restrictedHostNamespacesPresent"]
                assert "exec_command" in result["restrictedModelTools"]
        finally:
            stop_process(child)
            stop_process(executor)
            model.shutdown()
            model.server_close()
            model_worker.join(timeout=2)
            broker.shutdown()
            broker.server_close()
            broker_worker.join(timeout=2)


if __name__ == "__main__":
    main()
