import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OrbitError } from "./errors";

export type UsageMode = "on" | "off";

/** An adapter preference, not an authorization boundary against same-user programs. */
export class ConversationUsage {
  private enabled = true;
  private readonly path?: string;
  constructor(readonly conversationId = process.env.ORBIT_CONVERSATION_ID,
    private readonly root = process.env.ORBIT_USAGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "sbar-orbit/usage")) {
    if (conversationId !== undefined) {
      if (!conversationId.trim() || conversationId.length > 256 || /[\x00-\x1f\x7f]/.test(conversationId))
        throw new OrbitError("INVALID_REQUEST", "Conversation ID must contain 1 to 256 characters without control characters");
      this.path = join(root, `${createHash("sha256").update(conversationId).digest("hex")}.json`);
    }
  }
  async status() {
    let enabled = this.enabled;
    if (this.path) {
      try {
        const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
        if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean")
          throw new Error("Invalid usage state");
        enabled = value.enabled;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw new OrbitError("USAGE_STATE_INVALID", "Cannot read conversation usage state; set usage on or off explicitly to repair it");
      }
    }
    return { enabled, scope: this.path ? "conversation" : "connection", ...(this.conversationId ? { conversationId: this.conversationId } : {}) };
  }
  async set(mode: UsageMode) {
    if (mode !== "on" && mode !== "off") throw new OrbitError("INVALID_REQUEST", "Use usage on, off or status");
    if (this.path) {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ enabled: mode === "on" }), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    } else this.enabled = mode === "on";
    return this.status();
  }
  async assertEnabled() {
    if (!(await this.status()).enabled)
      throw new OrbitError("ORBIT_DISABLED", "Orbit is disabled for this conversation. Re-enable only at the user's explicit request. Do not switch adapters or scopes to bypass it.");
  }
}
