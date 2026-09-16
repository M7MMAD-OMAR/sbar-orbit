import { test, expect } from "bun:test";
import { connect, listen } from "bun";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { leasedAuthorities, openEgressLease } from "../src/egress";
import { detectPlatform } from "../src/platform";
import { Sessions } from "../src/session";
import { expectPrivatePath } from "./private-path";

const confinable = (await detectPlatform()).confinedEgress;

/** Speak to the lease the way a browser does, and report exactly what came back. */
async function throughProxy(socketPath: string, request: string, expectBytes = true): Promise<{ reply: string }> {
  let reply = "";
  const client = await connect<undefined>({
    unix: socketPath,
    socket: { data: (_socket, chunk) => { reply += new TextDecoder().decode(chunk); }, close: () => {}, error: () => {} },
  });
  client.write(request);
  for (let attempt = 0; attempt < 100 && (expectBytes ? !reply : attempt < 20); attempt++) await Bun.sleep(20);
  client.end();
  return { reply };
}

test("what a lease on an origin means to a proxy that is only told an authority", () => {
  // CONNECT names host and port and nothing else, so this is the resolution the layer below the
  // browser can work at. The default port is implied by the scheme and the tunnel will not say it.
  expect(leasedAuthorities(["https://example.com"])).toEqual(["example.com:443"]);
  expect(leasedAuthorities(["http://example.com"])).toEqual(["example.com:80"]);
  expect(leasedAuthorities(["http://127.0.0.1:8080"])).toEqual(["127.0.0.1:8080"]);
  // Both schemes of one host collapse to two authorities, not one.
  expect(leasedAuthorities(["https://a.test", "http://a.test"]).sort()).toEqual(["a.test:443", "a.test:80"]);
  // Deduplicated, and anything that is not an origin an http lease can mean is dropped rather than
  // guessed at.
  expect(leasedAuthorities(["https://a.test", "https://a.test"])).toEqual(["a.test:443"]);
  expect(leasedAuthorities(["chrome://settings", "not a url", "file:///etc"])).toEqual([]);
});

