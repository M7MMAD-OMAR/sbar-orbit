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
  const fixture = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response('<input id="entry"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Empty</output>', { headers: { "Content-Type": "text/html" } }) });
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
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(["orbit_act", "orbit_create", "orbit_diagnostics", "orbit_journal", "orbit_narrow", "orbit_observe", "orbit_pause", "orbit_restore", "orbit_resume", "orbit_status", "orbit_stop", "orbit_usage"]);
    expect(payload(await tool(a, "orbit_diagnostics"))).toMatchObject({ schemaVersion: 1 });
    const session = payload(await tool(a, "orbit_create")) as { sessionId: string };
    const act = (action: unknown, requestId = crypto.randomUUID()) => tool(a, "orbit_act", { ...session, requestId, action });
    expect((await act({ type: "navigate", url: `http://127.0.0.2:${fixture.port}` })).isError).not.toBe(true);
    await act({ type: "fill", selector: "#entry", text: "MCP connected" });
    await act({ type: "click", selector: "button" });
    expect(payload(await act({ type: "read", selector: "output" }))).toEqual({ text: "MCP connected" });
    expect((await tool(b, "orbit_observe", session)).content[0]?.type).toBe("image");
    const invalid = await tool(a, "orbit_act", { ...session, requestId: "bad", action: { type: "host-mouse" } });
    expect(invalid.isError).toBe(true);
    await tool(b, "orbit_pause", session);
    expect(payload(await act({ type: "click", selector: "button" }))).toMatchObject({ code: "PAUSED" });
    await tool(b, "orbit_resume", session);
    // An agent can read its own record back and tighten itself, and neither needs a person.
    const journal = payload(await tool(a, "orbit_journal", session)) as { entries: { actionType: string }[]; tainted: boolean; egressTier: string };
    expect(journal.entries[0]?.actionType).toBe("session.create");
    // A read returned page content, which is the line after which everything the session decides has
    // been influenced by something a page said.
    expect(journal.tainted).toBe(true);
    expect(journal.egressTier).toBe("in-browser");
    const narrowed = payload(await tool(a, "orbit_narrow", { ...session, allow: ["read"] })) as { policy: { allow: string[] } };
    expect(narrowed.policy.allow).toEqual(["read"]);
    // And it cannot get back what it just gave up, which is the whole value of the boundary.
    expect(payload(await tool(a, "orbit_narrow", { ...session, allow: ["read", "navigate", "write"] })) as { policy: { allow: string[] } })
      .toMatchObject({ policy: { allow: ["read"] } });
    // A supervised session stops and waits for the person rather than refusing outright, which is the
    // difference between this default and the autonomous mode.
    expect(payload(await act({ type: "click", selector: "button" }))).toMatchObject({ code: "POLICY_CONFIRMATION_REQUIRED" });
    // A stop and wait is a decision, so it is journalled like a refusal. An action that vanished from the
    // record because nobody answered it is the one a reader would most want to see.
    expect((payload(await tool(a, "orbit_journal", session)) as { entries: { actionType: string; outcome: string }[] }).entries.at(-1))
      .toMatchObject({ actionType: "click", outcome: "ask" });
    await a.close();
    // By sessionId, not by the whole creation payload: the narrowing above deliberately changed the
    // policy this session reports, which is the point of it.
    expect(payload(await tool(b, "orbit_status"))).toContainEqual(expect.objectContaining({ sessionId: session.sessionId, state: "running", policy: expect.objectContaining({ allow: ["read"] }) }));
    expect(payload(await tool(b, "orbit_stop", session))).toMatchObject({ state: "closed" });
    expect(payload(await tool(b, "orbit_observe", session))).toMatchObject({ code: "SESSION_CLOSED" });
    expect(payload(await tool(b, "orbit_stop", { sessionId: "unknown" }))).toMatchObject({ code: "SESSION_NOT_FOUND" });
    await broker.close();
    expect(payload(await tool(b, "orbit_status"))).toMatchObject({ code: "BROKER_UNAVAILABLE" });
  } finally { await Promise.allSettled(clients.map(c => c.close())); await broker.close(); fixture.stop(true); }
}, 30000);
