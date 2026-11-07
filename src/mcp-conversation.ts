import { z } from "zod";
import { clientIdentity, hostConversationId, isCanonicalConversationId, type ClientIdentity } from "./caller";
import { ConversationUsage } from "./conversation-usage";
import { OrbitError } from "./errors";
import { preflightDisposition } from "./error-disposition";
import { stateDirectory } from "./service";
import { join } from "node:path";

export const orbitConversationShape = {
  conversationId: z.string().refine(isCanonicalConversationId, "Use the exact actual host conversation ID")
    .optional().describe("Actual host conversation/thread ID. Pass it on EVERY call when the host does not set ORBIT_CONVERSATION_ID or a native thread environment variable. Use the same ID for CLI, retries and reconnects; never invent one or change it to bypass off. No global binding is changed."),
};

/** One shared MCP process may serve multiple conversations concurrently. */
export class McpConversations {
  private readonly root = process.env.ORBIT_USAGE_DIR ?? join(stateDirectory(), "usage");
  readonly usage: ConversationUsage;
  private readonly identity: ClientIdentity;

  constructor(socket: string, identity?: ClientIdentity) {
    const base = clientIdentity(socket, identity);
    const environment = hostConversationId(), claimed = base.claim.conversationId;
    if (environment !== undefined && claimed !== undefined && environment !== claimed)
      throw new OrbitError("INVALID_REQUEST", "Adapter identity and environment must name the same conversation", undefined, preflightDisposition);
    const fixed = environment ?? claimed;
    this.usage = new ConversationUsage(fixed, this.root);
    this.identity = fixed === undefined ? base : { ...base, claim: { ...base.claim, conversationId: fixed } };
  }

  scope(params: Record<string, unknown>) {
    const { conversationId, ...request } = params;
    if (conversationId !== undefined && (!isCanonicalConversationId(conversationId)
        || this.usage.conversationId !== undefined && conversationId !== this.usage.conversationId
        || this.identity.claim.conversationId !== undefined && conversationId !== this.identity.claim.conversationId))
      throw new OrbitError("INVALID_REQUEST", "conversationId must match this adapter's fixed conversation, if configured", undefined, preflightDisposition);
    const usage = conversationId === undefined || conversationId === this.usage.conversationId
      ? this.usage : new ConversationUsage(conversationId as string, this.root);
    const identity = conversationId === undefined ? this.identity
      : { ...this.identity, claim: { ...this.identity.claim, conversationId: conversationId as string } };
    return { request, usage, identity, assertEnabled: async () => {
      // A connection-local off predates any explicit ID and still blocks work.
      await this.usage.assertEnabled();
      if (usage !== this.usage) await usage.assertEnabled();
    } };
  }
}
