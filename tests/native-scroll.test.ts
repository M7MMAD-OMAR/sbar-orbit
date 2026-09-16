import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBroker, call } from "../src/ipc";
import { tmpdir } from "node:os";

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("native wheel scroll via MCP changes Wayland and default GTK X11 content and respects pause", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-scroll-"));
  const broker = await startBroker();
  const client = new Client({ name: "orbit-scroll-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("src/mcp.ts")], env: { ORBIT_SOCKET: broker.socket }, stderr: "pipe" }));
    for (const toolkit of ["wayland", "x11"]) {
      const session = await call(broker.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
      const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
      const file = join(root, `${toolkit}.json`);
      await act({ type: "launch", toolkit, argv: ["/usr/bin/python3", resolve("experiments/fedora-display/scroll-fixture.py"), file] });
      const state = async () => JSON.parse(await readFile(file, "utf8")) as { vertical: number; horizontal: number; deviceManager: string };
      const wait = async (predicate: (value: { vertical: number; horizontal: number }) => boolean) => {
        let previous = "", unchangedSince = performance.now();
        for (let i = 0; i < 100; i++) {
          try {
            const value = await state(), serialized = JSON.stringify(value);
            if (serialized !== previous) { previous = serialized; unchangedSince = performance.now(); }
            if (predicate(value) && performance.now() - unchangedSince >= 200) return value;
          } catch {}
          await Bun.sleep(30);
        }
        throw new Error("Native scroll adjustment did not reach expected state");
      };
      await wait(value => value.vertical === 0);
      if (toolkit === "x11") expect((await state()).deviceManager).toContain("XI2");
      const scroll = { type: "scroll", x: 200, y: 200, deltaY: 3 };
      const frame = await call(broker.socket, "session.observe", session) as { image: string };
      await Bun.write(`output/scroll-${toolkit}.jpg`, Buffer.from(frame.image, "base64"));
      expect((await client.callTool({ name: "orbit_act", arguments: { ...session, requestId: crypto.randomUUID(), action: scroll } })).isError).not.toBe(true);
      const down = await wait(value => value.vertical > 0);
      expect(down.horizontal).toBe(0);
      await act({ ...scroll, deltaY: -3 });
      const up = await wait(value => value.vertical < down.vertical);
      expect(up.horizontal).toBe(0);
      expect(up.vertical).toBeCloseTo(0, 1);
      for (const invalid of [{ deltaY: 0 }, { deltaY: 21 }, { deltaY: 0.5 }, { x: -1 }, { y: 800 }])
        await expect(act({ ...scroll, ...invalid })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await call(broker.socket, "session.pause", session);
      await expect(act(scroll)).rejects.toMatchObject({ code: "PAUSED" });
      await call(broker.socket, "session.resume", session);
      const before = (await state()).vertical;
      await act(scroll);
      const resumed = await wait(value => value.vertical > before);
      expect(resumed.horizontal).toBe(0);
      expect(resumed.vertical).toBeCloseTo(down.vertical, 1);
      await call(broker.socket, "session.stop", session);
    }
  } finally { await client.close(); await broker.close(); }
}, 30000);
