import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { expectDeclaredImage } from "./frame-format";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions } from "../src/session";
import { startBroker, call } from "../src/ipc";

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
    expect((await stat(broker.socket)).mode & 0o777).toBe(0o600);
    expect(await call(broker.socket, "doctor")).toMatchObject({ backend: "browser", sessions: 0 });
    await expect(call(broker.socket, "unknown")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const cli = Bun.spawn(["bun", "src/cli.ts", "doctor"], { env: { ...process.env, ORBIT_SOCKET: broker.socket }, stdout: "pipe", stderr: "pipe" });
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
    const child = Bun.spawn(["bun", "src/cli.ts", ...args], { env: { ...process.env, ORBIT_SOCKET: broker.socket }, stdout: "pipe", stderr: "pipe" });
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
