import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectorEntry } from "../src/connector-entry";
import { requireResourceBudget, resourceStatus } from "../src/resource-budget";
import { serviceSocketPath } from "../src/service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Run through limited.ts, with an already running managed broker. This keeps
// three real adapters connected while one drives a private local browser page.
await requireResourceBudget();
const root = await mkdtemp(join(tmpdir(), "orbit-mcp-concurrency-"));
let privateBroker: Awaited<ReturnType<typeof import("../src/ipc").startBroker>> | undefined;
let socket = process.env.ORBIT_SOCKET || serviceSocketPath();
const entry = connectorEntry({ source: resolve(import.meta.dir, ".."), preferInterpreter: true });
const clients: Client[] = [];
const phases: Record<string, number> = {};
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("<!doctype html><h1>Concurrent Orbit adapters</h1>", { headers: { "Content-Type": "text/html" } }) });
let sessionId: string | undefined;
async function tool(client: Client, name: string, args: Record<string, unknown> = {}, phase = name) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args }) as CallToolResult;
  phases[phase] = Math.round(performance.now() - started);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}
function payload(result: CallToolResult) {
  const text = result.content.find(item => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing MCP text result");
  return JSON.parse(text.text);
}
try {
  if (process.argv.includes("--private-broker")) {
    privateBroker = await (await import("../src/ipc")).startBroker({ accountRoot: join(root, "accounts") });
    socket = privateBroker.socket;
  }
  const before = await resourceStatus();
  const started = performance.now();
  for (const host of ["claude", "codex", "hermes"]) {
    const client = new Client({ name: `orbit-${host}-concurrency-probe`, version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({ ...entry, env: {
      ...Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => value[1] !== undefined)),
      ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: root, ORBIT_CONVERSATION_ID: `probe-${host}-${crypto.randomUUID()}`,
    }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => process.stderr.write(chunk));
    await client.connect(transport);
    await tool(client, "orbit_status");
  }
  phases.connectThree = Math.round(performance.now() - started);
  const [first, second, third] = clients;
  if (!first || !second || !third) throw new Error("Three adapters are required");
  sessionId = payload(await tool(first, "orbit_create", {
    agentName: "Orbit verification", taskName: "Three concurrent MCP adapters", backend: "browser",
  })).sessionId;
  if (!sessionId) throw new Error("No browser session was created");
  await tool(first, "orbit_act", { sessionId, requestId: crypto.randomUUID(),
    action: { type: "navigate", url: `http://127.0.0.1:${fixture.port}` } }, "navigate");
  const read = payload(await tool(third, "orbit_act", { sessionId, requestId: crypto.randomUUID(),
    action: { type: "read", selector: "h1" } }, "read"));
  if (!JSON.stringify(read).includes("Concurrent Orbit adapters")) throw new Error("Fixture text was not read");
  const observed = await tool(second, "orbit_observe", { sessionId });
  if (!observed.content.some(item => item.type === "image" && item.data.length > 100)) throw new Error("No browser frame");
  const occupied = await resourceStatus();
  await first.close();
  await tool(third, "orbit_status");
  await tool(third, "orbit_stop", { sessionId });
  sessionId = undefined;
  console.log(JSON.stringify({ ok: true, scope: "three generated interpreter entries and one browser",
    broker: privateBroker ? "current source, private socket" : "existing managed socket",
    nativeHostApplications: "not measured", bun: Bun.version, platform: process.platform, phases, before, occupied }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, bun: Bun.version, platform: process.platform, phases,
    resources: await resourceStatus().catch(() => "unavailable"), message: String(error) }));
  throw error;
} finally {
  if (sessionId) {
    for (const client of [...clients].reverse()) {
      try { await tool(client, "orbit_stop", { sessionId }); break; } catch { /* Another connected adapter may still clean up. */ }
    }
  }
  await Promise.allSettled(clients.map(client => client.close()));
  await privateBroker?.close();
  fixture.stop(true);
  await rm(root, { recursive: true, force: true });
}
