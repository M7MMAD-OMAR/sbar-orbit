import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { NativeBackend } from "../src/hyprland";
import { OrbitError } from "../src/errors";
import { ownerCredentialPath, processStart, readOwnerCredential, resolveCaller, type ClientIdentity, type ProcessProbe } from "../src/caller";
import type { SessionOptions } from "../src/session";

/**
 * Two agents on one broker, over the real socket, with a fake native backend. Each agent is a real
 * process id (a sleeping child) so that killing it is a real disappearance the broker has to notice.
 */
const native = { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" };
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function agent(conversationId: string, host: string) {
  const child = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { child.kill(); });
  const identity: ClientIdentity = { claim: { v: 1, kind: "adapter", pid: child.pid, start: processStart(child.pid), conversationId, host } };
  return { child, identity };
}

/** The plugin's lease table in miniature: one holder per workspace, refused with the plugin's own wording. */
function fakeNative(hang = false) {
  const held = new Map<number, string>();
  const closed: string[] = [];
  let counter = 0;
  const spy = spyOn(NativeBackend, "create").mockImplementation((async (_profile: string, _options: unknown, handoff: { workspace: number }) => {
    const existing = held.get(handoff.workspace);
    if (existing) throw new OrbitError("APPLICATION_BUSY", `The application client is already leased or native lease capacity is reached. Application client is already leased by lease ${existing} (worker pid 4242); its worker is alive`);
    const appId = (++counter).toString(16).padStart(32, "0");
    held.set(handoff.workspace, appId);
    const windowId = "f".repeat(32);
    return {
      capabilities: ["click"], surface: { width: 10, height: 10 },
      handoff: { workspace: handoff.workspace, appId, selectedWindowId: windowId, scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 1, y: 1 },
        windows: [{ appId, windowId, title: `App ${handoff.workspace}`, width: 10, height: 10 }] },
      parseAction: (value: Record<string, unknown>) => ({ ...value }),
      act: async (action: { type: string }) => ({ response: "ok", type: action.type }),
      presence: async () => ({ title: "fake" }),
      onClose() {},
      close: async () => { if (hang) await new Promise(() => {}); held.delete(handoff.workspace); closed.push(appId); },
    };
  }) as never);
  cleanups.push(() => spy.mockRestore());
  return { held, closed };
}

async function broker(session: SessionOptions = {}, probe?: ProcessProbe) {
  const started = await startBroker({ native, session: { pollMs: 100, graceSeconds: () => 1, closeDeadlineMs: 300, workspacePool: [20, 25], ...session }, probe });
  cleanups.push(() => started.close());
  return started;
}
const handoff = (workspace: number, task: string, extra: Record<string, unknown> = {}) =>
  ({ backend: "native", handoff: { workspace }, agentName: "Test", taskName: task, ...extra });
const code = async (promise: Promise<unknown>) => promise.then(() => "ok", (error: OrbitError) => `${error.code}: ${error.message}`);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("each agent sees its own sessions in full and the other as a summary with nothing to act with", async () => {
  fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string; ownerLabel: string };
  const theirs = await call(socket, "session.create", handoff(22, "Beta task"), undefined, b.identity) as { sessionId: string; ownerLabel: string };
  expect(mine.ownerLabel).toMatch(/^Claude \([0-9a-f]{4}\)$/);
  expect(theirs.ownerLabel).toMatch(/^Codex \([0-9a-f]{4}\)$/);

  const seenByA = await call(socket, "session.list", {}, undefined, a.identity) as Record<string, unknown>[];
  const full = seenByA.find(entry => entry.sessionId === mine.sessionId)!;
  expect(full.handoff).toBeDefined();
  const summary = seenByA.find(entry => entry.redacted)!;
  expect(summary).toEqual({ redacted: true, label: theirs.ownerLabel, taskName: "Beta task", application: "App 22", workspace: 22,
    state: "running", idleSeconds: expect.any(Number), ownerState: "connected" });
  expect(JSON.stringify(seenByA)).not.toContain(theirs.sessionId);

  const seenByB = await call(socket, "session.list", {}, undefined, b.identity) as Record<string, unknown>[];
  expect(seenByB.filter(entry => entry.sessionId).map(entry => entry.sessionId)).toEqual([theirs.sessionId]);
  expect(JSON.stringify(seenByB)).not.toContain(mine.sessionId);
});

