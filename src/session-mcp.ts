import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call } from "./ipc";
import { OrbitError } from "./errors";
import { ConversationUsage } from "./conversation-usage";
import { splitFrame } from "./observation-output";
import { orbitActionSchema } from "./mcp";
import { serviceSocketPath } from "./service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { version } from "../package.json";

const id = z.string().min(1).max(16384);

/** A tool surface fixed to one already created Orbit session. */
export function createSessionMcpServer(socket: string, sessionId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new OrbitError("INVALID_REQUEST", "A session adapter needs an Orbit session ID");
  const usage = new ConversationUsage();
  const server = new McpServer({ name: "sbar-orbit-session", version }, {
    instructions: "These tools control one already created Orbit session. The session ID is fixed by the adapter and cannot be chosen in a tool call. Its private display and files are subject to the session policy. Do not use host screen or browser tools for this session. The user may disable Orbit usage for this conversation.",
  });
  const invoke = async (method: string, params: Record<string, unknown> = {}): Promise<CallToolResult> => {
    try {
      await usage.assertEnabled();
      const result = await call(socket, method, { ...params, sessionId });
      if (method === "session.observe") {
        const { image, metadata } = splitFrame(result);
        return { content: [{ type: "image", data: image, mimeType: metadata.mimeType },
          { type: "text", text: JSON.stringify(metadata) }], structuredContent: metadata };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }],
        ...(result && typeof result === "object" && !Array.isArray(result)
          ? { structuredContent: result as Record<string, unknown> } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        code: error instanceof OrbitError ? error.code : "BROKER_UNAVAILABLE",
        diagnosticId: error instanceof OrbitError ? error.diagnosticId : undefined,
        message: error instanceof OrbitError ? error.message : "Cannot reach the Orbit broker",
      }) }] };
    }
  };
  server.registerTool("orbit_observe", {
    description: "Observe this session only. Experimental native capture accepts appId and windowId, or the last explicitly acknowledged target. Native metadata is cached acknowledged state. Metadata mode avoids image capture.",
    inputSchema: { mode: z.enum(["image", "metadata"]).default("image"),
      appId: z.string().regex(/^[a-f0-9]{32}$/).optional(), windowId: z.string().regex(/^[a-f0-9]{32}$/).optional() },
  }, ({ mode, appId, windowId }) => invoke(mode === "metadata" ? "session.presence" : "session.observe",
    { ...(appId === undefined ? {} : { appId }), ...(windowId === undefined ? {} : { windowId }) }));
  server.registerTool("orbit_act", {
    description: "Perform one action in this session only. Reuse requestId when retrying an uncertain result. Codex launch-app with profile active uses a read-only gate to the running Desktop owner for limited account status, project names and conversation titles. It denies opening conversation bodies, model turns, commands and profile writes, and never copies the owner's profile as a fallback.",
    inputSchema: { requestId: id, action: orbitActionSchema },
  }, params => invoke("session.act", params));
  for (const operation of ["pause", "resume", "stop", "journal"] as const) {
    server.registerTool(`orbit_${operation}`, {
      description: `${operation} this session only.`, inputSchema: {},
    }, () => invoke(`session.${operation}`));
  }
  server.registerTool("orbit_narrow", {
    description: "Tighten this session policy. It cannot widen permissions.",
    inputSchema: {
      origins: z.array(z.string().url()).max(64).optional(),
      allow: z.array(z.enum(["read", "navigate", "write", "irreversible"])).max(4).optional(),
    },
  }, params => invoke("session.narrow", params));
  return server;
}

if (import.meta.main) {
  const sessionId = process.env.ORBIT_SESSION_ID;
  if (!sessionId) {
    console.error("ORBIT_SESSION_ID is required");
    process.exit(1);
  }
  let socket;
  try { socket = process.env.ORBIT_SOCKET || serviceSocketPath(); }
  catch { console.error("ORBIT_SOCKET is required, or a runtime directory the managed broker's socket can live in"); process.exit(1); }
  const server = createSessionMcpServer(socket, sessionId);
  await server.connect(new StdioServerTransport());
  const stop = async () => { await server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
}
