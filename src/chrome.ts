import { requireResourceBudget } from "./resource-budget";
import { chromium, type Browser, type ConnectOverCDPTransport } from "playwright";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrbitError } from "./errors";
import { chromeExecutables } from "./runtime-paths";
import { defaultViewport } from "./viewport";

/** Own Chrome separately from its CDP connection, including failed startup. */
export async function launchChrome(profile: string, size = defaultViewport) {
  await requireResourceBudget();
  const executable = chromeExecutables.find(path => Bun.file(path).size > 0);
  if (process.platform !== "linux" || !executable) throw new OrbitError("UNSUPPORTED", "Owned Chrome launcher currently requires Linux with Chrome or Chromium");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    !["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"].includes(key))) as Record<string, string>;
  // Chrome can use the desktop bus to move itself into an uncapped systemd scope.
  // This owned headless browser must not connect to the human session bus.
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${profile}/no-session-bus`;
  const owner = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "native/supervise.py"), join(profile, "owner.json"), executable,
    `--user-data-dir=${profile}`, "--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-dev-shm-usage", "--no-sandbox", "--password-store=basic", "about:blank"],
    { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let socket: WebSocket | undefined;
  const listeners: (() => void)[] = [];
  const close = () => closing ??= (async () => {
    owner.stdin.end();
    const kill = setTimeout(() => owner.kill("SIGKILL"), 4000);
    try { await owner.exited; } finally { clearTimeout(kill); }
    socket?.close();
    await browser?.close().catch(() => {});
    closed = true;
    for (const listener of listeners) listener();
  })();
  try {
    const deadline = Date.now() + 15000;
    let endpoint: string | undefined;
    while (Date.now() < deadline && owner.exitCode === null) {
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        if (port && /^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
      } catch {}
      await Bun.sleep(25);
    }
    if (!endpoint) throw new OrbitError("BACKEND_FAILED", "Owned Chrome did not publish its local endpoint");
    socket = new WebSocket(endpoint);
    const connected = socket;
    await new Promise<void>((resolve, reject) => {
      // Chrome has already published its endpoint by now; what remains is its own startup work,
      // which on the shared budget can take well over five seconds while other sessions start.
      const timer = setTimeout(() => { connected.close(); reject(new OrbitError("DEADLINE_EXCEEDED", "Local Chrome connection timed out")); }, 20000);
      connected.onopen = () => { clearTimeout(timer); resolve(); };
      connected.onerror = () => { clearTimeout(timer); reject(new OrbitError("BACKEND_FAILED", "Local Chrome connection failed")); };
    });
    const transport: ConnectOverCDPTransport = {
      send: message => connected.send(JSON.stringify(message)), close: () => connected.close(),
    };
    connected.onmessage = event => transport.onmessage?.(JSON.parse(String(event.data)));
    connected.onclose = () => transport.onclose?.();
    browser = await chromium.connectOverCDP(transport, { timeout: 10000 });
    const context = browser.contexts()[0];
    if (!context) throw new OrbitError("BACKEND_FAILED", "Owned Chrome has no default context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize(size);
    const { pid } = JSON.parse(await readFile(join(profile, "owner.json"), "utf8"));
    if (await readFile(`/proc/${pid}/cgroup`, "utf8") !== await readFile("/proc/self/cgroup", "utf8"))
      throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome moved outside its resource scope");
    browser.on("disconnected", () => { void close(); });
    void owner.exited.then(() => close());
    return { context, browser, page, close, onClose(listener: () => void) { if (closed) listener(); else listeners.push(listener); } };
  } catch (error) { await close(); throw error; }
}
