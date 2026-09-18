import { test, expect } from "bun:test";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";

/**
 * Observation is an action the policy decides, not a free read.
 *
 * `classify("observe")` has always answered `read`, which reads as though capture were policed. It
 * was not: `decide()` was reached only from `act()`, and `session.observe` is dispatched on its own
 * path, so a session created with `allow: []` still answered with a full frame of the page.
 *
 * Why that is the security half rather than a tidiness one: a frame is the page's CONTENT. For a
 * session started from a clone of the person's own profile it is the contents of their logged-in
 * accounts, handed to an agent whose policy said it could do nothing. And the immune set, which
 * fires exactly when the agent is either compromised or wrong, contains a session by narrowing it,
 * so an unpoliced capture survived the containment that was supposed to stop the agent.
 */
test("a session whose policy allows no reading is refused a frame, and the refusal is journalled", async () => {
  const workspace = await createWorkspaceDirectory("observe-policy-test");
  const sessions = new Sessions(workspace);
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response('<!doctype html><title>Fixture</title><output>secret page</output>',
      { headers: { "Content-Type": "text/html" } }) });
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await run("session.create", {
      backend: "browser", agentName: "observe-test", taskName: "policed capture",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate"] },
    }) as { sessionId: string };
    const session = { sessionId: created.sessionId };

    // While reading is allowed, a frame is returned: a boundary that refuses everything proves nothing.
    await run("session.act", { ...session, requestId: crypto.randomUUID(), action: { type: "navigate", url: `${origin}/` } });
    const frame = await run("session.observe", session) as { mimeType: string; image: string };
    expect(frame.mimeType).toBe("image/jpeg");
    expect(frame.image.length).toBeGreaterThan(0);

    // The person narrows the session so nothing may be read. This is the same call the immune set
    // makes when it contains a session, so the two are the same boundary.
    await run("session.narrow", { ...session, allow: [] });

    await expect(run("session.observe", session)).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // Refused, and RECORDED: a reader of an autonomous run must see the attempt rather than a gap.
    const journal = await run("session.journal", session) as { entries: { actionType: string; outcome?: string }[] };
    const refusal = journal.entries.at(-1);
    expect(refusal?.actionType).toBe("observe");
    expect(refusal?.outcome).toBe("deny");

    // Presence stays available, deliberately: it is metadata a desktop indicator polls, and it
    // carries no page content. Losing it would blind the person rather than the agent.
    expect(await run("session.presence", session)).toMatchObject({ location: expect.any(String) });
  } finally {
    await sessions.close();
    fixture.stop(true);
  }
}, 60000);
