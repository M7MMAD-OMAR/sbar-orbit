import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { expectDeclaredImage } from "./frame-format";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions } from "../src/session";
import { startBroker, call } from "../src/ipc";
import { onBtrfs as onBtrfsPath } from "./platform-support";

test("broker owns concurrent sessions, deduplicates actions, pauses and cancels safely", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("session-test"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response('<input aria-label="text"><button onclick="document.querySelector(\'output\').textContent=++window.n">Add</button><output>0</output><script>window.n=0</script>', { headers: { "Content-Type": "text/html" } }) });
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    await expect(run("session.create", { backend: "desktop" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(run("session.stop", { sessionId: "missing" })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    const aPending = run("session.create", { backend: "browser", profileKey: "lease" });
    await expect(run("session.create", { backend: "browser", profileKey: "lease" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    const a = await aPending as { sessionId: string };
    const b = await run("session.create", { backend: "browser" }) as { sessionId: string };
    const act = (id: string, action: unknown, requestId: string = crypto.randomUUID()) => run("session.act", { sessionId: id, requestId, action });
    await Promise.all([a, b].map(s => act(s.sessionId, { type: "navigate", url: `http://127.0.0.1:${server.port}` })));
    const click = { type: "click", selector: "button" };
    await Promise.all([act(a.sessionId, click, "duplicate"), act(a.sessionId, click, "duplicate")]);
    expect(await act(a.sessionId, { type: "read", selector: "output" })).toEqual({ text: "1" });
    expect(await act(b.sessionId, { type: "read", selector: "output" })).toEqual({ text: "0" });
    await expect(act(a.sessionId, { type: "read", selector: "output" }, "duplicate")).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(act(a.sessionId, { type: "host-mouse" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await run("session.pause", a);
    await expect(act(a.sessionId, click)).rejects.toMatchObject({ code: "PAUSED" });
    await run("session.resume", a);
    await act(a.sessionId, click);
    expect(await act(a.sessionId, { type: "read", selector: "output" })).toEqual({ text: "2" });
    const queued = act(a.sessionId, { type: "click", selector: "#never-exists" });
    const outcome = queued.then(() => ({ code: "UNEXPECTED_SUCCESS" }), error => error);
    await Bun.sleep(50);
    const stopped = performance.now();
    await run("session.stop", a);
    expect(await outcome).toMatchObject({ code: "SESSION_CLOSED" });
    expect(performance.now() - stopped).toBeLessThan(5000);
    await expect(act(a.sessionId, click)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await act(b.sessionId, click);
    expect(await act(b.sessionId, { type: "read", selector: "output" })).toEqual({ text: "1" });
    const c = await run("session.create", { backend: "browser", profileKey: "lease" });
    expect(c).toMatchObject({ state: "running" });
    await expect(run("session.create", { backend: "browser", profileKey: "lease" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
  } finally { await sessions.close(); server.stop(true); }
}, 30000);

test("IPC socket is private and CLI talks to the running broker", async () => {
  const broker = await startBroker();
  try {
    // The private-mode assertion is POSIX. On Windows the socket file's ACL is what restricts it, and
    // `stat` on a bound AF_UNIX socket there answers EACCES rather than a mode at all; the inherited
    // ACL was measured separately as SYSTEM, Administrators and the owning user, with no Everyone.
    // Everything below is the actual IPC contract and runs on both.
    if (process.platform !== "win32") expect((await stat(broker.socket)).mode & 0o777).toBe(0o600);
    expect(await call(broker.socket, "doctor")).toMatchObject({ backend: "browser", sessions: 0 });
    await expect(call(broker.socket, "unknown")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const cli = Bun.spawn([process.execPath, "src/cli.ts", "doctor"], { env: { ...process.env, ORBIT_SOCKET: broker.socket }, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(cli.stdout).text())).toMatchObject({ ok: true, result: { sessions: 0 } });
    expect(await cli.exited).toBe(0);
  } finally { await broker.close(); }
});

test("pause drains accepted work and rejects new input; timeout permits recovery", async () => {
  const broker = await startBroker();
  const run = (method: string, params: unknown = {}) => broker.sessions.dispatch({ method, params });
  try {
    const session = await run("session.create", { backend: "browser" }) as { sessionId: string };
    const pending = run("session.act", { ...session, requestId: "wait", action: { type: "click", selector: "#missing" } })
      .then(() => ({ code: "UNEXPECTED_SUCCESS" }), error => error);
    const paused = run("session.pause", session);
    await expect(run("session.act", { ...session, requestId: "blocked", action: { type: "fill", selector: "input", text: "x" } })).rejects.toMatchObject({ code: "PAUSED" });
    await expect(run("session.resume", session)).rejects.toMatchObject({ code: "PAUSED" });
    expect(await pending).toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(await paused).toMatchObject({ state: "paused" });
    expect(await run("session.resume", session)).toMatchObject({ state: "running" });
    const frame = await run("session.observe", session) as { image: string };
    expectDeclaredImage(frame, "image/jpeg");
  } finally { await broker.close(); }
}, 30000);

test("CLI creates a session, acts on it, observes it and closes it", async () => {
  const broker = await startBroker();
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<p id="result">CLI connected</p>', { headers: { "Content-Type": "text/html" } }) });
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, ORBIT_SOCKET: broker.socket }, stdout: "pipe", stderr: "pipe" });
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    return result;
  };
  try {
    const { result: { sessionId } } = await cli("session", "create");
    await cli("act", sessionId, JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` }));
    expect(await cli("act", sessionId, JSON.stringify({ type: "read", selector: "#result" }))).toMatchObject({ result: { text: "CLI connected" } });
    const frame = await cli("session", "observe", sessionId);
    expectDeclaredImage(frame.result, "image/jpeg");
    expect(await cli("session", "stop", sessionId)).toMatchObject({ result: { state: "closed" } });
  } finally { await broker.close(); fixture.stop(true); }
}, 30000);

test("a journal line says where the boundary moved, not just that it moved", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("boundary-test"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<output>page</output>", { headers: { "Content-Type": "text/html" } }) });
  const origin = `http://127.0.0.1:${server.port}`;
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    const session = await run("session.create", {
      backend: "browser", policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    const journal = async () => (await run("session.journal", session) as { entries: { actionType: string; afterOrigins?: unknown; afterAllow?: unknown }[] }).entries;

    // An allowed action changed no boundary, so it carries none. A journal that repeated the policy on
    // every line would bury the lines where it actually moved.
    await run("session.act", { ...session, requestId: crypto.randomUUID(), action: { type: "navigate", url: origin } });
    expect((await journal()).at(-1)).toMatchObject({ actionType: "navigate" });
    expect((await journal()).at(-1)).not.toHaveProperty("afterOrigins");

    // An immune denial contains the session. The line records what is still permitted afterwards, which
    // is the part a reader of an autonomous run needs and cannot infer from the refusal.
    await expect(run("session.act", { ...session, requestId: crypto.randomUUID(),
      action: { type: "navigate", url: `${origin}/oauth/authorize?response_type=code&client_id=x` } }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
    const contained = (await journal()).at(-1);
    expect(contained).toMatchObject({ actionType: "navigate", outcome: "deny", immuneId: "oauth-grant" });
    expect(contained?.afterAllow).toEqual(["read", "navigate"]);
    expect(contained?.afterOrigins).toEqual([origin]);

    // And the same for a narrowing the person asked for.
    await run("session.narrow", { ...session, origins: [], allow: ["read"] });
    const narrowed = (await journal()).at(-1);
    expect(narrowed).toMatchObject({ actionType: "session.narrow", actor: "person" });
    expect(narrowed?.afterOrigins).toEqual([]);
    expect(narrowed?.afterAllow).toEqual(["read"]);
  } finally { await sessions.close(); server.stop(true); }
}, 30000);

test("a restore is refused far more often than it is granted, and says why", async () => {
  const workspace = await createWorkspaceDirectory("restore-session-test");
  const sessions = new Sessions(workspace);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<output>page</output>", { headers: { "Content-Type": "text/html" } }) });
  const origin = `http://127.0.0.1:${server.port}`;
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  const onBtrfs = await onBtrfsPath(workspace);
  try {
    const session = await run("session.create", {
      backend: "browser", policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string; egressTier: string };
    const act = (action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });

    // A restore replaces the profile under the session, so a queued action would run against a browser
    // that is not the one it was queued for.
    // On a filesystem that cannot snapshot a profile (ext4 on a runner, measured 14 September 2026)
    // the refusal is UNSUPPORTED before the pause is even considered; both are refusals that say why.
    await expect(run("session.restore", session)).rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_PAUSED|UNSUPPORTED)$/) });
    await expect(run("session.restore", { ...session, sequence: -1 })).rejects.toMatchObject({ code: expect.stringMatching(/^(INVALID_REQUEST|UNSUPPORTED)$/) });

    // Points are taken before the actions a snapshot could undo, and a resize is one of those.
    await act({ type: "resize", width: 900, height: 700 });
    await run("session.pause", session);
    if (!onBtrfs) {
      await expect(run("session.restore", session)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      return;
    }
    const journal = await run("session.journal", session) as { restorePoints: { sequence: number }[] };
    expect(journal.restorePoints.length).toBeGreaterThan(0);

    // The granted case. A session that has only read, observed, scrolled or resized can be put back,
    // and the browser works afterwards, on the same lease it had before.
    const latest = journal.restorePoints.at(-1)?.sequence ?? -1;
    const restored = await run("session.restore", session) as { restoredTo: number; restorePoints: unknown[] };
    expect(restored.restoredTo).toBe(latest);
    // The point used is gone with everything after it: the session's history past that line did not happen.
    expect(restored.restorePoints.length).toBe(journal.restorePoints.length - 1);
    await run("session.resume", session);
    // A point of its own, before the session browses anywhere, so the refusal below is about what
    // happened after this line rather than about there being no point to return to.
    await act({ type: "resize", width: 1000, height: 800 });
    const beforeBrowsing = (await run("session.journal", session) as { restorePoints: { sequence: number }[] }).restorePoints.at(-1)?.sequence;
    await act({ type: "navigate", url: origin });
    expect(await act({ type: "read", selector: "output" })).toEqual({ text: "page" });
    const after = await run("session.journal", session) as { entries: { actionType: string }[]; egressTier: string };
    expect(after.entries.some(entry => entry.actionType === "session.restore")).toBe(true);
    // The lease is the broker's and outlives any one browser, so the tier did not change under the
    // journal line that already recorded it.
    expect(after.egressTier).toBe(session.egressTier);

    // And now the refusal that matters. A point taken BEFORE the navigation cannot be returned to,
    // because the navigation left an access entry on a service and no local snapshot retracts it. The
    // most recent point is a different question: it was taken after the navigation, so returning to it
    // takes nothing back that left the machine.
    expect(beforeBrowsing).toBeDefined();
    await run("session.pause", session);
    const refused = await run("session.restore", { ...session, sequence: beforeBrowsing })
      .then(() => null, (error: { code: string; message: string }) => error);
    expect(refused?.code).toBe("RESTORE_REFUSED");
    expect(refused?.message).toContain("does not undo what it cannot undo");
    // And an unknown point is a refusal too, rather than a restore to the nearest thing.
    await expect(run("session.restore", { ...session, sequence: 99999 })).rejects.toMatchObject({ code: "RESTORE_REFUSED" });
  } finally { await sessions.close(); server.stop(true); }
}, 60000);

test("system is an alias for the private display, and one name comes back", async () => {
  const broker = await startBroker();
  try {
    // Not the backend itself: this host may have no wlroots runtime, and the point is only that the
    // alias resolves to the same backend rather than to an unknown one.
    const unknown = call(broker.socket, "session.create", { backend: "desktop" });
    await expect(unknown).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const doctor = await call(broker.socket, "doctor") as { backends: string[]; backendAliases: Record<string, string> };
    expect(doctor.backends).toEqual(["browser", "fedora"]);
    expect(doctor.backendAliases).toEqual({ system: "fedora" });

    if (process.env.ORBIT_TEST_NATIVE !== "1") return;
    const session = await call(broker.socket, "session.create", { backend: "system" }) as { sessionId: string; backend: string };
    // Reported canonically, so status, observation and the journal never carry two names for one thing.
    expect(session.backend).toBe("fedora");
    const listed = await call(broker.socket, "session.list") as { sessionId: string; backend: string }[];
    expect(listed.find(entry => entry.sessionId === session.sessionId)?.backend).toBe("fedora");
    await call(broker.socket, "session.stop", { sessionId: session.sessionId });
  } finally { await broker.close(); }
}, 60000);
