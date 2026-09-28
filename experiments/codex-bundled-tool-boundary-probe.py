#!/usr/bin/python3
"""Probe per-thread MCP overrides with disposable copies of bundled plugins.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bundled-tool-boundary-probe.py

The source marketplace is read only. All Codex state is under a temporary home.
No real plugin process, model request, account or Desktop window is used.
"""

import json
import runpy
import shutil
import subprocess
import tempfile
from pathlib import Path


helpers = runpy.run_path(str(Path(__file__).with_name("codex-mcp-routing-probe.py")))
CODEX = helpers["CODEX"]
TOY_MCP = helpers["TOY_MCP"]
JsonRpc = helpers["JsonRpc"]
private_environment = helpers["private_environment"]
stop_process = helpers["stop_process"]
MARKETPLACE = Path("/usr/lib/chatgpt/resources/plugins/openai-bundled")


def plugin_command(environment, *args):
    result = subprocess.run(
        [str(CODEX), "plugin", *args],
        env=environment, capture_output=True, text=True, timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"plugin {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout.strip()


def can_call(rpc, request_id, thread_id, server):
    try:
        rpc.call(request_id, "mcpServer/tool/call", {
            "threadId": thread_id, "server": server,
            "tool": "where", "arguments": {},
        })
        return True
    except RuntimeError:
        return False


def main():
    if not CODEX.is_file() or not MARKETPLACE.is_dir():
        raise RuntimeError("Installed Codex CLI or bundled marketplace is missing")
    with tempfile.TemporaryDirectory(prefix="orbit-codex-bundled-boundary-") as temporary:
        root = Path(temporary)
        authority = root / "authority"
        authority.mkdir()
        script = root / "toy_mcp.py"
        script.write_text(TOY_MCP)
        environment = private_environment(authority, "AUTHORITY_ONLY")
        disposable_marketplace = root / "marketplace"
        catalog = disposable_marketplace / ".agents" / "plugins"
        catalog.mkdir(parents=True)
        (disposable_marketplace / "plugins").mkdir()
        names = ("codex-app-tools", "unified-computer-use", "browser", "chrome")
        (catalog / "marketplace.json").write_text(json.dumps({
            "name": "orbit-disposable",
            "plugins": [{
                "name": name,
                "source": {"source": "local", "path": f"./plugins/{name}"},
            } for name in names],
        }))
        for name in names:
            shutil.copytree(MARKETPLACE / "plugins" / name,
                            disposable_marketplace / "plugins" / name)
        plugin_command(environment, "marketplace", "add", str(disposable_marketplace))
        for name in names:
            plugin_command(environment, "add", f"{name}@orbit-disposable")
        config = Path(environment["CODEX_HOME"]) / "config.toml"
        with config.open("a") as output:
            output.write("\n[features]\nplugins = true\n")
        child = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "stdio://"],
            cwd=authority, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            rpc = JsonRpc(child)
            rpc.call(1, "initialize", {"clientInfo": {
                "name": "orbit_bundled_boundary_probe",
                "title": "Orbit bundled boundary probe", "version": "1",
            }, "capabilities": {"experimentalApi": True}})
            rpc.notify("initialized")
            plugins = rpc.call(2, "plugin/list", {})
            available = json.dumps(plugins)
            if any(name not in available for name in names):
                raise RuntimeError("Disposable bundled plugins were not listed")
            transport = {"command": "/usr/bin/python3", "args": ["-u", str(script)]}
            baseline = rpc.call(3, "thread/start", {"ephemeral": True, "config": {
                "mcp_servers": {
                    "codex_app": {**transport, "enabled": True},
                    "cua_repl": {**transport, "enabled": True},
                    "node_repl": {**transport, "enabled": True},
                },
            }})["thread"]
            baseline_status = rpc.call(4, "mcpServerStatus/list", {
                "threadId": baseline["id"], "detail": "toolsAndAuthOnly",
            })
            private = rpc.call(5, "thread/start", {"ephemeral": True, "config": {
                "features": {"plugins": False},
                "mcp_servers": {
                    "codex_app": {**transport, "enabled": False},
                    "cua_repl": {**transport, "enabled": False},
                    "node_repl": {**transport, "enabled": False},
                    "orbit_private": transport,
                },
            }})["thread"]
            private_status = rpc.call(6, "mcpServerStatus/list", {
                "threadId": private["id"], "detail": "toolsAndAuthOnly",
            })
            host_app_call = can_call(rpc, 7, private["id"], "codex_app")
            host_browser_call = can_call(rpc, 8, private["id"], "cua_repl")
            host_node_call = can_call(rpc, 9, private["id"], "node_repl")
            orbit_call = can_call(rpc, 10, private["id"], "orbit_private")
            statuses = lambda result: {item["name"]: item["runtimeStatus"]
                                       for item in result["data"]}
            evidence = {
                "bundledPluginsListed": True,
                "baselineMcpStatus": statuses(baseline_status),
                "privateThreadMcpStatus": statuses(private_status),
                "privateThreadCodexAppCallable": host_app_call,
                "privateThreadCuaCallable": host_browser_call,
                "privateThreadNodeReplCallable": host_node_call,
                "privateThreadOrbitCallable": orbit_call,
            }
            print(json.dumps(evidence, sort_keys=True))
            assert evidence["baselineMcpStatus"].get("codex_app") == "connected"
            assert evidence["baselineMcpStatus"].get("cua_repl") == "connected"
            assert evidence["baselineMcpStatus"].get("node_repl") == "connected"
            assert evidence["privateThreadMcpStatus"].get("codex_app") == "disabled"
            assert evidence["privateThreadMcpStatus"].get("cua_repl") == "disabled"
            assert evidence["privateThreadMcpStatus"].get("node_repl") == "disabled"
            assert evidence["privateThreadMcpStatus"].get("orbit_private") == "connected"
            assert not host_app_call and not host_browser_call and not host_node_call
            assert orbit_call
        finally:
            stop_process(child)


if __name__ == "__main__":
    main()
