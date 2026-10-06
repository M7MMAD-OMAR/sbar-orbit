import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as advisor from "../src/advisor";
import { BrowserBackend } from "../src/browser";
import { Sessions } from "../src/session";
import * as restore from "../src/restore";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-advisor-pause-"));
  let answer = (_value: advisor.AdvisorAnswer) => {};
  const advice = new Promise<advisor.AdvisorAnswer>(resolve => { answer = resolve; });
  let entered = () => {};
  const consulting = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  let exited = () => {};
  let closing = () => {};
  const stopping = new Promise<void>(resolve => { closing = resolve; });
  const backend = {
    surface: { width: 1280, height: 800 }, capabilities: [],
    parseAction: (value: unknown) => value,
    act: async () => { events.push("action"); return { applied: true }; },
    control: async () => { events.push("human"); return { applied: true }; },
    onClose: (listener: () => void) => { exited = listener; },
    close: async () => { closing(); exited(); },
  } as unknown as BrowserBackend;
  const spies = [
    spyOn(restore, "createSubvolume").mockResolvedValue(false),
    spyOn(BrowserBackend, "create").mockResolvedValue(backend),
    spyOn(advisor, "consultAdvisor").mockImplementation(async () => {
      entered();
      const result = await advice;
      events.push("advisor");
      return result;
    }),
  ];
  const sessions = new Sessions(root);
  const created = await sessions.create({ backend: "browser", policy: {
    mode: "autonomous", origins: "any", allow: ["read", "navigate", "write"],
    rules: [{ id: "fixture-consult", verb: "navigate", decision: "consult", reason: "fixture" }],
    advisor: { command: [process.execPath], timeoutMs: 1000 },
  } }) as { sessionId: string };
  const session = { sessionId: created.sessionId };
  const act = (requestId: string, type = "navigate") => sessions.dispatch({ method: "session.act",
    params: { ...session, requestId, action: type === "navigate" ? { type, url: "https://example.test" }
      : { type, selector: "input", text: "fixture" } },
  });
  return { sessions, session, act, consulting, stopping, events, answer,
    dispose: async () => {
      answer({ decision: { outcome: "deny", reason: "fixture ending" }, decidedBy: "fixture" });
      await sessions.close();
      for (const spy of spies) spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("pause acknowledges only after an accepted advisor action finishes", async () => {
  const f = await fixture();
  try {
    const accepted = f.act("advised").catch(error => error);
    await f.consulting;
    const paused = f.sessions.dispatch({ method: "session.pause", params: f.session }).then(value => {
      f.events.push("pause"); return value;
    });
    await expect(f.act("blocked", "fill")).rejects.toMatchObject({ code: "PAUSED" });
    // Give an incorrect acknowledgement time to settle before the advisor answers.
    await Promise.race([paused, new Promise(resolve => setTimeout(resolve, 100))]);
    f.answer({ decision: { outcome: "allow" }, decidedBy: "fixture" });
    expect(await accepted).toEqual({ applied: true });
    expect(await paused).toMatchObject({ state: "paused" });
    expect(f.events).toEqual(["advisor", "action", "pause"]);
    await expect(f.act("still-blocked", "fill")).rejects.toMatchObject({ code: "PAUSED" });
    await f.sessions.dispatch({ method: "session.control", params: {
      ...f.session, input: { type: "text", text: "human fixture" },
    } });
    expect(await f.sessions.dispatch({ method: "session.resume", params: f.session })).toMatchObject({ state: "running" });
    expect(await f.act("resumed", "fill")).toEqual({ applied: true });
    expect(f.events).toEqual(["advisor", "action", "pause", "human", "action"]);
  } finally { await f.dispose(); }
});

test("pause drains a denied advisor request and the later accepted action", async () => {
  const f = await fixture();
  try {
    const advised = f.act("advised").catch(error => error);
    await f.consulting;
    const later = f.act("later", "fill");
    const paused = f.sessions.dispatch({ method: "session.pause", params: f.session }).then(value => {
      f.events.push("pause"); return value;
    });
    await Promise.race([paused, new Promise(resolve => setTimeout(resolve, 100))]);
    f.answer({ decision: { outcome: "deny", reason: "fixture refused" }, decidedBy: "fixture" });
    expect(await advised).toMatchObject({ code: "POLICY_DENIED" });
    expect(await later).toEqual({ applied: true });
    expect(await paused).toMatchObject({ state: "paused" });
    const journal = await f.sessions.dispatch({ method: "session.journal", params: f.session }) as {
      entries: { actionType: string; outcome?: string }[];
    };
    expect(journal.entries.filter(entry => entry.actionType === "navigate").at(-1)?.outcome).toBe("deny");
    expect(f.events).toEqual(["advisor", "action", "pause"]);
  } finally { await f.dispose(); }
});

test("stop during consultation refuses a late allow before backend input", async () => {
  const f = await fixture();
  try {
    const accepted = f.act("advised").catch(error => error);
    await f.consulting;
    const stopped = f.sessions.dispatch({ method: "session.stop", params: f.session });
    await f.stopping;
    f.answer({ decision: { outcome: "allow" }, decidedBy: "fixture" });
    expect(await accepted).toMatchObject({ code: "SESSION_CLOSED" });
    expect(await stopped).toMatchObject({ state: "closed" });
    expect(f.events).toEqual(["advisor"]);
  } finally { await f.dispose(); }
});
