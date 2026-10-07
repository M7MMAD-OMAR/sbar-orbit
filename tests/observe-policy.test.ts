import { BrowserBackend } from "../src/browser";
import { registerBrowserPhases } from "../src/browser-phase-observer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";


const phaseNote = (value: unknown) => { try { console.error(JSON.stringify({ browserPhaseDiagnostic: value })); } catch {} };
const phaseProducer = () => {
  try { return { browserIdentity: "not measured", loadedDependencyIdentity: "not measured", fixtureSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), producer: Object.fromEntries(["../src/browser.ts", "../src/browser-phase-observer.ts", "../src/session.ts", "../src/ipc.ts", "../bun.lock"].map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")])) }; }
  catch { return { sourceIdentity: "not measured" }; }
};

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
  const run = async (method: string, params: unknown = {}) => {
    const started = performance.now();
    console.error(JSON.stringify({observePolicyPhase:method,status:"start"}));
    try { return await sessions.dispatch({ method, params }); }
    finally { console.error(JSON.stringify({observePolicyPhase:method,status:"settled",elapsedMs:Math.round(performance.now()-started)})); }
  };
  let phases: ReturnType<typeof registerBrowserPhases>;
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await run("session.create", {
      backend: "browser", agentName: "observe-test", taskName: "policed capture",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate"] },
    }) as { sessionId: string };
    const session = { sessionId: created.sessionId };
    const owned = sessions["get"](created.sessionId);
    if (owned.backend instanceof BrowserBackend) phases = registerBrowserPhases(owned.backend, owned.backend.context, workspace, owned.profile, phaseNote);
    phaseNote({ producer: phaseProducer(), admitted: phases !== undefined, ownership: "fresh test backend/context/workspace/profile capability; Windows ACL not measured" });

    // While reading is allowed, a frame is returned: a boundary that refuses everything proves nothing.
    await run("session.act", { ...session, requestId: crypto.randomUUID(), action: { type: "navigate", url: `${origin}/` } });
    phases?.label("permitted-frame");
    phaseNote({ fixtureCall: "permitted-frame" });
    const frame = await run("session.observe", session) as { mimeType: string; image: string };
    expect(frame.mimeType).toBe("image/jpeg");
    expect(frame.image.length).toBeGreaterThan(0);

    // The person narrows the session so nothing may be read. This is the same call the immune set
    // makes when it contains a session, so the two are the same boundary.
    await run("session.narrow", { ...session, allow: [] });

    phases?.label("denied-after-narrow");
    phaseNote({ fixtureCall: "denied-after-narrow" });
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
    phases?.close();
    try { await sessions.close(); fixture.stop(true); }
    finally { phaseNote({ final: phases?.snapshot() ?? { admission: "not measured" }, fixtureStopAwaited: false }); }
  }
}, 60000);
