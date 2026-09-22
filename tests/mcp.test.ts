import { version } from "../package.json";
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startBroker, call } from "../src/ipc";
import { loopbackAddress } from "./platform-support";

function payload(result: CallToolResult) {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text);
}
test("MCP stdio negotiates, validates and controls the shared broker across clients", async () => {
  const broker = await startBroker();
  const fixture = Bun.serve({ hostname: loopbackAddress, port: 0, fetch: () => new Response('<input id="entry"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Empty</output>', { headers: { "Content-Type": "text/html" } }) });
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
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(["orbit_act", "orbit_create", "orbit_diagnostics", "orbit_journal", "orbit_narrow", "orbit_observe", "orbit_pause", "orbit_profiles", "orbit_restore", "orbit_resume", "orbit_status", "orbit_stop", "orbit_usage"]);
    // The capability an agent could not find. `cloneOf` has existed on session.create since the
    // clone path closed, and the adapter exposed neither it nor any way to learn a profile path,
    // so an agent asked whether Orbit could use the person's own browser answered no. Both halves
    // are asserted: the tool that answers the question, and the parameter that acts on the answer.
    const profiles = payload(await tool(a, "orbit_profiles")) as { profiles: { clonable: boolean; profileDirectory: string }[] };
    expect(Array.isArray(profiles.profiles)).toBe(true);
    for (const entry of profiles.profiles) expect(typeof entry.profileDirectory).toBe("string");
    const createSchema = (await a.listTools()).tools.find(t => t.name === "orbit_create")!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(createSchema.properties)).toEqual(expect.arrayContaining(["cloneOf", "cloneExtensions", "policy"]));
    expect(payload(await tool(a, "orbit_diagnostics"))).toMatchObject({ schemaVersion: 1 });
    const session = payload(await tool(a, "orbit_create")) as { sessionId: string };
    const act = (action: unknown, requestId = crypto.randomUUID()) => tool(a, "orbit_act", { ...session, requestId, action });
    expect((await act({ type: "navigate", url: `http://${loopbackAddress}:${fixture.port}` })).isError).not.toBe(true);
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

// Which tool a job belongs to, asserted as the words an agent reads before it chooses one. Orbit's
// own trial with a real host (docs/connectors.md) measured that a generic browser request stays with
// the host's generic browser tool and reaches Orbit only when isolation is the point, while every
// instruction this adapter shipped said the opposite: use Orbit whenever a task needs a browser. The
// mismatch is not free. An agent following it spends a session, an owned browser and a slice of the
// shared budget to read a page a fetch would have answered. Both halves are pinned: what Orbit is
// for, and whose job the rest is. Shapes rather than the whole paragraph, because a gate that pins
// prose fails on every rewording and teaches the next editor to delete it.
test("the adapter tells an agent when a task is not Orbit's job", async () => {
  const broker = await startBroker();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(), env: { ORBIT_SOCKET: broker.socket }, stderr: "pipe" });
  const client = new Client({ name: "orbit-routing-check", version: "1.0.0" });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/not a general web tool/);
    expect(instructions).toMatch(/host.s own web tools/);
    const created = (await client.listTools()).tools.find(tool => tool.name === "orbit_create");
    const description = created?.description ?? "";
    expect(description).toMatch(/host.s own web tools/);
    // And the other half: an agent that should reach for Orbit has to see why it exists at all.
    expect(description).toMatch(/watch or take over/);
  } finally {
    await client.close();
    await broker.close();
  }
});