test("a host that cannot confine a browser says so instead of pretending", async () => {
  const root = await mkdtemp(join(homedir(), ".cache", "orbit-egress-tier-"));
  try {
    const lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: false, origins: () => ["https://a.test"],
    });
    // The tier drops, the session still runs, and the browser is started as it always was.
    expect(lease.tier).toBe("in-browser");
    expect(lease.launch.executable).toBe("/opt/google/chrome/chrome");
    expect(lease.launch.args).toEqual([]);
    expect(lease.endpointPort).toBe(0);
    expect(lease.refused()).toEqual([]);
    // And nothing was built: no sockets, no wrapper, no directory.
    await expect(stat(join(root, "egress"))).rejects.toThrow();
    await lease.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a path too long for a unix socket drops the tier instead of truncating it", async () => {
  const root = await mkdtemp(join(homedir(), ".cache", "orbit-egress-long-"));
  // 108 bytes is the kernel's limit, and past it the path is silently shortened: the relay binds one
  // path, nothing dials it, and the session waits out its deadline on a browser that started perfectly.
  const tooLong = join(root, "a".repeat(120));
  try {
    const lease = await openEgressLease({
      directory: tooLong, executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: true, origins: () => ["https://a.test"],
    });
    expect(lease.tier).toBe("in-browser");
    await expect(stat(tooLong)).rejects.toThrow();
    await lease.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("the lease forwards the authorities it holds and refuses the rest", async () => {
  const root = await mkdtemp(join(homedir(), ".cache", "orbit-egress-proxy-"));
  let reached = 0;
  const target = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { open: socket => { reached++; socket.end(); }, data: () => {}, close: () => {} } });
  let origins = [`https://127.0.0.1:${target.port}`];
  try {
    const lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: true, origins: () => origins,
    });
    expect(lease.tier).toBe("namespace");
    const socketPath = join(root, "egress", "lease.sock");
    // The directory holds a live route out of a session carrying real logins.
    await expectPrivatePath(join(root, "egress"), 0o700);

    // A leased authority is tunnelled: the far end saw a connection, which is the only evidence that
    // does not depend on what the browser was told.
    const allowed = await throughProxy(socketPath, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(allowed.reply).toContain("200 Connection Established");
    expect(reached).toBe(1);

    // An unleased one is refused before anything is opened, and recorded as refused.
    const denied = await throughProxy(socketPath, "CONNECT unleased.test:443 HTTP/1.1\r\nHost: unleased.test:443\r\n\r\n");
    expect(denied.reply).toContain("403");
    expect(reached).toBe(1);
    expect(lease.refused()).toEqual(["unleased.test:443"]);

    // Plain HTTP carries the scheme, so at this layer the same host on the other scheme is a different
    // thing and is refused, even though its authority differs only in the port the lease implied.
    const wrongScheme = await throughProxy(socketPath, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(wrongScheme.reply).toContain("403");
    expect(reached).toBe(1);

    // Narrowing reaches this layer too. The origins are read on every request rather than copied when
    // the lease was opened, so a session that tightens itself tightens the route out as well.
    origins = [];
    const afterNarrowing = await throughProxy(socketPath, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(afterNarrowing.reply).toContain("403");
    expect(reached).toBe(1);
    expect(lease.refused()).toContain(`127.0.0.1:${target.port}`);

    // A request line that never ends forwards nothing and is dropped rather than buffered forever.
    const unterminated = await throughProxy(socketPath, "GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\n", false);
    expect(unterminated.reply).toBe("");

    await lease.close();
    // Closing takes the sockets and the wrapper with it: a route out that outlives its session is a
    // route out nothing is watching.
    await expect(stat(join(root, "egress"))).rejects.toThrow();
  } finally { target.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("a leased session browses through a network of its own, and an unleased origin is unreachable", async () => {
  const workspace = await createWorkspaceDirectory("egress-session-test");
  const sessions = new Sessions(workspace);
  let leasedHits = 0, unleasedHits = 0;
  const unleased = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unleasedHits++; return new Response("<output>unleased</output>", { headers: { "Content-Type": "text/html" } }); } });
  // The leased page reaches for the unleased origin itself. No agent action asks for that, which is
  // the whole reason a lease exists below the agent as well as in front of it.
  const leased = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    leasedHits++;
    return new Response(`<output>leased page</output><script>fetch("http://127.0.0.1:${unleased.port}/from-the-page", { mode: "no-cors" }).catch(() => {})</script>`,
      { headers: { "Content-Type": "text/html" } });
  } });
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    const created = await run("session.create", {
      backend: "browser", agentName: "egress-test", taskName: "confined session",
      policy: { mode: "autonomous", origins: [`http://127.0.0.1:${leased.port}`], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string; egressTier: string };
    const leaseDirectory = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "sbar-orbit", "egress", created.sessionId.slice(0, 8));
    // The browser was given no network of its own on a host that can do that.
    expect(created.egressTier).toBe("namespace");

    const act = (action: unknown) => run("session.act", { sessionId: created.sessionId, requestId: crypto.randomUUID(), action });
    await act({ type: "navigate", url: `http://127.0.0.1:${leased.port}/` });
    // A confined session that cannot browse is not confined, it is broken.
    expect(await act({ type: "read", selector: "output" })).toEqual({ text: "leased page" });
    expect(leasedHits).toBeGreaterThan(0);

    // The agent is refused by the policy before the browser is asked, which is the layer above.
    await expect(act({ type: "navigate", url: `http://127.0.0.1:${unleased.port}/` })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // And what the page reached for on its own never arrived. Both layers hold this: which one held it
    // first is isolated in `experiments/confined-egress.ts`, where the browser is confined and the
    // interception is not installed at all.
    await Bun.sleep(500);
    expect(unleasedHits).toBe(0);
    const blocked = await run("session.journal", { sessionId: created.sessionId }) as { blockedOrigins: string[] };
    expect(blocked.blockedOrigins).toContain(`http://127.0.0.1:${unleased.port}`);

    const journal = await run("session.journal", { sessionId: created.sessionId }) as { entries: { reason?: string }[]; egressTier: string; refusedAuthorities: string[] };
    // The first line says what was agreed to, including which layer held the lease, because a reader
    // of an autonomous run cannot otherwise tell a confined session from an unconfined one.
    expect(journal.entries[0]?.reason).toContain("network namespace of its own");
    expect(journal.egressTier).toBe("namespace");
    // Chrome reaches for its own services on startup, and on this path those are refused like anything
    // else, so the lease has something to report rather than nothing.
    expect(Array.isArray(journal.refusedAuthorities)).toBe(true);

    // The route out exists while the session does.
    await expect(stat(leaseDirectory)).resolves.toBeTruthy();
    await run("session.stop", { sessionId: created.sessionId });
    // And nothing of it survives the session it belonged to: the proxy, the relay, the wrapper and the
    // sockets go together, because each one is a way into a browser holding real logins.
    await expect(stat(leaseDirectory)).rejects.toThrow();
  } finally { await sessions.close(); leased.stop(true); unleased.stop(true); }
}, 60000);

test("an unbounded session is left exactly as it was, because there is nothing to enforce", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("egress-any-test"));
  try {
    // A fresh profile session names no origins, and a namespace whose proxy forwards everything would
    // add a hop and no boundary. This is also what keeps every session measured before this change on
    // the path it was measured on.
    const created = await sessions.dispatch({ method: "session.create", params: { backend: "browser" } }) as { sessionId: string; egressTier: string };
    expect(created.egressTier).toBe("in-browser");
    const journal = await sessions.dispatch({ method: "session.journal", params: { sessionId: created.sessionId } }) as { entries: { reason?: string }[] };
    expect(journal.entries[0]?.reason).not.toContain("egress held");
  } finally { await sessions.close(); }
}, 30000);
