import { test, expect } from "bun:test";
import { call, startBroker } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";

test("browser scrolling works through agent actions and paused viewer input", async () => {
  let offset = 0;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "POST") { offset = Number(await request.text()); return new Response("ok"); }
    return new Response('<!doctype html><style>body{height:4000px;background:linear-gradient(white,lightblue)}</style><h1>Orbit scroll test</h1><script>addEventListener("scroll",()=>fetch("/position",{method:"POST",body:String(scrollY)}))</script>', { headers: { "Content-Type": "text/html" } });
  } });
  const broker = await startBroker();
  const viewer = await launchChrome(await createWorkspaceDirectory("browser-scroll-viewer"));
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(30); }
    throw new Error("Browser fixture did not reach expected scroll offset");
  };
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` });
    const scroll = { type: "scroll", x: 400, y: 300, deltaY: 3 };
    await act(scroll);
    await wait(() => offset === 300);
    expect(offset).toBe(300);
    await act({ ...scroll, deltaY: -3 });
    await wait(() => offset === 0);
    for (const invalid of [{ x: -1 }, { y: 800 }, { deltaY: 0 }, { deltaY: 21 }, { deltaY: 0.5 }])
      await expect(act({ ...scroll, ...invalid })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(call(broker.socket, "session.control", { ...session, input: scroll })).rejects.toMatchObject({ code: "NOT_PAUSED" });
    const { url } = await call(broker.socket, "preview.open") as { url: string };
    const page = viewer.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.goto(url);
    await page.locator("#frame").waitFor({ state: "visible" });
    expect(await page.title()).toBe("Orbit workspace");
    await page.locator("#pause").click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "paused");
    await expect(act(scroll)).rejects.toMatchObject({ code: "PAUSED" });
    await page.locator("#frame").hover();
    await page.mouse.wheel(0, 300);
    await wait(() => offset === 300);
    expect(offset).toBe(300);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#resume")?.disabled);
    await page.mouse.wheel(0, -300);
    await wait(() => offset === 0);
    await page.locator("#resume").click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "running");
    await page.locator("#frame").hover();
    await page.mouse.wheel(0, 300);
    await Bun.sleep(300);
    expect(offset).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "output/browser-viewer-scroll.png", fullPage: true });
  } finally { await viewer.close(); await broker.close(); fixture.stop(true); }
}, 30000);
