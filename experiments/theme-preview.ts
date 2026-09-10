import { mkdir } from "node:fs/promises";
import { requireResourceBudget } from "../src/resource-budget";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";

/**
 * Renders the viewer in owned headless Chrome so the desktop palette, the tab strip and the size
 * control can be looked at. Run with ORBIT_THEME pointing at a file that does not exist to see the
 * shipped default instead of this desktop's colours.
 */
const out = join("output", `theme-preview-${new Date().toISOString().slice(0, 10)}`);
await requireResourceBudget();
await mkdir(out, { recursive: true, mode: 0o700 });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
  const path = new URL(request.url).pathname;
  return new Response(path === "/second"
    ? '<!doctype html><title>Wikipedia article</title><h1>Second tab</h1>'
    : '<!doctype html><title>Orbit demo page</title><h1>First tab</h1><button id="open" onclick="window.open(\'/second\')">Open</button>',
    { headers: { "Content-Type": "text/html" } });
} });
const broker = await startBroker();
const viewer = await launchChrome(await createWorkspaceDirectory("theme-shot"), { width: 1400, height: 1250 });
try {
  const session = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Theme check" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
  await act({ type: "click", selector: "#open" });
  await Bun.sleep(1500);
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  const page = viewer.page;
  await page.goto(url);
  await page.locator("#frame").waitFor({ state: "visible", timeout: 30000 });
  await page.getByRole("button", { name: "Pause agent", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "paused");
  await Bun.sleep(600);
  await page.screenshot({ path: join(out, "viewer.png"), fullPage: true });
  console.log("theme.css:", (await (await fetch(new URL("/theme.css", url).toString())).text()).slice(0, 160));
  console.log("tabs:", await page.locator("#tabs button").allTextContents());
  console.log("sizes:", await page.locator("#surface option").allTextContents());
  console.log("body background:", await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
} finally { await viewer.close(); await broker.close(); fixture.stop(true); }
