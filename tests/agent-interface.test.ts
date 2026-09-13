import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const presence = { title: "Fixture", location: "https://example.test/", pageCount: 2, pageIndex: 2,
  tabs: [{ tab: 1, label: "First", active: false }, { tab: 2, label: "Fixture", active: true }], pointer: null };
const frame = { mimeType: "image/jpeg", image: Buffer.from("fixture image bytes").toString("base64"), width: 1280, height: 800, capturedAt: 123, presence };
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "orbit-interface-"));
  const socket = join(root, "broker.sock");
  const calls: string[] = [];
  const server = Bun.serve({ unix: socket, async fetch(request) {
    const { method } = await request.json() as { method: string };
    calls.push(method);
    return Response.json({ ok: true, result: method === "session.observe" ? frame : method === "session.presence" ? presence : [] });
  } });
  const clients: Client[] = [];
  const env: Record<string, string | undefined> = { ...process.env, ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: join(root, "usage") };
  delete env.ORBIT_CONVERSATION_ID;
  const connect = async (conversationId?: string) => {
    const client = new Client({ name: "interface-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(),
      env: { ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...(conversationId ? { ORBIT_CONVERSATION_ID: conversationId } : {}) }, stderr: "pipe" }));
    return client;
  };
  const cli = async (args: string[], conversationId?: string) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...env, ORBIT_CONVERSATION_ID: conversationId }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, data: JSON.parse(code === 0 ? stdout : stderr) };
  };
  return { root, calls, connect, cli, close: async () => { await Promise.all(clients.map(client => client.close())); server.stop(true); await rm(root, { recursive: true, force: true }); } };
}
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));

test("MCP image preserves tab metadata; metadata mode never captures", async () => {
  const h = await harness();
  try {
    const client = await h.connect();
    const result = await tool(client, "orbit_observe", { sessionId: "s" });
    expect(result.content[0]?.type).toBe("image");
    expect(result.structuredContent).toMatchObject({ width: 1280, height: 800, presence });
    expect(result.structuredContent).not.toHaveProperty("image");
    const metadata = await tool(client, "orbit_observe", { sessionId: "s", mode: "metadata" });
    expect(metadata.structuredContent).toMatchObject(presence);
    expect(metadata.content.every(block => block.type === "text")).toBe(true);
    expect(h.calls).toEqual(["session.observe", "session.presence"]);
  } finally { await h.close(); }
});

test("MCP opt-out is local, rejects all broker access and can be re-enabled", async () => {
  const h = await harness();
  try {
    const a = await h.connect(); const b = await h.connect();
    expect((await tool(a, "orbit_usage", { mode: "off" })).isError).not.toBe(true);
    const disabled = await tool(a, "orbit_status");
    expect(disabled.isError).toBe(true);
    expect(JSON.stringify(disabled)).toContain("ORBIT_DISABLED");
    expect(h.calls).toEqual([]);
    expect((await tool(b, "orbit_status")).isError).not.toBe(true);
    await tool(a, "orbit_usage", { mode: "on" });
    expect((await tool(a, "orbit_status")).isError).not.toBe(true);
    expect(h.calls).toEqual(["session.list", "session.list"]);
  } finally { await h.close(); }
});

test("explicit conversation scope survives adapter restart and is shared with CLI only for that ID", async () => {
  const h = await harness();
  try {
    const a = await h.connect("task-a");
    await tool(a, "orbit_usage", { mode: "off" });
    await a.close();
    const restarted = await h.connect("task-a");
    expect((await tool(restarted, "orbit_status")).isError).toBe(true);
    const blocked = await h.cli(["session", "list"], "task-a");
    expect(blocked.data.error.code).toBe("ORBIT_DISABLED");
    expect(h.calls).toEqual([]);
    expect((await h.cli(["session", "list"], "task-b")).code).toBe(0);
    expect((await h.cli(["usage", "on", "task-a"])).code).toBe(0);
    expect((await tool(restarted, "orbit_status")).isError).not.toBe(true);
    expect((await h.cli(["usage", "off"])).data.error.code).toBe("CONVERSATION_REQUIRED");
  } finally { await h.close(); }
});

test("CLI metadata avoids capture; image files preserve bytes and refuse overwrite", async () => {
  const h = await harness();
  try {
    const metadata = await h.cli(["session", "observe", "s", "--metadata"]);
    expect(metadata.data.result).toEqual(presence);
    expect(h.calls).toEqual(["session.presence"]);
    const path = join(h.root, "capture.jpg");
    const saved = await h.cli(["session", "observe", "s", "--output", path]);
    expect(saved.code).toBe(0);
    expect(saved.data.result.path).toBe(path);
    expect(saved.data.result).not.toHaveProperty("image");
    expect(await Bun.file(path).text()).toBe("fixture image bytes");
    expect((await h.cli(["session", "observe", "s", "--output", path])).code).toBe(1);
    expect((await h.cli(["session", "observe", "s", "--metadata", "--output", path])).code).toBe(1);
    expect((await h.cli(["session", "observe", "s", "--output"])).code).toBe(1);
    expect(await Bun.file(path).text()).toBe("fixture image bytes");
  } finally { await h.close(); }
});

test("corrupt conversation state fails closed and explicit choice repairs it", async () => {
  const h = await harness();
  try {
    await h.cli(["usage", "off", "damaged-task"]);
    const { readdir, stat } = await import("node:fs/promises");
    const directory = join(h.root, "usage");
    const file = (await readdir(directory))[0];
    if (!file) throw new Error("Usage state was not persisted");
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    await Bun.write(join(directory, file), '{"enabled":"false"}');
    expect((await h.cli(["session", "list"], "damaged-task")).data.error.code).toBe("USAGE_STATE_INVALID");
    const client = await h.connect("damaged-task");
    expect(JSON.stringify(await tool(client, "orbit_status"))).toContain("USAGE_STATE_INVALID");
    expect(h.calls).toEqual([]);
    await tool(client, "orbit_usage", { mode: "on" });
    expect((await tool(client, "orbit_status")).isError).not.toBe(true);
  } finally { await h.close(); }
});
