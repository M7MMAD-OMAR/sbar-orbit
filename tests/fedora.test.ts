import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";

const enabled = process.env.ORBIT_TEST_NATIVE === "1";
(enabled ? test : test.skip)("native broker owns two displays, pause, captures and independent stop", async () => {
  const root = await mkdtemp("/tmp/orbit-native-test-");
  const sessions = new Sessions(root);
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  const act = (sessionId: string, action: unknown) => run("session.act", { sessionId, requestId: crypto.randomUUID(), action });
  const fixture = resolve("experiments/fedora-display/fixture.py");
  const saved = async (file: string, expected: string) => {
    for (let i = 0; i < 100; i++) {
      try { if (JSON.parse(await readFile(file, "utf8")).saved === expected) return true; } catch {}
      await Bun.sleep(30);
    }
    return false;
  };
  try {
    const a = await run("session.create", { backend: "fedora" }) as { sessionId: string };
    const b = await run("session.create", { backend: "fedora" }) as { sessionId: string };
    const files = [join(root, "a.json"), join(root, "b.json")];
    const pids: number[] = [];
    for (const [i, session] of [a, b].entries()) {
      const result = await act(session.sessionId, { type: "launch", toolkit: i ? "x11" : "wayland", argv: ["/usr/bin/python3", fixture, files[i]] }) as { pid: number };
      pids.push(result.pid);
      await act(session.sessionId, { type: "pointer", x: 120, y: 180 });
      await act(session.sessionId, { type: "text", text: i ? "Session B" : "Session A" });
      await act(session.sessionId, { type: "pointer", x: 550, y: 180 });
      expect(await saved(files[i]!, i ? "Session B" : "Session A")).toBe(true);
    }
    const frame = await run("session.observe", a) as { image: string };
    expect(Buffer.from(frame.image, "base64").subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    await run("session.pause", a);
    await expect(act(a.sessionId, { type: "text", text: "denied" })).rejects.toMatchObject({ code: "PAUSED" });
    await run("session.control", { ...a, input: { type: "click", x: 120, y: 180 } });
    await run("session.resume", a);
    await expect(act(a.sessionId, { type: "navigate", url: "http://localhost" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const started = performance.now();
    await run("session.stop", a);
    expect(performance.now() - started).toBeLessThan(5000);
    await expect(run("session.observe", a)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(await Bun.file(`/proc/${pids[0]}/cmdline`).exists()).toBe(false);
    await act(b.sessionId, { type: "pointer", x: 380, y: 180 });
    await act(b.sessionId, { type: "text", text: " survives" });
    await act(b.sessionId, { type: "pointer", x: 550, y: 180 });
    expect(await saved(files[1]!, "Session B survives")).toBe(true);
  } finally { await sessions.close(); }
}, 45000);

(enabled ? test : test.skip)("native session is visible and manually controllable through the shared viewer", async () => {
  const { startBroker, call } = await import("../src/ipc");
  const { launchChrome } = await import("../src/chrome");
  const broker = await startBroker();
  const root = await mkdtemp("/tmp/orbit-native-viewer-");
  const browser = await launchChrome(await createWorkspaceDirectory("native-viewer-test"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "native-mcp-harness", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("src/mcp.ts")], env: { ORBIT_SOCKET: broker.socket }, stderr: "pipe" }));
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    const blocks = result.content as { type: string; text?: string }[];
    if (blocks[0]?.type !== "text") throw new Error("Expected tool text");
    return JSON.parse(blocks[0].text!);
  };
  try {
    const session = await tool("orbit_create", { backend: "fedora" }) as { sessionId: string };
    const resultFile = join(root, "result.json");
    await tool("orbit_act", { ...session, requestId: "launch", action: { type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), resultFile] } });
    const { url } = await call(broker.socket, "preview.open") as { url: string };
    const page = browser.page;
    await page.setViewportSize({ width: 1280, height: 1120 });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(url);
    await page.locator("#frame").waitFor({ state: "visible" });
    expect(await page.locator("#send").isDisabled()).toBe(true);
    await expect(call(broker.socket, "session.control", { ...session, input: { type: "paste", text: "must not paste" } })).rejects.toMatchObject({ code: "NOT_PAUSED" });
    await page.locator("#pause").click();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "paused");
    expect(await page.locator("#key").isDisabled()).toBe(true);
    const box = await page.locator("#frame").boundingBox();
    if (!box) throw new Error("No native frame");
    await page.locator("#frame").click({ position: { x: box.width * 100 / 1280, y: box.height * 180 / 800 } });
    expect(await page.locator("#send").textContent()).toBe("Paste text");
    const message = "مرحبا Orbit 🌍";
    await page.locator("#text").fill(message);
    await page.locator("#send").click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#send")?.disabled);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await readFile(resultFile, "utf8")).text === message) break;
      await Bun.sleep(30);
    }
    expect(JSON.parse(await readFile(resultFile, "utf8")).text).toBe(message);
    await page.locator("#frame").click({ position: { x: box.width * 550 / 1280, y: box.height * 180 / 800 } });
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await readFile(resultFile, "utf8")).saved === message) break;
      await Bun.sleep(30);
    }
    expect(JSON.parse(await readFile(resultFile, "utf8")).saved).toBe(message);
    await Bun.sleep(250);
    await mkdir(resolve("output/native"), { recursive: true });
    await page.screenshot({ path: resolve("output/native/viewer.png"), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
    expect(await call(broker.socket, "session.list")).toMatchObject([{ state: "paused" }]);
  } finally { await client.close(); await browser.close(); await broker.close(); }
}, 30000);
