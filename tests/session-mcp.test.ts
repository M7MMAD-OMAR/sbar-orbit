import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSessionMcpServer } from "../src/session-mcp";

test("session adapter fixes every call to its own Orbit session", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-bound-mcp-"));
  const socket = join(root, "broker.sock");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const broker = Bun.serve({ unix: socket, async fetch(request) {
    const body = await request.json() as { method: string; params: Record<string, unknown> };
    requests.push(body);
    return Response.json({ ok: true, result: { owner: body.params.sessionId } });
  } });
  const clients: Client[] = [];
  const connect = async (sessionId: string) => {
    const client = new Client({ name: "bound-session-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("src/session-mcp.ts")], cwd: process.cwd(),
      env: { ORBIT_SOCKET: socket, ORBIT_SESSION_ID: sessionId,
        ORBIT_USAGE_DIR: join(root, "usage") }, stderr: "pipe" }));
    return client;
  };
  const tool = async (client: Client, name: string, args: Record<string, unknown>) =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  try {
    const a = await connect(first);
    const b = await connect(second);
    expect((await a.listTools()).tools.map(entry => entry.name).sort()).toEqual([
      "orbit_act", "orbit_journal", "orbit_narrow", "orbit_observe", "orbit_pause",
      "orbit_resume", "orbit_stop",
    ]);
    const action = { type: "pointer", x: 5, y: 6 };
    expect((await tool(a, "orbit_act", { requestId: "a", action, sessionId: second })).isError).not.toBe(true);
    expect((await tool(b, "orbit_act", { requestId: "b", action, sessionId: first })).isError).not.toBe(true);
    expect(requests).toEqual([
      { method: "session.act", params: { requestId: "a", action, sessionId: first } },
      { method: "session.act", params: { requestId: "b", action, sessionId: second } },
    ]);
    expect((await tool(a, "orbit_create", {})).isError).toBe(true);
    expect(requests).toHaveLength(2);
    expect((await tool(a, "orbit_stop", { sessionId: second })).isError).not.toBe(true);
    expect(requests.at(-1)).toEqual({ method: "session.stop", params: { sessionId: first } });
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    broker.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("session adapter refuses an invalid binding", () => {
  expect(() => createSessionMcpServer("/tmp/broker.sock", "not-a-session")).toThrow();
});