test("another agent's session is refused on every verb, naming the owner and its state", async () => {
  fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string; ownerLabel: string };
  const sessionId = mine.sessionId;
  const requests: [string, Record<string, unknown>][] = [
    ["session.act", { sessionId, requestId: "r1", action: { type: "close-window", appId: "1".repeat(32), windowId: "f".repeat(32) } }],
    ["session.act", { sessionId, requestId: "r2", action: { type: "mouse-down", appId: "1".repeat(32), windowId: "f".repeat(32), x: 1, y: 1 } }],
    ["session.act", { sessionId, requestId: "r3", action: { type: "close-application", appId: "1".repeat(32) } }],
    ["session.pause", { sessionId }], ["session.resume", { sessionId }], ["session.stop", { sessionId }],
    ["session.forget", { sessionId }], ["session.narrow", { sessionId, allow: ["read"] }],
    ["session.observe", { sessionId }], ["session.presence", { sessionId }], ["session.journal", { sessionId }],
  ];
  for (const [method, params] of requests) {
    const answer = await code(call(socket, method, params, undefined, b.identity));
    expect(answer).toStartWith("SESSION_NOT_OWNED: ");
    expect(answer).toContain(mine.ownerLabel);
    expect(answer).toContain("running");
    expect(answer).toContain("Alpha task");
  }
  // Nothing happened to it, and its owner still can.
  const list = await call(socket, "session.list", {}, undefined, a.identity) as { state: string }[];
  expect(list[0]!.state).toBe("running");
  expect(await call(socket, "session.pause", { sessionId }, undefined, a.identity)).toMatchObject({ state: "paused" });
});

test("a request with no valid claim is an unidentified agent, never the owner, and the owner credential is private", async () => {
  fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string };
  const raw = (method: string, params: unknown, headers: Record<string, string> = {}) =>
    fetch("http://localhost/rpc", { unix: socket, method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ method, params }) }).then(r => r.json()) as Promise<{ ok: boolean; error?: { code: string }; result?: unknown }>;
  expect((await raw("session.stop", { sessionId: mine.sessionId })).error?.code).toBe("SESSION_NOT_OWNED");
  expect((await raw("session.stop", { sessionId: mine.sessionId }, { "x-orbit-caller": "!!not-base64-json" })).error?.code).toBe("SESSION_NOT_OWNED");
  // A claim for a process that does not exist, or whose start time is wrong, does not verify.
  const forged = (pid: number, start: string) => Buffer.from(JSON.stringify({ v: 1, kind: "adapter", pid, start, conversationId: "conv-a" })).toString("base64url");
  expect((await raw("session.stop", { sessionId: mine.sessionId }, { "x-orbit-caller": forged(a.child.pid, "1") })).error?.code).toBe("SESSION_NOT_OWNED");
  expect((await raw("session.stop", { sessionId: mine.sessionId }, { "x-orbit-caller": forged(999999, "1") })).error?.code).toBe("SESSION_NOT_OWNED");
  expect((await raw("session.stop", { sessionId: mine.sessionId }, { "x-orbit-owner": "0".repeat(64) })).error?.code).toBe("SESSION_NOT_OWNED");
  expect((await raw("session.list", {})).result).toEqual([expect.objectContaining({ redacted: true })]);

  expect((await stat(ownerCredentialPath(socket))).mode & 0o777).toBe(0o600);
  const token = readOwnerCredential(socket)!;
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const asOwner = await raw("session.list", {}, { "x-orbit-owner": token });
  expect(asOwner.result).toEqual([expect.objectContaining({ sessionId: mine.sessionId, ownerState: "connected" })]);
  expect((await raw("session.stop", { sessionId: mine.sessionId }, { "x-orbit-owner": token })).ok).toBe(true);
});

