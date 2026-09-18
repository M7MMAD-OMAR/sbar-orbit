$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# Every part works alone: the CLI answers, the socket crosses processes, MCP stdio connects and calls.
# So the failing test is reproduced here STEP BY STEP, in its own order, with a clock on each step, to
# find which one stops rather than concluding "a hang" from a suite timeout.
$Probe = @'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "iface-probe-"));
const socket = join(root, "broker.sock");
const calls = [];
const server = Bun.serve({ unix: socket, async fetch(request) {
  const { method } = await request.json();
  calls.push(method);
  return Response.json({ ok: true, result: [] });
} });

const base = Object.fromEntries(Object.entries({ ...process.env, ORBIT_SOCKET: socket,
  ORBIT_USAGE_DIR: join(root, "usage") }).filter(([, v]) => v !== undefined));
delete base.ORBIT_CONVERSATION_ID;

const clients = [];
const connect = async (conversationId) => {
  const client = new Client({ name: "probe", version: "1" });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"],
    cwd: process.cwd(), env: { ...base, ...(conversationId ? { ORBIT_CONVERSATION_ID: conversationId } : {}) }, stderr: "pipe" }));
  return client;
};

// The harness's own cli(), including its Promise.all over both streams, which is the shape that can
// deadlock if one pipe is never drained.
const cli = (args, conversationId) => new Promise(resolve => {
  const child = spawn(process.execPath, ["src/cli.ts", ...args],
    { env: { ...base, ORBIT_CONVERSATION_ID: conversationId } });
  let out = "", err = "";
  child.stdout.on("data", d => out += d);
  child.stderr.on("data", d => err += d);
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ killed: true, out, err }); }, 8000);
  child.on("exit", code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
});

const stage = async (label, work, ms = 9000) => {
  const started = Date.now();
  try {
    const value = await Promise.race([work(), new Promise((_, r) => setTimeout(() => r(new Error("TIMED OUT")), ms))]);
    // Printed defensively: an MCP Client is cyclic and JSON.stringify throws on it, which would
    // report a working stage as stuck.
    let shown = "";
    try { shown = JSON.stringify(value ?? null).slice(0, 200); } catch { shown = "(unserialisable)"; }
    console.log("OK    " + label + "  " + (Date.now() - started) + "ms  " + shown);
    return value;
  } catch (e) { console.log("STUCK " + label + "  " + (Date.now() - started) + "ms  " + e.message); throw e; }
};

try {
  const a = await stage("connect task-a", () => connect("task-a"));
  await stage("orbit_usage off", () => a.callTool({ name: "orbit_usage", arguments: { mode: "off" } }));
  await stage("close a", () => a.close());
  const restarted = await stage("reconnect task-a", () => connect("task-a"));
  await stage("orbit_status (expect error)", () => restarted.callTool({ name: "orbit_status", arguments: {} }));
  await stage("cli session list task-a", () => cli(["session", "list"], "task-a"));
  await stage("cli session list task-b", () => cli(["session", "list"], "task-b"));
  await stage("cli usage on task-a", () => cli(["usage", "on", "task-a"]));
  await stage("orbit_status again", () => restarted.callTool({ name: "orbit_status", arguments: {} }));
  await stage("cli usage off no id", () => cli(["usage", "off"], undefined));
  console.log("broker methods seen: " + JSON.stringify(calls));
} catch {}
for (const c of clients) { try { await c.close(); } catch {} }
server.stop(true);
console.log("PROBE COMPLETE");
'@
Set-Content -Path 'C:\orbit\iface-probe.mjs' -Value $Probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\iface-probe.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
