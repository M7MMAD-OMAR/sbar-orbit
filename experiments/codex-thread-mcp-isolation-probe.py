#!/usr/bin/python3
"""Check whether a thread config disables an authority-owned MCP server.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-thread-mcp-isolation-probe.py

The authority, homes, MCP server and threads exist only in a temporary directory.
No account, model request, desktop window or personal profile is used.
"""

import json
import runpy
import subprocess
import tempfile
from pathlib import Path


helpers = runpy.run_path(str(Path(__file__).with_name("codex-mcp-routing-probe.py")))
CODEX = helpers["CODEX"]
TOY_MCP = helpers["TOY_MCP"]
JsonRpc = helpers["JsonRpc"]
private_environment = helpers["private_environment"]
stop_process = helpers["stop_process"]


def tool_call(rpc, request_id, thread_id, server):
    try:
        result = rpc.call(request_id, "mcpServer/tool/call", {
            "threadId": thread_id,
            "server": server,
            "tool": "where",
            "arguments": {},
        })
        return {"worked": True, "location": json.loads(result["content"][0]["text"])}
    except RuntimeError as error:
        return {"worked": False, "error": str(error)}


def main():
    if not CODEX.is_file():
        raise RuntimeError("Installed Codex binary is missing")
    cli_version = subprocess.run([str(CODEX), "--version"], capture_output=True,
                                 text=True, check=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="orbit-codex-thread-mcp-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        authority.mkdir()
        script = root / "toy_mcp.py"
        script.write_text(TOY_MCP)
        environment = private_environment(authority, "AUTHORITY_ONLY")
        config = Path(environment["CODEX_HOME"]) / "config.toml"
        for server in ("host_ui", "host_browser"):
            with config.open("a") as output:
                output.write(
                    f'[mcp_servers.{server}]\ncommand = "/usr/bin/python3"\n'
                    f'args = ["-u", {json.dumps(str(script))}]\n'
                )
        child = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "stdio://"],
            cwd=authority,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            rpc = JsonRpc(child)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_thread_mcp_probe", "title": "Orbit thread MCP probe",
                "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.notify("initialized")
            baseline = rpc.call(2, "thread/start", {"ephemeral": True})["thread"]
            baseline_ui = tool_call(rpc, 3, baseline["id"], "host_ui")
            baseline_browser = tool_call(rpc, 4, baseline["id"], "host_browser")
            empty_override = rpc.call(5, "thread/start", {
                "ephemeral": True, "config": {"mcp_servers": {}},
            })["thread"]
            empty_override_ui = tool_call(rpc, 6, empty_override["id"], "host_ui")
            disabled = rpc.call(7, "thread/start", {
                "ephemeral": True,
                "config": {"mcp_servers": {
                    "host_ui": {"enabled": False},
                    "host_browser": {"enabled": False},
                    "orbit_private": {
                        "command": "/usr/bin/python3",
                        "args": ["-u", str(script)],
                    },
                }},
            })["thread"]
            disabled_ui = tool_call(rpc, 8, disabled["id"], "host_ui")
            disabled_browser = tool_call(rpc, 9, disabled["id"], "host_browser")
            orbit_private = tool_call(rpc, 10, disabled["id"], "orbit_private")
            baseline_status = rpc.call(11, "mcpServerStatus/list", {
                "threadId": baseline["id"], "detail": "toolsAndAuthOnly",
            })
            disabled_status = rpc.call(12, "mcpServerStatus/list", {
                "threadId": disabled["id"], "detail": "toolsAndAuthOnly",
            })
            evidence = {
                "cliVersion": cli_version,
                "baselineHostUiWorked": baseline_ui["worked"],
                "baselineHostBrowserWorked": baseline_browser["worked"],
                "emptyOverrideStillCallsHostUi": empty_override_ui["worked"],
                "privateThreadHostUiWorked": disabled_ui["worked"],
                "privateThreadHostBrowserWorked": disabled_browser["worked"],
                "privateThreadOrbitMcpWorked": orbit_private["worked"],
                "baselineStatus": {item["name"]: item["runtimeStatus"]
                                   for item in baseline_status["data"]},
                "privateThreadStatus": {item["name"]: item["runtimeStatus"]
                                        for item in disabled_status["data"]},
            }
            if orbit_private["worked"]:
                evidence["orbitMcpRunsInAuthority"] = (
                    orbit_private["location"]["home"] == environment["HOME"]
                )
            print(json.dumps(evidence, sort_keys=True))
            assert baseline_ui["worked"] and baseline_browser["worked"]
            assert empty_override_ui["worked"]
            assert not disabled_ui["worked"] and not disabled_browser["worked"]
            assert orbit_private["worked"]
            assert evidence["privateThreadStatus"] == {
                "host_ui": "disabled", "host_browser": "disabled",
                "orbit_private": "connected",
            }
        finally:
            stop_process(child)


if __name__ == "__main__":
    main()
