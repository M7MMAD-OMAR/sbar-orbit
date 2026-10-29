import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call } from "./ipc";
import { configureCaller, type ClientIdentity } from "./caller";
import { OrbitError } from "./errors";
import { ConversationUsage } from "./conversation-usage";
import { renderAct, renderObservation } from "./observation-output";
import { orbitActionSchema, orbitBatchShape } from "./mcp";
import { serviceSocketPath } from "./service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { version } from "../package.json";

const id = z.string().min(1).max(16384);

/** A tool surface fixed to one already created Orbit session. */
export function createSessionMcpServer(socket: string, sessionId: string, identity?: ClientIdentity) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new OrbitError("INVALID_REQUEST", "A session adapter needs an Orbit session ID");
  const usage = new ConversationUsage();
  const server = new McpServer({ name: "sbar-orbit-session", version }, {
    instructions: "These tools control one already created Orbit session. The session ID is fixed by the adapter and cannot be chosen in a tool call. Only its acknowledged original native application is subject to the session policy. Original browser and terminal applications use native controls. Hidden substitute desktops and copied profiles are absent. The user may disable Orbit usage for this conversation.",
  });
  const invoke = async (method: string, params: Record<string, unknown> = {}): Promise<CallToolResult> => {
    try {
      await usage.assertEnabled();
      const result = await call(socket, method, { ...params, sessionId }, undefined, identity);
      if (method === "session.observe") {
        return renderObservation(result);
      }
      if (method === "session.act" && result && typeof result === "object" && "receipts" in result) return renderAct(result);
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
      format: z.enum(["image", "text", "both"]).default("image").describe("image returns a screenshot. text returns a compact accessibility tree (role, name, states, box in click coordinates) and no screenshot, falling back to the screenshot when the application exposes no tree. both returns the two. Ignored when mode is metadata."),
      appId: z.string().regex(/^[a-f0-9]{32}$/).optional(), windowId: z.string().regex(/^[a-f0-9]{32}$/).optional() },
  }, ({ mode, format, appId, windowId }) => invoke(mode === "metadata" ? "session.presence" : "session.observe",
    { ...(format === "image" ? {} : { format }), ...(appId === undefined ? {} : { appId }), ...(windowId === undefined ? {} : { windowId }) }));
  server.registerTool("orbit_act", {
    description: "Act on this acknowledged original native application. Verify actual application acceptance after redraw. No launch or private profile actions exist. Reuse requestId after uncertain delivery.",
    inputSchema: { requestId: id, action: orbitActionSchema.optional(), ...orbitBatchShape },
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
  configureCaller({ kind: "adapter" });
  const server = createSessionMcpServer(socket, sessionId);
  await server.connect(new StdioServerTransport());
  const stop = async () => { try { await call(socket, "caller.detach"); } catch { /* the broker's poll covers a missed goodbye */ } await server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
}
