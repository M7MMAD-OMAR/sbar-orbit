import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { expectDeclaredImage, jpegSize } from "./frame-format";

/**
 * An application that needs room gets it two ways: the whole private display can be resized, and one
 * window can take the display it already has. The second costs nothing per frame, so it is the one to
 * reach for first.
 */
(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("a private display can be resized and its windows managed", async () => {
  const root = await mkdtemp("/tmp/orbit-window-");
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create",
      { backend: "fedora", viewport: { width: 1024, height: 640 } }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const observe = () => call(broker.socket, "session.observe", session) as Promise<{
      image: string; mimeType: string; width: number; height: number;
      presence: { title: string; pageCount: number; pageIndex: number; tabs: { tab: number; label: string; active: boolean }[] };
    }>;

    const started = await observe();
    expect(started).toMatchObject({ width: 1024, height: 640 });
    expectDeclaredImage(started, "image/jpeg");
    expect(jpegSize(started.image)).toEqual({ width: 1024, height: 640 });

    // Coordinates follow the created size, not the shipped default.
    await expect(act({ type: "pointer", x: 1100, y: 300 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(root, "first.json")] });
    await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(root, "second.json")] });
    const two = await observe();
    expect(two.presence.tabs).toHaveLength(2);
    expect(two.presence.pageCount).toBe(2);
    expect(two.presence.tabs.filter(tab => tab.active)).toHaveLength(1);

    expect(await act({ type: "resize", width: 1600, height: 1000 })).toEqual({ width: 1600, height: 1000 });
    const resized = await observe();
    expect(resized).toMatchObject({ width: 1600, height: 1000 });
    expect(jpegSize(resized.image)).toEqual({ width: 1600, height: 1000 });
    expect(await act({ type: "pointer", x: 1100, y: 300 })).toEqual({ applied: true });

    // Window commands act inside the private display and are addressed by the reported number.
    expect(await act({ type: "window", command: "focus", tab: 1 })).toMatchObject({ applied: true, tab: 1 });
    expect((await observe()).presence.tabs[0]).toMatchObject({ tab: 1, active: true });
    expect(await act({ type: "window", command: "fullscreen" })).toMatchObject({ applied: true, command: "fullscreen" });
    expect(await act({ type: "window", command: "restore" })).toMatchObject({ applied: true, command: "restore" });
    await expect(act({ type: "window", command: "focus", tab: 9 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(await act({ type: "window", command: "close", tab: 2 })).toMatchObject({ applied: true, tab: 2 });
    for (let i = 0; i < 100 && (await observe()).presence.tabs.length > 1; i++) await Bun.sleep(50);
    expect((await observe()).presence.tabs).toHaveLength(1);

    await expect(act({ type: "resize", width: 3840, height: 2160 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await broker.close(); }
}, 120000);
