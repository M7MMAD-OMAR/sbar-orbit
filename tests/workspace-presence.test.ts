import { test, expect } from "bun:test";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { navigationFixtureDiagnostic } from "./navigation-fixture-diagnostic";

test("workspace identity, active page and trusted pointer are visible without exposing action text", async () => {
  const diagnostic = navigationFixtureDiagnostic();
  const broker = await startBroker();
  const viewer = await launchChrome(await createWorkspaceDirectory("presence-viewer"));
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => { diagnostic.request(request.url); return new Response('<title>Orbit form example</title><style>button{position:absolute;left:200px;top:180px;width:200px;height:80px}input{position:absolute;left:40px;top:40px}</style><input><button>Update record</button><script>globalThis.orbitPointer={x:1,y:1};dispatchEvent(new PointerEvent("pointermove",{clientX:1,clientY:1}))</script>', { headers: { "Content-Type": "text/html" } }); } });
  diagnostic.phase("fixture-ready");
  try {
    diagnostic.phase("session-create-before");
    const session = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Update form" }) as { sessionId: string };
    diagnostic.phase("session-create-settled"); diagnostic.attach(broker, session.sessionId);
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    diagnostic.phase("initial-navigate-before");
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/form?fixture_private=omit#omit` });
    diagnostic.phase("initial-navigate-settled"); diagnostic.phase("presence-assertions-before");
    await act({ type: "fill", selector: "input", text: "disposable input not in activity" });
    let observation = await call(broker.socket, "session.observe", session) as any;
    expect(observation.presence.title).toBe("Orbit form example");
    expect(observation.presence.location).toBe(`http://127.0.0.1:${fixture.port}/form`);
    expect(observation.presence.pointer).toBeNull();
    await act({ type: "click", selector: "button" });
    observation = await call(broker.socket, "session.observe", session) as any;
    expect(observation.presence.pointer).toEqual({ x: 300, y: 220 });
    const list = await call(broker.socket, "session.list") as any[];
    expect(list[0]).toMatchObject({ agentName: "SbarOrbit", taskName: "Update form", activity: { type: "click", actor: "agent", state: "done", sequence: 3 } });
    expect(JSON.stringify(list)).not.toContain("disposable input");
    const { url } = await call(broker.socket, "preview.open") as { url: string };
    const page = viewer.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto(url);
    await page.locator("#agent-pointer").waitFor({ state: "visible" });
    expect(await page.locator("#task-name").textContent()).toBe("Update form");
    expect(await page.locator("#page-title").textContent()).toBe("Orbit form example");
    expect(await page.locator("#pointer-label").textContent()).toBe("SbarOrbit");
    const pointer = await page.locator("#agent-pointer").boundingBox(), canvas = await page.locator("#frame").boundingBox();
    if (!pointer || !canvas) throw new Error("Missing pointer or frame");
    expect(Math.abs(pointer.x - canvas.x - canvas.width * 300 / 1280)).toBeLessThan(2);
    expect(Math.abs(pointer.y - canvas.y - canvas.height * 220 / 800)).toBeLessThan(2);
    await page.screenshot({ path: "output/workspace-presence-desktop.png", fullPage: true });
    await page.locator("#pause").click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#state")?.dataset.state === "paused");
    await call(broker.socket, "session.control", { ...session, input: { type: "click", x: 60, y: 50 } });
    await page.waitForFunction(() => document.querySelector("#pointer-label")?.textContent === "You");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "output/workspace-presence-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
    diagnostic.phase("presence-assertions-settled");
    await call(broker.socket, "session.resume", session);
    diagnostic.phase("next-navigate-before");
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/next` });
    diagnostic.phase("next-navigate-settled");
    expect((await call(broker.socket, "session.observe", session) as any).presence.pointer).toBeNull();
    await expect(call(broker.socket, "session.create", { backend: "browser", agentName: "\n" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } catch (error) { diagnostic.phase("failure"); throw error; }
  finally {
    diagnostic.phase("cleanup-before");
    try { await viewer.close(); await broker.close(); fixture.stop(true); diagnostic.phase("cleanup-settled"); }
    finally { await diagnostic.save(); }
  }
}, 30000);
