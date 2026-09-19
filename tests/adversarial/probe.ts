/**
 * Shared scaffolding for the adversarial suite.
 *
 * Every file here drives the composed entry point, `Sessions.dispatch`, which is the same object the
 * broker's socket and the MCP adapter both call into. A unit test on one side of that contract cannot
 * see a disagreement with the other side, which is the whole reason these are written this way.
 */
import { createWorkspaceDirectory } from "../../src/workspace-storage";
import { Sessions } from "../../src/session";

export type Run = (method: string, params?: unknown) => Promise<unknown>;

export async function openBroker(prefix: string) {
  const workspace = await createWorkspaceDirectory(prefix);
  const sessions = new Sessions(workspace);
  const run: Run = (method, params = {}) => sessions.dispatch({ method, params });
  return { workspace, sessions, run, close: () => sessions.close() };
}

/** A page whose paths are the shapes the immune table and the rules are supposed to catch. */
export function startFixture() {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: request => {
      const url = new URL(request.url);
      // Decoded before routing, which is what every ordinary web framework does and what makes a
      // percent encoded path a real destination rather than a curiosity.
      const path = decodeURIComponent(url.pathname);
      return new Response(
        `<!doctype html><title>Fixture ${path}</title><output id="result">${path}</output>`
        + `<input id="field"><button id="go" onclick="document.getElementById('result').textContent='clicked'">Go</button>`,
        { headers: { "Content-Type": "text/html" } });
    },
  });
}

export const act = (run: Run, sessionId: string, action: unknown) =>
  run("session.act", { sessionId, requestId: crypto.randomUUID(), action });

export type JournalView = {
  entries: { sequence: number; actionType: string; actor: string; outcome?: string; immuneId?: string; ruleId?: string; afterAllow?: string[] }[];
  policy: { allow: string[]; origins: string[] | "any" };
  path: string;
};
