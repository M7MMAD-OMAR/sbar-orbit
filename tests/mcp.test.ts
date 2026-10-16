import { version } from "../package.json";
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startBroker, call } from "../src/ipc";

function payload(result: CallToolResult) {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text);
}
test("MCP stdio negotiates, validates and controls the shared broker across clients", async () => {
  const broker = await startBroker();

  const clients: Client[] = [];
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(), env: { ORBIT_SOCKET: broker.socket }, stderr: "pipe" });
    const client = new Client({ name: "orbit-integration-harness", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  const tool = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }).then(r => CallToolResultSchema.parse(r));
  try {
    const a = await connect();
    const b = await connect();
    expect(a.getServerVersion()).toEqual({ name: "sbar-orbit", version });
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(["orbit_act", "orbit_applications", "orbit_create", "orbit_diagnostics", "orbit_handoff", "orbit_handoff_candidates", "orbit_journal", "orbit_narrow", "orbit_observe", "orbit_open", "orbit_pause", "orbit_restore", "orbit_resume", "orbit_status", "orbit_stop", "orbit_usage"]);
    const applications = payload(await tool(a, "orbit_applications", { query: "orbit-missing-app-fixture" }));
    expect(applications).toMatchObject({ scope: "current-user", applications: [] });
    expect(payload(await tool(a, "orbit_diagnostics"))).toMatchObject({ schemaVersion: 1 });
    const refused = await tool(a, "orbit_create", { backend: "browser" });
    expect(refused.isError).toBe(true);
    const invalid = await tool(a, "orbit_act", { sessionId: "unknown", requestId: "bad", action: { type: "host-mouse" } });
    expect(invalid.isError).toBe(true);
    expect(payload(await tool(b, "orbit_status"))).toEqual([]);
    expect(payload(await tool(b, "orbit_stop", { sessionId: "unknown" }))).toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(call(broker.socket, "session.create", { backend: "browser" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await a.close();
    expect(payload(await tool(b, "orbit_status"))).toEqual([]);
    await broker.close();
    expect(payload(await tool(b, "orbit_status"))).toMatchObject({ code: "BROKER_UNAVAILABLE" });
  } finally { await Promise.allSettled(clients.map(c => c.close())); await broker.close(); }
}, 30000);

test("the adapter declares desktop-only routing without browser fallback", async () => {
  const broker = await startBroker();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(), env: { ORBIT_SOCKET: broker.socket }, stderr: "pipe" });
  const client = new Client({ name: "orbit-routing-check", version: "1.0.0" });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/desktop-only/);
    expect(instructions).toMatch(/Never replace a failed desktop operation with browser automation/);
    const created = (await client.listTools()).tools.find(tool => tool.name === "orbit_create");
    const description = created?.description ?? "";
    expect(description).toMatch(/No standalone browser backend/);
    // And the other half: an agent that should reach for Orbit has to see why it exists at all.
    expect(description).toMatch(/application control/);
  } finally {
    await client.close();
    await broker.close();
  }
});
