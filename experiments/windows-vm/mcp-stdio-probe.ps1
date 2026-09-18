$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# The CLI answers and the socket crosses processes, so what is left in the two timing-out tests is the
# MCP stdio client: StdioClientTransport spawns `bun src/mcp.ts` and speaks JSON-RPC over its pipes.
# This times each stage separately so a hang is attributed rather than guessed at.
$Probe = @'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-probe-"));
const socket = join(root, "broker.sock");
const server = Bun.serve({ unix: socket, async fetch(request) {
  const { method } = await request.json();
  return Response.json({ ok: true, result: method === "session.list" ? [] : null });
} });

const env = Object.fromEntries(Object.entries({ ...process.env, ORBIT_SOCKET: socket,
  ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_CONVERSATION_ID: "probe-a" }).filter(([, v]) => v !== undefined));

const stage = async (label, work, ms = 10000) => {
  const started = Date.now();
  try {
    const value = await Promise.race([work(), new Promise((_, reject) => setTimeout(() => reject(new Error("TIMED OUT")), ms))]);
    console.log(label + ": ok in " + (Date.now() - started) + "ms " + (value === undefined ? "" : JSON.stringify(value).slice(0, 220)));
    return value;
  } catch (error) {
    console.log(label + ": FAILED in " + (Date.now() - started) + "ms :: " + error.message);
    return undefined;
  }
};

const client = new Client({ name: "probe", version: "1" });
await stage("connect", () => client.connect(new StdioClientTransport({
  command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(), env, stderr: "pipe" })));
await stage("listTools", async () => (await client.listTools()).tools.map(t => t.name));
await stage("orbit_status", () => client.callTool({ name: "orbit_status", arguments: {} }));
await stage("orbit_usage off", () => client.callTool({ name: "orbit_usage", arguments: { mode: "off" } }));
await stage("close", () => client.close());
server.stop(true);
console.log("ALL STAGES DONE");
'@
Set-Content -Path 'C:\orbit\mcp-probe.mjs' -Value $Probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\mcp-probe.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
