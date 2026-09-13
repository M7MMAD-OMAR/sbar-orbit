"""Probe the installed Hermes MCP renderer using a real stdio adapter and private browser.
Run through experiments/hermes-interface.ts. No model calls or personal config reads.
"""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ["ORBIT_HERMES_SOURCE"])
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from tools.mcp_tool_handlers import _render_call_tool_result
from tools.mcp_tool_common import mcp_field


async def main():
    parameters = StdioServerParameters(command=os.environ["ORBIT_BUN"], args=[os.environ["ORBIT_MCP_ENTRY"]],
        env={**os.environ, "ORBIT_CONVERSATION_ID": "isolated-hermes-interface-probe"})
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            tools = (await client.list_tools()).tools
            session_id = None
            async def call(name, args):
                result = await client.call_tool(name, args)
                if mcp_field(result, "is_error", "isError", False):
                    raise RuntimeError(_render_call_tool_result(result, "orbit"))
                return result
            try:
                created = await call("orbit_create", {"agentName": "Hermes bridge probe", "taskName": "Isolated interface validation"})
                session_id = json.loads(created.content[0].text)["sessionId"]
                await call("orbit_act", {"sessionId": session_id, "requestId": "navigate-fixture",
                    "action": {"type": "navigate", "url": os.environ["ORBIT_FIXTURE_URL"]}})
                observed = await call("orbit_observe", {"sessionId": session_id})
                rendered = json.loads(_render_call_tool_result(observed, "orbit"))
                text = rendered["result"]
                lines = text.splitlines()
                media = next(line.removeprefix("MEDIA:") for line in lines if line.startswith("MEDIA:"))
                metadata = json.loads(next(line for line in lines if line.startswith("{")))
                original = base64.b64decode(observed.content[0].data)
                assert Path(media).is_relative_to(Path(os.environ["HERMES_HOME"]))
                assert Path(media).read_bytes() == original
                assert metadata["presence"]["title"] == "Orbit interface fixture"
                assert metadata["width"] == 1280 and metadata["height"] == 800
                assert "structuredContent" not in rendered
                summary = await call("orbit_observe", {"sessionId": session_id, "mode": "metadata"})
                summary_text = json.loads(_render_call_tool_result(summary, "orbit"))["result"]
                assert "MEDIA:" not in summary_text
                assert json.loads(summary_text)["title"] == "Orbit interface fixture"
                await call("orbit_usage", {"mode": "off"})
                refused = await client.call_tool("orbit_observe", {"sessionId": session_id})
                assert mcp_field(refused, "is_error", "isError", False) and "ORBIT_DISABLED" in _render_call_tool_result(refused, "orbit")
                await call("orbit_usage", {"mode": "on"})
                full_cli_equivalent = {**metadata, "image": observed.content[0].data}
                print(json.dumps({"host": "installed Hermes MCP result renderer plus Python MCP stdio client",
                    "toolCount": len(tools), "metadataPreserved": True, "imageBytesPreserved": True,
                    "imageSha256": hashlib.sha256(original).hexdigest(), "imageBytes": len(original),
                    "metadataOnlyBytes": len(summary_text.encode()),
                    "imageJsonBytes": len(json.dumps(full_cli_equivalent, separators=(",", ":")).encode()),
                    "hermesRenderedBytes": len(text.encode()), "optOutRefused": True,
                    "modelTokens": "not measured", "modelDrivenTask": "not measured"}))
            finally:
                await client.call_tool("orbit_usage", {"mode": "on"})
                if session_id:
                    await client.call_tool("orbit_stop", {"sessionId": session_id})


asyncio.run(main())
