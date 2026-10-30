import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A broker restart (`systemctl --user restart sbar-orbit.service`) must never cost a live agent its
 * tools. The host does not restart a stdio server that exited, so the adapter has to outlive the
 * broker and answer the calls made while the broker is down once it is back.
 */
test("the MCP adapter outlives a broker restart and serves the call made while the broker was down", async () => {
  const root = await mkdtemp(join(process.env.HOME ?? "/home", ".cache/sbar-orbit/tmp-restart-"));
  const socket = join(root, "broker.sock");
  const serve = () => Bun.serve({ unix: socket, fetch: () => Response.json({ ok: true, result: { sessions: [], generation: Date.now() } }) });
  let broker = serve();
  const client = new Client({ name: "restart-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("src/mcp.ts")], cwd: process.cwd(),
      env: { ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: join(root, "usage") }, stderr: "pipe" }));
    const toolCount = (await client.listTools()).tools.length;
    expect(toolCount).toBeGreaterThan(5);
    const status = async () => CallToolResultSchema.parse(await client.callTool({ name: "orbit_status", arguments: {} }));
    expect((await status()).isError).not.toBe(true);

    broker.stop(true);
    const during = status();
    await new Promise(resolve => setTimeout(resolve, 700));
    broker = serve();
    expect((await during).isError).not.toBe(true);

    // The tool surface is still there, and so is the connection.
    expect((await client.listTools()).tools).toHaveLength(toolCount);
    expect((await status()).isError).not.toBe(true);
  } finally {
    await client.close().catch(() => {});
    broker.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