test("the claim is checked against the process table", () => {
  const probe: ProcessProbe = { start: pid => pid === 50 ? "777" : undefined, owner: pid => pid === 51 ? 0 : 1000, alive: pid => pid === 50 || pid === 51 };
  const header = (value: object) => Buffer.from(JSON.stringify({ v: 1, kind: "adapter", ...value })).toString("base64url");
  expect(resolveCaller(header({ pid: 50, start: "777", host: "Claude" }), probe, 1000)).toMatchObject({ verified: true, role: "agent", id: "proc:50:777" });
  expect(resolveCaller(header({ pid: 50, start: "777", conversationId: "x" }), probe, 1000).id).toBe("conv:x");
  expect(resolveCaller(header({ pid: 50, start: "778" }), probe, 1000).verified).toBe(false);
  expect(resolveCaller(header({ pid: 51, start: "1" }), probe, 1000).verified).toBe(false);
  expect(resolveCaller(header({ pid: 52 }), probe, 1000).verified).toBe(false);
  expect(resolveCaller(undefined, probe, 1000).verified).toBe(false);
});

test("stop with scope mine stops exactly the caller's own sessions and lists them", async () => {
  const { closed } = fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex");
  const a1 = await call(socket, "session.create", handoff(21, "One"), undefined, a.identity) as { sessionId: string };
  const a2 = await call(socket, "session.create", handoff(22, "Two"), undefined, a.identity) as { sessionId: string };
  const b1 = await call(socket, "session.create", handoff(23, "Three"), undefined, b.identity) as { sessionId: string };
  const result = await call(socket, "session.stop", { scope: "mine" }, undefined, a.identity) as { stopped: { sessionId: string; taskName: string }[]; owner: string };
  expect(result.stopped.map(entry => entry.sessionId).sort()).toEqual([a1.sessionId, a2.sessionId].sort());
  expect(closed.length).toBe(2);
  const left = await call(socket, "session.list", {}, undefined, b.identity) as { sessionId?: string; state: string }[];
  expect(left.find(entry => entry.sessionId === b1.sessionId)!.state).toBe("running");
  await expect(call(socket, "session.stop", { scope: "mine", sessionId: b1.sessionId }, undefined, a.identity)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("a killed adapter's sessions pause at once, stop after the grace period, and the lease comes free", async () => {
  const { held, closed } = fakeNative();
  const { socket } = await broker({ graceSeconds: () => 1.2 });
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string };
  await call(socket, "session.create", handoff(22, "Beta task"), undefined, b.identity);
  // The owner credential lets this test read the session by id without being either agent.
  const owner = { claim: b.identity.claim, ownerToken: readOwnerCredential(socket) };
  const state = async () => (await call(socket, "session.list", {}, undefined, owner) as { sessionId: string; state: string; ownerState: string }[]).find(entry => entry.sessionId === mine.sessionId)!;

  a.child.kill("SIGKILL");
  await a.child.exited;
  const killedAt = Date.now();
  let seen = await state();
  while (seen.state === "running" && Date.now() - killedAt < 3000) { await delay(50); seen = await state(); }
  expect(Date.now() - killedAt).toBeLessThan(1000);
  expect(["pausing", "paused"]).toContain(seen.state);
  expect(seen.ownerState).toBe("disconnected");
  expect(closed.length).toBe(0);
  expect(held.get(21)).toBeDefined();
  // The other agent was not touched.
  expect((await call(socket, "session.list", {}, undefined, b.identity) as { state: string }[]).filter(entry => entry.state === "running").length).toBe(1);

  // What a second agent is told while the dead one's session still holds the application.
  const busy = await code(call(socket, "session.create", handoff(21, "Gamma"), undefined, b.identity));
  expect(busy).toStartWith("APPLICATION_BUSY: ");
  expect(busy).toContain("Claude (");
  expect(busy).toContain('"Alpha task"');
  expect(busy).toContain("its adapter is gone");

  while ((await state()).state !== "closed" && Date.now() - killedAt < 5000) await delay(100);
  expect((await state()).state).toBe("closed");
  expect(Date.now() - killedAt).toBeGreaterThan(1100);
  expect(held.has(21)).toBe(false);
  expect(closed.length).toBe(1);
  expect(await call(socket, "session.create", handoff(21, "Gamma"), undefined, b.identity)).toMatchObject({ state: "running" });
});

test("a caller that returns inside the grace period keeps its sessions, paused until it resumes them", async () => {
  const { closed } = fakeNative();
  const { socket } = await broker({ graceSeconds: () => 1 });
  const first = agent("conv-a", "Claude");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, first.identity) as { sessionId: string };
  first.child.kill("SIGKILL"); await first.child.exited;
  await delay(400);
  const second = agent("conv-a", "Claude");
  expect(await call(socket, "session.list", {}, undefined, second.identity)).toEqual([expect.objectContaining({ sessionId: mine.sessionId, ownerState: "connected" })]);
  await delay(1500);
  expect(closed.length).toBe(0);
  expect(await call(socket, "session.resume", { sessionId: mine.sessionId }, undefined, second.identity)).toMatchObject({ state: "running" });
});

test("a session stuck in closing is forced closed and its plugin lease released without the repair path seeing it as live", async () => {
  const { held } = fakeNative(true);
  const released: { id: string; live: string[] }[] = [];
  const { socket } = await broker({ releaseLease: async (id, live) => { released.push({ id, live }); } });
  const a = agent("conv-a", "Claude");
  const one = await call(socket, "session.create", handoff(21, "Stuck"), undefined, a.identity) as { sessionId: string; handoff: { appId: string } };
  const two = await call(socket, "session.create", handoff(22, "Fine"), undefined, a.identity) as { handoff: { appId: string } };
  const started = Date.now();
  const result = await call(socket, "session.stop", { sessionId: one.sessionId }, undefined, a.identity) as { state: string };
  expect(result.state).toBe("closed");
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(released).toEqual([{ id: one.handoff.appId, live: [two.handoff.appId] }]);
  expect(held.size).toBe(2); // the hung backend never let go itself; the broker did, and said so to the plugin path
  expect(await call(socket, "session.live-leases", {}, undefined, a.identity)).toEqual({ leases: [two.handoff.appId] });
});

test("busy names the holder, queues with wait, and hands over in order", async () => {
  fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex"), c = agent("conv-c", "Hermes");
  const held = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string; ownerLabel: string };

  const refused = await code(call(socket, "session.create", handoff(21, "Beta"), undefined, b.identity));
  expect(refused).toStartWith("APPLICATION_BUSY: Application client is already leased by ");
  expect(refused).toContain(held.ownerLabel);
  expect(refused).toContain('task "Alpha task"');
  expect(refused).toMatch(/idle \d+ s/);
  expect(refused).toContain("its adapter is alive");
  expect(refused).not.toContain("waiting for it");

  const waiting = call(socket, "session.create", handoff(21, "Beta", { wait: 10 }), undefined, b.identity);
  await delay(300);
  const behind = await code(call(socket, "session.create", handoff(21, "Gamma"), undefined, c.identity));
  expect(behind).toContain("You are number 2 of 2 waiting for it");
  await call(socket, "session.stop", { sessionId: held.sessionId }, undefined, a.identity);
  const got = await waiting as { ownerLabel: string; state: string };
  expect(got.state).toBe("running");
  expect(got.ownerLabel).toContain("Codex");
  // A waiter that gives up by timeout is told its place, and the application stays refused.
  const timeout = await code(call(socket, "session.create", handoff(21, "Late", { wait: 1 }), undefined, c.identity));
  expect(timeout).toStartWith("APPLICATION_BUSY: ");
  expect(timeout).toContain("Codex (");
});

