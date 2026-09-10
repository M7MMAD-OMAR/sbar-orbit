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

/** An application that needs room must be able to get it, and every tab must agree on the size. */
test("a session can be created at a chosen size and resized while running", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    '<!doctype html><title>Room</title><h1 id="who">Room</h1><button id="open" onclick="window.open(location.href)">Open</button><output id="size"></output>'
    + '<script>const show=()=>document.querySelector("#size").textContent=`${innerWidth}x${innerHeight}`;show();addEventListener("resize",show)</script>',
    { headers: { "Content-Type": "text/html" } }) });
  const broker = await startBroker();
  try {
    await expect(call(broker.socket, "session.create", { backend: "browser", viewport: { width: 3840, height: 2160 } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const session = await call(broker.socket, "session.create", { backend: "browser", viewport: { width: 1024, height: 640 } }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const observe = () => call(broker.socket, "session.observe", session) as Promise<{ width: number; height: number; presence: { tabs: { tab: number; label: string; active: boolean }[] } }>;

    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
    expect(await observe()).toMatchObject({ width: 1024, height: 640 });
    expect(await act({ type: "read", selector: "#size" })).toEqual({ text: "1024x640" });

    await act({ type: "click", selector: "#open" });
    for (let i = 0; i < 100 && (await observe()).presence.tabs.length < 2; i++) await Bun.sleep(30);
    expect(await act({ type: "resize", width: 1600, height: 1000 })).toMatchObject({ width: 1600, height: 1000, tabsResized: 2, tabCount: 2 });

    const frame = await observe();
    expect(frame).toMatchObject({ width: 1600, height: 1000 });
    expect(frame.presence.tabs).toMatchObject([{ tab: 1, active: false }, { tab: 2, active: true }]);
    expect(await act({ type: "read", selector: "#size" })).toEqual({ text: "1600x1000" });

    // The opener tab was resized too, so switching back does not change what a coordinate means.
    await act({ type: "select-tab", tab: 1 });
    expect(await act({ type: "read", selector: "#size" })).toEqual({ text: "1600x1000" });

    // Coordinates now follow the larger surface instead of the size the session started with.
    await call(broker.socket, "session.pause", session);
    expect(await call(broker.socket, "session.control", { ...session, input: { type: "click", x: 1500, y: 900 } })).toEqual({ applied: true });
    await expect(call(broker.socket, "session.control", { ...session, input: { type: "click", x: 1700, y: 900 } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await broker.close(); fixture.stop(true); }
}, 45000);

/** An agent needs to open its own tab, not only follow one a site opened. */
test("open-tab adds a followed tab, with or without a URL", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<!doctype html><title>Page ${path}</title><h1 id="who">Page ${path}</h1>`, { headers: { "Content-Type": "text/html" } });
  } });
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const observe = () => call(broker.socket, "session.observe", session) as Promise<{ presence: { pageCount: number; pageIndex: number; tabs: unknown[] } }>;

    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/first` });
    expect(await act({ type: "open-tab", url: `http://127.0.0.1:${fixture.port}/second` }))
      .toMatchObject({ tab: 2, url: `http://127.0.0.1:${fixture.port}/second`, tabCount: 2 });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Page /second" });
    expect((await observe()).presence).toMatchObject({ pageCount: 2, pageIndex: 2 });

    const blank = await act({ type: "open-tab" }) as { tab: number; url: string };
    expect(blank).toMatchObject({ tab: 3, tabCount: 3 });
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/third` });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Page /third" });

    await act({ type: "select-tab", tab: 1 });
    expect(await act({ type: "read", selector: "#who" })).toEqual({ text: "Page /first" });
    await expect(act({ type: "open-tab", url: "file:///etc/passwd" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await broker.close(); fixture.stop(true); }
}, 45000);
