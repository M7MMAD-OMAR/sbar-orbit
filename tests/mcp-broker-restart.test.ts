import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp";
import type { ClientIdentity } from "../src/caller";

// Actual MCP server/client protocol in-process, with an owned fake Unix metadata broker.
// No stdio child, process lifetime/peer authentication, desktop or global at-most-once claim.
// Observed request counts exercise wrapper behavior, not hidden Bun transport attempts.
const posix = process.platform === "win32" ? test.skip : test;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error("Owned MCP settlement unconfirmed")), 2000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

posix("in-process MCP reports unavailable across a fake broker restart and accepts an explicit later call", async () => {
  let root: string | undefined, socket: string | undefined;
  const pending = new Set<Promise<unknown>>(), requests: { generation: number; method: unknown; params: unknown }[] = [];
  let callbacks = 0, closing = false, startupUnknown = false, stopUnknown = false, generation = 0;
  let broker: ReturnType<typeof Bun.serve> | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined, clientTransport: InMemoryTransport | undefined, serverTransport: InMemoryTransport | undefined;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); void promise.then(() => { pending.delete(promise); }, () => { pending.delete(promise); }); return promise;
  };
  const serve = async () => {
    if (closing || !socket || broker || startupUnknown || stopUnknown) throw new Error("Owned broker admission unavailable");
    startupUnknown = true;
    const current = ++generation;
    broker = Bun.serve({ unix: socket, async fetch(request) {
      callbacks++;
      try {
        if (closing) return Response.json({ ok: false, error: { code: "FIXTURE_CLOSING", message: "Owned fixture closing" } }, { status: 503 });
        const body = await request.json() as { method?: unknown; params?: unknown };
        requests.push({ generation: current, method: body.method, params: body.params });
        if (body.method !== "session.list") return Response.json({ ok: false, error: { code: "UNSUPPORTED", message: "Metadata fixture only" } });
        return Response.json({ ok: true, result: [] });
      } finally { callbacks--; }
    } });
    startupUnknown = false;
    await bounded(track(chmod(socket, 0o600)));
  };
  const stopBroker = async () => {
    if (!broker) return;
    if (pending.size || callbacks || startupUnknown || stopUnknown) throw new Error("Owned broker work unconfirmed; resources retained");
    stopUnknown = true;
    await bounded(track(Promise.resolve(broker.stop(true))));
    broker = undefined; stopUnknown = false;
  };
  const cleanup = async () => {
    closing = true; // Refuse new owned admissions before checking for unresolved work.
    if (pending.size || callbacks || startupUnknown || stopUnknown) throw new Error("Owned MCP work unconfirmed; transports/server/root retained");
    if (client) await bounded(track(client.close()));
    if (server) await bounded(track(server.close()));
    if (clientTransport) await bounded(track(clientTransport.close()));
    if (serverTransport) await bounded(track(serverTransport.close()));
    await stopBroker();
    if (pending.size || callbacks) throw new Error("Owned callback settlement unconfirmed; root retained");
    if (root) await bounded(track(rm(root, { recursive: true, force: true })));
  };
  let failed = false, primary: unknown;
  try {
    root = await mkdtemp(join(tmpdir(), "omr-")); socket = join(root, "b");
    client = new Client({ name: "owned-restart-test", version: "1" });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const activeClient = client;
    if (Buffer.byteLength(socket) > 100) throw new Error("Owned Unix socket path exceeds fixture bound");
    // Usage captures both values synchronously in its constructor. Restore BEFORE await.
    const saved = { ORBIT_USAGE_DIR: process.env.ORBIT_USAGE_DIR, ORBIT_CONVERSATION_ID: process.env.ORBIT_CONVERSATION_ID };
    const identity: ClientIdentity = { claim: { v: 1, kind: "adapter", pid: process.pid, start: "1", conversationId: "owned-restart" } };
    try {
      process.env.ORBIT_USAGE_DIR = join(root, "usage");
      process.env.ORBIT_CONVERSATION_ID = identity.claim.conversationId;
      server = createMcpServer(socket, identity);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await serve();
    // Track each side separately: an early Promise.all rejection cannot hide the other handshake.
    const connectedServer = track(server.connect(serverTransport)), connectedClient = track(activeClient.connect(clientTransport));
    await bounded(Promise.all([connectedServer, connectedClient]));
    const tools = (await bounded(track(activeClient.listTools()))).tools.map(tool => tool.name).sort();
    expect(tools.length).toBeGreaterThan(5);
    const status = async () => CallToolResultSchema.parse(await bounded(track(activeClient.callTool({ name: "orbit_status", arguments: {} }))));
    const initial = await status(); expect(initial.isError).not.toBe(true);
    expect(initial.content).toEqual([{ type: "text", text: "[]" }]);
    expect(requests).toEqual([{ generation: 1, method: "session.list", params: {} }]);

    await stopBroker();
    const during = await status(); // Must settle ERROR before a replacement listener exists.
    expect(during.isError).toBe(true);
    expect(during.structuredContent).toMatchObject({ code: "BROKER_UNAVAILABLE",
      disposition: { delivery: "unknown", retry: "unsafe" }, suggestion: "observe-before-retry" });
    expect(requests).toHaveLength(1);
    expect((await bounded(track(activeClient.listTools()))).tools.map(tool => tool.name).sort()).toEqual(tools);
    expect(pending.size).toBe(0);

    await serve(); expect(requests).toHaveLength(1); // No new request observed before an explicit caller action.
    const later = await status(); expect(later.isError).not.toBe(true);
    expect(later.content).toEqual([{ type: "text", text: "[]" }]);
    expect(requests).toEqual([{ generation: 1, method: "session.list", params: {} }, { generation: 2, method: "session.list", params: {} }]);
    expect((await bounded(track(activeClient.listTools()))).tools.map(tool => tool.name).sort()).toEqual(tools);
  } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (error) {
    if (failed) throw new AggregateError([primary, error], "Owned MCP restart fixture and cleanup failed");
    throw error;
  }
  if (failed) throw primary;
}, 15000);
