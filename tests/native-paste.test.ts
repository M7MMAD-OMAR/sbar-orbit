import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";
import { parseNativeAction } from "../src/fedora";
import { tmpdir } from "node:os";

test("native paste validates Unicode without broadening keyboard text semantics", () => {
  expect(parseNativeAction({ type: "paste", text: "مرحبا Orbit 🌍" })).toEqual({ type: "paste", text: "مرحبا Orbit 🌍" });
  for (const text of ["\ud800", "\u0000", "\u001b", "x".repeat(2049)])
    expect(() => parseNativeAction({ type: "paste", text })).toThrow();
  expect(() => parseNativeAction({ type: "text", text: "مرحبا" })).toThrow();
});

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("private clipboard pastes Arabic and emoji into Wayland and Xwayland apps", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-paste-test-"));
  const sessions = new Sessions(root);
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  const pids: number[] = [];
  try {
    const session = await run("session.create", { backend: "fedora" }) as { sessionId: string; capabilities: string[] };
    expect(session.capabilities).toContain("paste");
    const act = (action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
    for (const toolkit of ["wayland", "x11"]) {
      const file = join(root, `${toolkit}.json`);
      const app = await act({ type: "launch", toolkit, argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), file] }) as { pid: number };
      pids.push(app.pid);
      const text = `مرحبا Orbit 🌍 ${toolkit}`;
      await act({ type: "pointer", x: 120, y: 180 });
      expect(await act({ type: "paste", text })).toMatchObject({ applied: true, clipboard: "session" });
      let entered: string | undefined;
      for (let i = 0; i < 60; i++) {
        try { entered = JSON.parse(await readFile(file, "utf8")).text; } catch {}
        if (entered === text) break;
        await Bun.sleep(50);
      }
      expect(entered).toBe(text);
      await act({ type: "pointer", x: 550, y: 180 });
      let actual: string | undefined;
      for (let i = 0; i < 60; i++) {
        try { actual = JSON.parse(await readFile(file, "utf8")).saved; } catch {}
        if (actual === text) break;
        await Bun.sleep(50);
      }
      expect(actual).toBe(text);
      process.kill(app.pid, "SIGTERM");
      for (let i = 0; i < 60 && await Bun.file(`/proc/${app.pid}/stat`).exists(); i++) await Bun.sleep(25);
      expect(await Bun.file(`/proc/${app.pid}/stat`).exists()).toBe(false);
    }
    await run("session.stop", session);
    for (const pid of pids) expect(await Bun.file(`/proc/${pid}/stat`).exists()).toBe(false);
  } finally { await sessions.close(); }
}, 30000);
