import { requireHeadroom, requireResourceBudget } from "./resource-budget";
import { chromium, type Browser, type ConnectOverCDPTransport } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrbitError } from "./errors";
import { chromeExecutables } from "./runtime-paths";
import { defaultViewport } from "./viewport";

export type ChromeLaunchOptions = {
  /**
   * The binary to run. A profile can only be decrypted by the install that owns it, because the
   * keyring item Chromium looks up is named after the binary's branding, so a caller handing over an
   * existing profile must name its owner rather than accept whichever browser is found first.
   */
  executable?: string;
  /**
   * Which key to decrypt existing cookies with. The default is the hardcoded key, which is correct
   * for the fresh profiles Orbit creates and wrong for any profile written against a login keyring.
   */
  passwordStore?: "basic" | "gnome-libsecret" | "kwallet";
  /**
   * A bus address for the browser. Leave unset for the default, which is no bus at all. A caller that
   * needs the keyring must pass a FILTERED bus, never the person's session bus, because Chrome uses
   * the bus to move itself into an uncapped systemd scope and would escape its resource budget.
   */
  sessionBus?: string;
  /** Load the extensions present in the profile. Off by default, as for a fresh profile there are none. */
  extensions?: boolean;
  /**
   * Arguments appended to the browser's own. Used by the egress lease to point the browser at the only
   * route out it has, which is a setting on the browser and therefore not where the enforcement lives.
   */
  extraArgs?: string[];
  /**
   * Where CDP is reachable, when that is not where the browser says it is.
   *
   * A confined browser owns its own loopback, so the port it writes into DevToolsActivePort is a port
   * inside its network namespace and not one on this machine. The path in that file is still its path.
   */
  endpointPort?: number;
};

/**
 * Which browser a session gets when the caller has not named one. The first present install, which is
 * correct only for a profile Orbit created: a profile written by another install can be decrypted by
 * that install alone, so a caller handing one over names its owner.
 */
export function defaultChromeExecutable(): string | undefined {
  return chromeExecutables.find(path => Bun.file(path).size > 0);
}

/** Own Chrome separately from its CDP connection, including failed startup. */
export async function launchChrome(profile: string, size = defaultViewport, options: ChromeLaunchOptions = {}) {
  await requireResourceBudget();
  // Measured 13 September 2026 by sampling the scope's pids.current every 10 ms through a launch: the
  // fork burst peaks at 132 tasks, the endpoint is published at 139, and a session settles at 150 on
  // about:blank and 153 with a page. The check asks for the published figure, since what follows it
  // grows slowly enough for the memory limit to speak first. The memory figure is reasoned rather than
  // measured: three settled sessions charged 1364 MB to the slice, about 455 MB each, and a launch
  // needs less than a settled session.
  await requireHeadroom({ tasks: 140, memoryBytes: 200 * 1048576 }, "A browser session");
  const executable = options.executable ?? defaultChromeExecutable();
  if (process.platform !== "linux" || !executable) throw new OrbitError("UNSUPPORTED", "Owned Chrome launcher currently requires Linux with Chrome or Chromium");
  if (options.executable && !(Bun.file(options.executable).size > 0)) throw new OrbitError("UNSUPPORTED", "The requested browser executable is not present");
  // A profile that already holds one of these is a profile that held a browser: a restore point is a
  // snapshot of a running browser, and a clone is a copy of the person's. The poll below waits for this
  // file to appear, so a stale one is read as this browser's endpoint and dialled at a port that is
  // either nothing or somebody else.
  await rm(join(profile, "DevToolsActivePort"), { force: true }).catch(() => {});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    !["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"].includes(key))) as Record<string, string>;
  // Chrome can use the desktop bus to move itself into an uncapped systemd scope.
  // This owned headless browser must not connect to the human session bus.
  env.DBUS_SESSION_BUS_ADDRESS = options.sessionBus ?? `unix:path=${profile}/no-session-bus`;
  const owner = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "native/supervise.py"), join(profile, "owner.json"), executable,
    `--user-data-dir=${profile}`, "--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-dev-shm-usage", "--no-sandbox", `--password-store=${options.passwordStore ?? "basic"}`,
    ...(options.extensions ? [] : ["--disable-extensions"]), ...(options.extraArgs ?? []), "about:blank"],
    { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  // The last of what Chrome said, kept for the failure message. Dropping it entirely was how a
  // refused fork spent a day reported as "did not publish its local endpoint": the cause was on
  // stderr and stderr went nowhere. Bounded, because a healthy Chrome logs D-Bus complaints forever.
  let diagnostics = "";
  void (async () => {
    try { for await (const chunk of owner.stderr) diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-4096); }
    catch {}
  })();
  const explain = async (message: string) => {
    let reported = "";
    try { reported = String(JSON.parse(await readFile(join(profile, "owner.json"), "utf8")).error?.message ?? ""); } catch {}
    const lines = diagnostics.split("\n").map(line => line.trim()).filter(line => line && !/dbus|D-Bus|CHROME_VERSION_EXTRA/.test(line)).slice(-3);
    const cause = [reported, ...lines].filter(Boolean).join("; ");
    return cause ? `${message}: ${cause}` : message;
  };
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
        const reachable = options.endpointPort ? String(options.endpointPort) : port;
        if (port && /^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) { endpoint = `ws://127.0.0.1:${reachable}${path}`; break; }
      } catch {}
      await Bun.sleep(25);
    }
    if (!endpoint) throw new OrbitError("BACKEND_FAILED", await explain(owner.exitCode === null ? "Owned Chrome did not publish its local endpoint" : `Owned Chrome exited with code ${owner.exitCode} before publishing its endpoint`));
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
    // The same allowance as the socket above, and for the same reason. The handshake that follows
    // runs against a Chrome that is still starting on the shared budget, so a shorter deadline here
    // only moves the starvation failure one line down. Measured: a run with the host busy enough for
    // hyprctl to miss 37 of 84 samples and the sample loop to stall 3.7 s lost this handshake at 10 s.
    browser = await chromium.connectOverCDP(transport, { timeout: 20000 });
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