test("opening without a workspace picks a free one per caller, never another agent's and never a shown one", async () => {
  fakeNative();
  const open = spyOn(NativeBackend, "openApplication").mockResolvedValue({ opened: true } as never);
  const monitors = spyOn(NativeBackend, "monitors").mockResolvedValue({ monitors: [{ name: "DP-1", focused: true, workspace: 20 }] } as never);
  cleanups.push(() => { open.mockRestore(); monitors.mockRestore(); });
  const { socket } = await broker();
  const a = agent("conv-a", "Claude"), b = agent("conv-b", "Codex"), c = agent("conv-c", "Hermes");
  // Agent B already holds a session on 21.
  await call(socket, "session.create", handoff(21, "Beta"), undefined, b.identity);
  const open1 = (identity: ClientIdentity, requestId: string) =>
    call(socket, "native.open", { requestId, applicationId: "org.example.App.desktop" }, undefined, identity) as Promise<{ opened?: boolean; workspace: number; allocated?: boolean }>;
  const first = await open1(a.identity, "a-1");
  expect(first).toEqual({ opened: true, workspace: 22, allocated: true });
  // The same identity is the same answer, with a single launch.
  expect(await open1(a.identity, "a-1")).toEqual(first);
  expect(open).toHaveBeenCalledTimes(1);
  // The same agent keeps its windows together; another agent is sent elsewhere.
  expect((await open1(a.identity, "a-2")).workspace).toBe(22);
  expect((await open1(c.identity, "c-1")).workspace).toBe(23);
  // An explicit workspace is still honoured and still passes through unchanged.
  expect(await call(socket, "native.open", { requestId: "x", workspace: 40, applicationId: "org.example.App.desktop" }, undefined, a.identity)).toEqual({ opened: true });
  // A dead agent's workspaces are free again.
  c.child.kill("SIGKILL"); await c.child.exited; await delay(400);
  expect((await open1(b.identity, "b-1")).workspace).toBe(21);
});

