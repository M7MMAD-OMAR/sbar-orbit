import { test, expect } from "bun:test";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";

/**
 * The origin lease, on the one path that used to fail OPEN.
 *
 * A document request to a leased origin is fetched a hop at a time, so a server side redirect to
 * somewhere else is caught before the browser ever sees it. That fetch can fail: a slow upstream
 * against the context's 5 second default, a response shape the driver refuses, a connection reset
 * mid answer. The catch used to call `route.continue()`, which hands the request back to the browser
 * to follow the redirect chain ITSELF, and the browser does not consult the lease between hops. So
 * the single case the hop at a time fetch exists to close was reopened by anything that could make
 * one fetch fail, and a page can arrange that.
 *
 * This drives it with a server that answers the hop fetch by destroying the connection, and asserts
 * the load is refused and the origin recorded rather than quietly followed.
 */
test("a document whose redirect hop cannot be fetched is refused, not handed to the browser", async () => {
  const workspace = await createWorkspaceDirectory("lease-failclosed-test");
  const sessions = new Sessions(workspace);
  let offLeaseHits = 0;
  // Where a redirect would land. Nothing may reach it.
  const offLease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    offLeaseHits++;
    return new Response("<output>off lease</output>", { headers: { "Content-Type": "text/html" } });
  } });
  // The leased origin. `/` is an ordinary page so the session is usable; `/broken` is a document
  // request whose hop fetch cannot complete, because the socket is closed without a reply.
  const leased = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/broken") {
        // Abort the connection rather than answer it: `route.fetch` throws, which is the branch
        // under test. A redirect here would be the ordinary, already covered case.
        server.timeout(request, 1);
        return new Promise<Response>(() => {});
      }
      return new Response('<!doctype html><title>Leased</title><output>leased page</output>',
        { headers: { "Content-Type": "text/html" } });
    } });
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    const created = await run("session.create", {
      backend: "browser", agentName: "lease-test", taskName: "fail closed",
      policy: { mode: "autonomous", origins: [`http://127.0.0.1:${leased.port}`], allow: ["read", "navigate"] },
    }) as { sessionId: string };
    const act = (action: unknown) => run("session.act", { sessionId: created.sessionId, requestId: crypto.randomUUID(), action });

    // The session works on the leased origin, because a lease that breaks browsing proves nothing.
    await act({ type: "navigate", url: `http://127.0.0.1:${leased.port}/` });
    expect(await act({ type: "read", selector: "output" })).toEqual({ text: "leased page" });

    // The hop fetch fails here. Fail closed means the navigation does not succeed and the browser is
    // never handed the request to follow on its own.
    await expect(act({ type: "navigate", url: `http://127.0.0.1:${leased.port}/broken` }))
      .rejects.toMatchObject({ code: expect.stringMatching(/BACKEND_FAILED|TIMEOUT|BACKEND_ERROR/) });
    expect(offLeaseHits).toBe(0);

    // And it is recorded, so a person reading the journal sees a refusal rather than a silence.
    const journal = await run("session.journal", { sessionId: created.sessionId }) as { blockedOrigins: string[] };
    expect(journal.blockedOrigins).toContain(`http://127.0.0.1:${leased.port}`);
  } finally {
    await sessions.close();
    leased.stop(true); offLease.stop(true);
  }
}, 60000);
