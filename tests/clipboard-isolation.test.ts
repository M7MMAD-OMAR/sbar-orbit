import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("private clipboard selections survive another session's changes and stop", async () => {
  const root = await mkdtemp("/tmp/orbit-clipboard-isolation-");
  const sessions = new Sessions(root);
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  const act = (session: { sessionId: string }, action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
  const values = ["جلسة A 🌍", "جلسة B 🚀"];
  const created: { sessionId: string; file: string; pid: number }[] = [];
  const waitText = async (file: string, expected: string) => {
    let text: unknown;
    for (let i = 0; i < 60; i++) {
      try { text = JSON.parse(await readFile(file, "utf8")).text; } catch {}
      if (text === expected) break;
      await Bun.sleep(50);
    }
    expect(text).toBe(expected);
  };
  try {
    for (const [i, text] of values.entries()) {
      const session = await run("session.create", { backend: "fedora" }) as { sessionId: string };
      const file = join(root, `${i}.json`);
      const app = await act(session, { type: "launch", toolkit: i ? "x11" : "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), file] }) as { pid: number };
      created.push({ ...session, file, pid: app.pid });
      await act(session, { type: "pointer", x: 120, y: 180 });
      await act(session, { type: "paste", text });
      await waitText(file, text);
    }
    const [a, b] = created;
    if (!a || !b) throw new Error("Missing sessions");
    // Replace the entry through typing, preserving its existing clipboard selection.
    // The fixture's Paste button selects all before requesting its own clipboard.
    await act(a, { type: "text", text: " sentinel" });
    await waitText(a.file, values[0] + " sentinel");
    await act(a, { type: "pointer", x: 180, y: 360 });
    await waitText(a.file, values[0]!);
    await run("session.stop", a);
    expect(await Bun.file(`/proc/${a.pid}/stat`).exists()).toBe(false);
    await act(b, { type: "text", text: " sentinel" });
    await waitText(b.file, values[1] + " sentinel");
    await act(b, { type: "pointer", x: 180, y: 360 });
    await waitText(b.file, values[1]!);
  } finally { await sessions.close(); }
  for (const session of created) expect(await Bun.file(`/proc/${session.pid}/stat`).exists()).toBe(false);
}, 30000);