test("the owner credential is the only way to see other agents' ids from the command line", async () => {
  fakeNative();
  const { socket } = await broker();
  const a = agent("conv-a", "Claude");
  const mine = await call(socket, "session.create", handoff(21, "Alpha task"), undefined, a.identity) as { sessionId: string };
  const env = { ...process.env, ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: await mkdtemp(join(tmpdir(), "orbit-usage-")) };
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", resolve("src/cli.ts"), ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { out, err };
  };
  // An agent's own shell, no conversation shared with A: summary only, and stopping A's session is refused.
  const stranger = await cli(["session", "list"], { ORBIT_CONVERSATION_ID: "conv-other", ORBIT_CALLER_LABEL: "Codex" });
  expect(stranger.out).not.toContain(mine.sessionId);
  expect(stranger.out).toContain('"redacted":true');
  const refused = await cli(["session", "stop", mine.sessionId], { ORBIT_CONVERSATION_ID: "conv-other", ORBIT_CALLER_LABEL: "Codex" });
  expect(refused.err).toContain("SESSION_NOT_OWNED");
  const none = await cli(["session", "stop", "--mine"], { ORBIT_CONVERSATION_ID: "conv-other", ORBIT_CALLER_LABEL: "Codex" });
  expect(JSON.parse(none.out).result.stopped).toEqual([]);
  // The same conversation as the adapter is the same caller, so it sees and stops its own.
  const same = await cli(["session", "list"], { ORBIT_CONVERSATION_ID: "conv-a", ORBIT_CALLER_LABEL: "Claude" });
  expect(same.out).toContain(mine.sessionId);
  // The person, presenting the credential: everything, and the right to stop it.
  const person = await cli(["session", "list", "--owner"], { ORBIT_CONVERSATION_ID: "conv-other" });
  expect(person.out).toContain(mine.sessionId);
  const stopped = await cli(["session", "stop", "--mine"], { ORBIT_CONVERSATION_ID: "conv-a", ORBIT_CALLER_LABEL: "Claude" });
  expect(JSON.parse(stopped.out).result.stopped.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([mine.sessionId]);
}, 30_000);
