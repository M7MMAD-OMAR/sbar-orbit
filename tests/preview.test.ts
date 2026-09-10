import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { launchChrome } from "../src/chrome";
import { startBroker, call } from "../src/ipc";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

test("viewer authenticates, renders live frames and controls only paused sessions", async () => {
  const accountRoot = await mkdtemp("/tmp/orbit-viewer-accounts-");
  const broker = await startBroker({ accountRoot });
  const ownedViewer = await launchChrome(await createWorkspaceDirectory("preview-test"));
  const browser = ownedViewer.browser;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response('<html><head><title>Orbit control fixture</title><style>body{font:24px system-ui;background:#f6f7f9;padding:40px;color:#192842}input{position:absolute;left:80px;top:160px;width:400px;height:48px;font:24px system-ui}button{position:absolute;left:500px;top:160px;height:48px;font:20px system-ui}output{display:block;margin-top:160px}</style></head><body><h1>Orbit control lab</h1><input aria-label="Message"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Waiting</output></body></html>', { headers: { "Content-Type": "text/html" } }) });
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser", accountName: "viewer-fixture" }) as { sessionId: string };
    await call(broker.socket, "session.act", { ...session, requestId: "navigate", action: { type: "navigate", url: `http://127.0.0.1:${fixture.port}` } });
    const { url } = await call(broker.socket, "preview.open") as { url: string };
    const address = new URL(url);
    const headers = { Origin: address.origin, Authorization: `Bearer ${address.hash.slice(1)}`, "Content-Type": "application/json" };
    const post = (method: string, params: unknown = {}, overrides: Record<string, string> = {}) => fetch(`${address.origin}/rpc`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify({ method, params }) });
    expect((await post("session.list", {}, { Authorization: "wrong" })).status).toBe(403);
    expect((await post("session.list", {}, { Origin: "https://outside.example" })).status).toBe(403);
    expect((await (await post("session.create", { backend: "browser" })).json()) as unknown).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    expect(await (await post("session.control", { ...session, input: { type: "click", x: 90, y: 180 } })).json()).toMatchObject({ ok: false, error: { code: "NOT_PAUSED" } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1120 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`); });
    await page.addInitScript(() => {
      const decode = window.createImageBitmap.bind(window);
      const counts = { created: 0, closed: 0, maximumLive: 0 };
      (window as any).__orbitBitmaps = counts;
      let first = true;
      window.createImageBitmap = (async (source: ImageBitmapSource) => {
        const bitmap = await decode(source);
        counts.created++;
        counts.maximumLive = Math.max(counts.maximumLive, counts.created - counts.closed);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => { counts.closed++; close(); };
        if (first) {
          first = false;
          await new Promise<void>(resolve => { (window as any).__releaseOrbitDecode = resolve; });
        }
        return bitmap;
      }) as typeof window.createImageBitmap;
    });
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).__releaseOrbitDecode), undefined, { timeout: 3000 });
    expect(await page.locator("#frame").getAttribute("data-captured-at")).toBeNull();
    expect(await page.locator("#frame").isVisible()).toBe(false);
    await page.evaluate(() => (window as any).__releaseOrbitDecode());
    expect(await page.title()).toBe("Orbit workspace");
    await page.locator("#frame").waitFor({ state: "visible" });
    expect(await page.evaluate(() => (window as any).__orbitBitmaps.maximumLive)).toBe(1);
    expect(await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#frame')!;
      return Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    })).toEqual([246, 247, 249, 255]);
    await page.getByRole("button", { name: "Pause agent", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'paused');
    await expect(call(broker.socket, "session.act", { ...session, requestId: "paused", action: { type: "click", selector: "button" } })).rejects.toMatchObject({ code: "PAUSED" });
    const box = await page.locator("#frame").boundingBox();
    if (!box) throw new Error("Preview image missing");
    await page.locator("#frame").click({ position: { x: box.width * 100 / 1280, y: box.height * 180 / 800 } });
    await page.getByLabel("Text to send", { exact: true }).fill("Manual control works");
    await page.getByRole("button", { name: "Send text", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')?.disabled);
    await page.locator("#frame").click({ position: { x: box.width * 530 / 1280, y: box.height * 180 / 800 } });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')?.disabled);
    await page.locator("#save-account").click();
    await page.waitForFunction(() => document.querySelector("#account-result")?.textContent?.includes("saved"));
    expect(await Bun.file(join(accountRoot, "viewer-fixture/state.json")).exists()).toBe(true);
    await page.getByRole("button", { name: "Resume agent", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'running');
    expect(await call(broker.socket, "session.act", { ...session, requestId: "read", action: { type: "read", selector: "output" } })).toEqual({ text: "Manual control works" });
    const afterInput = Date.now();
    await page.waitForFunction(at => Number(document.querySelector<HTMLImageElement>('#frame')?.dataset.capturedAt) > at, afterInput);
    const bitmaps = await page.evaluate(() => (window as any).__orbitBitmaps as { created: number; closed: number; maximumLive: number });
    expect(bitmaps.closed).toBeGreaterThan(1);
    expect(bitmaps.maximumLive).toBe(1);
    expect(bitmaps.created - bitmaps.closed).toBeLessThanOrEqual(1);
    // The cost readout is the only instrument for viewer cost, because the desktop viewer
    // runs outside Orbit's cgroup. An empty or malformed line would otherwise go unnoticed.
    await page.waitForFunction(() => /^Viewer cycle: \d+ ms of every \d+ ms \(\d+%\)/.test(document.querySelector("#cost")?.textContent ?? ""));
    const cost = await page.locator("#cost").textContent();
    expect(cost).toMatch(/request \d+ ms · decode \d+ ms · draw \d+ ms$/);
    expect(await page.evaluate(() => {
      const caption = document.querySelector("#cost")?.parentElement as HTMLElement;
      return caption.scrollWidth <= caption.clientWidth + 1;
    })).toBe(true);
    await mkdir(join(import.meta.dir, "../output/playwright"), { recursive: true });
    await page.screenshot({ path: join(import.meta.dir, "../output/playwright/viewer-desktop.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(import.meta.dir, "../output/playwright/viewer-mobile.png"), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
    expect(await call(broker.socket, "session.act", { ...session, requestId: "survived", action: { type: "read", selector: "output" } })).toEqual({ text: "Manual control works" });
    const again = await browser.newPage();
    await again.goto(url);
    await again.locator("#frame").waitFor({ state: "visible" });
    await again.getByRole("button", { name: "Stop session", exact: true }).click();
    await again.waitForFunction(() => document.querySelector('#state')?.textContent === 'closed');
    expect(await again.locator("#empty").textContent()).toBe("This session has stopped.");
  } finally { await ownedViewer.close(); await broker.close(); fixture.stop(true); }
}, 60000);

test("observation stays available while an agent waits for an element", async () => {
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    let settled = false;
    const pending = broker.sessions.dispatch({ method: "session.act", params: { ...session, requestId: "missing", action: { type: "click", selector: "#missing" } } }).finally(() => { settled = true; }).catch(() => {});
    const frame = await call(broker.socket, "session.observe", session) as { capturedAt: number };
    expect(frame.capturedAt).toBeGreaterThan(0);
    expect(settled).toBe(false);
    await call(broker.socket, "session.stop", session);
    await pending;
  } finally { await broker.close(); }
}, 15000);

// A slow capture must not be advertised as newly captured when it completes.
test("frame age includes capture work", async () => {
  const { BrowserBackend } = await import("../src/browser");
  const page = { url: () => "about:blank", title: async () => "", isClosed: () => false, screenshot: async () => { await Bun.sleep(80); return Buffer.from("fixture"); } };
  // Built on the real prototype so the active-tab getter is exercised rather than bypassed.
  const fake = Object.assign(Object.create(BrowserBackend.prototype), {
    pointers: new Map(), active: page, size: { width: 1280, height: 800 }, context: { pages: () => [page] } });
  const frame = await BrowserBackend.prototype.observe.call(fake as typeof BrowserBackend.prototype);
  expect(Date.now() - frame.capturedAt).toBeGreaterThanOrEqual(60);
});
