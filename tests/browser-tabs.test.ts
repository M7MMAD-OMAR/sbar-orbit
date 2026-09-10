import { test, expect } from "bun:test";
import { call, startBroker } from "../src/ipc";

/** A site that opens its login in a new tab must be reachable, and the agent must be able to go back. */
test("a popup becomes the followed tab and select-tab returns to the opener", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const html = path === "/signin"
      ? '<!doctype html><title>Sign in</title><h1 id="who">Sign in window</h1><input aria-label="user">'
      : '<!doctype html><title>Opener</title><h1 id="who">Opener page</h1><button id="open" onclick="window.open(\'/signin\')">Sign in</button>';
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  } });
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const observe = () => call(broker.socket, "session.observe", session) as Promise<{ mimeType: string; presence: { title: string; pageCount: number; pageIndex: number } }>;

    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
    expect((await observe()).presence).toMatchObject({ title: "Opener", pageCount: 1, pageIndex: 1 });

    await act({ type: "click", selector: "#open" });
    for (let i = 0; i < 100 && (await observe()).presence.pageCount < 2; i++) await Bun.sleep(30);

    // Without following the popup, this read would return the opener's heading instead.
    const opened = await observe();
    expect(opened.presence).toMatchObject({ title: "Sign in", pageCount: 2, pageIndex: 2 });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Sign in window" });
    await act({ type: "fill", selector: "[aria-label=user]", text: "orbit" });

    // The popup is sized like the session, so reported dimensions match the captured frame.
    expect(opened).toMatchObject({ mimeType: "image/jpeg" });

    await act({ type: "select-tab", tab: 1 });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Opener page" });
    expect((await observe()).presence).toMatchObject({ title: "Opener", pageIndex: 1 });

    await expect(act({ type: "select-tab", tab: 7 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await act({ type: "close-tab", tab: 2 })).toMatchObject({ closed: 2, tabCount: 1 });
    await expect(act({ type: "close-tab", tab: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await observe()).presence).toMatchObject({ pageCount: 1, pageIndex: 1 });
  } finally { await broker.close(); fixture.stop(true); }
}, 30000);

/** When the followed tab closes itself, the session must fall back rather than throw Playwright errors. */
test("a tab that closes itself hands control back to a surviving tab", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === "/popup"
      ? '<!doctype html><title>Popup</title><button id="go" onclick="window.close()">Close</button>'
      : '<!doctype html><title>Main</title><h1 id="who">Main page</h1><button id="open" onclick="window.open(\'/popup\')">Open</button>',
      { headers: { "Content-Type": "text/html" } });
  } });
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const observe = () => call(broker.socket, "session.observe", session) as Promise<{ presence: { title: string; pageCount: number } }>;
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
    await act({ type: "click", selector: "#open" });
    for (let i = 0; i < 100 && (await observe()).presence.pageCount < 2; i++) await Bun.sleep(30);
    expect((await observe()).presence.title).toBe("Popup");
    await act({ type: "click", selector: "#go" });
    for (let i = 0; i < 100 && (await observe()).presence.pageCount > 1; i++) await Bun.sleep(30);
    expect((await observe()).presence).toMatchObject({ title: "Main", pageCount: 1 });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Main page" });
  } finally { await broker.close(); fixture.stop(true); }
}, 30000);
