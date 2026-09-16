import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { expectDeclaredImage, jpegSize } from "./frame-format";
import { tmpdir } from "node:os";

/**
 * An application that needs room gets it two ways: the whole private display can be resized, and one
 * window can take the display it already has. The second costs nothing per frame, so it is the one to
 * reach for first.
 */
(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("a private display can be resized and its windows managed", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-window-"));
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

/**
 * The window can belong to a descendant of the process the supervisor started, not to that process:
 * /usr/bin/libreoffice is a script whose oosplash forks soffice.bin, and Writer's window is
 * soffice.bin's. Measured 14 September 2026 in experiments/application-coverage.ts: Writer mapped
 * and the launch still timed out at 30 seconds, because no window carried the supervised pid. The
 * shell here forks the fixture the same way, `& wait`, so the window's pid is a grandchild's.
 */
(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("a window mapped by a descendant of the launched process counts as mapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-descendant-"));
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const fixture = resolve("experiments/fedora-display/fixture.py");
    const launched = await act({ type: "launch", toolkit: "wayland",
      argv: ["/bin/sh", "-c", `/usr/bin/python3 "$1" "$2" & wait`, "orbit-descendant", fixture, join(root, "grandchild.json")] }) as { pid: number; applied: boolean };
    expect(launched.applied).toBe(true);
    const presence = await call(broker.socket, "session.presence", session) as { pageCount: number; tabs: { active: boolean }[] };
    expect(presence.pageCount).toBe(1);
    expect(presence.tabs[0]?.active).toBe(true);
    // A window of another session on the same display is not this launch's. The second launch is
    // the plain fixture, and it must map on its own pid rather than on the first one's.
    const second = await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", fixture, join(root, "second.json")] }) as { pid: number };
    expect(second.pid).not.toBe(launched.pid);
    expect((await call(broker.socket, "session.presence", session) as { pageCount: number }).pageCount).toBe(2);
    await call(broker.socket, "session.stop", session);
  } finally { await broker.close(); }
});
