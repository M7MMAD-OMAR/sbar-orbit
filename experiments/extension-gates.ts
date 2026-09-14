/**
 * Gates G12 and G14 from docs/porting.md, measured in an Orbit owned browser rather than read.
 *
 * Both gates say "any host with the extension loaded", and the project's rule keeps agents out of
 * the person's own browser. Those two facts are not in conflict: the extension is loaded here into
 * an owned headless Chromium with a private profile and no session bus, under the shared Orbit
 * budget, so nothing it does touches the person's profile, screen or native messaging hosts.
 *
 * What is measured:
 *   load   The unmodified extension, built with the documented bun build line, registers its
 *          service worker, the worker exposes the APIs the manifest asks for and the action click
 *          listener is registered. This is the first time it has run anywhere.
 *   G12a   chrome.cookies.getAll for an origin whose server set one HttpOnly cookie and one plain
 *          cookie, compared name by name against Network.getCookies, the browser's own list.
 *   G12b   A partitioned cookie set through Network.setCookie with {topLevelSite,
 *          hasCrossSiteAncestor}, read back through getAll with the same partitionKey, and the
 *          shape getAll returned handed to Network.setCookie in a second, fresh browser and read
 *          back there through getAll again.
 *   G14    The interval before Chrome stops the idle worker with nothing attached to it, then the
 *          same watch with a native messaging port held open to the real host program, which
 *          blocks on its stdin and therefore keeps the pipe open without a message crossing it.
 *
 * Why this file speaks CDP by hand instead of going through launchChrome: Playwright's CDP client
 * auto attaches to every target, service workers included, and an attached worker is never idle.
 * Measured first through launchChrome: alive at 90 seconds with no port. Measured again with no
 * client attached between polls: stopped at 30 seconds. The second number is Chrome's, the first
 * was the harness's, so the harness is gone.
 *
 * What is not measured, and why: G13 asks what a wake path puts on the person's screen, and a
 * headless browser has no screen to put anything on. It stays open.
 *
 * The G12 probe carries one deliberate change to the manifest: static host_permissions for the two
 * test origins. The shipped manifest asks for host access per origin under the action click's user
 * gesture, and there is no gesture in a headless run. The cookie read is the same call either way,
 * and the load check runs the manifest exactly as shipped.
 *
 * Run: bun run scripts/limited.ts bun run experiments/extension-gates.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();

const HOST_NAME = "com.sbarorbit.mint";
const IDLE_CAP_MS = Number(process.env.ORBIT_EXTENSION_IDLE_CAP_MS ?? 120_000);
const HELD_CAP_MS = Number(process.env.ORBIT_EXTENSION_HELD_CAP_MS ?? 150_000);
// Not the session default. Orbit's first choice on this host is branded Google Chrome, and branded
// Chrome has ignored --load-extension since 137: measured here first, the worker never registered
// and only a component extension's did. Chromium still honours the flag, so the gates run on it.
const CHROMIUM = "/usr/bin/chromium-browser";
if (!(Bun.file(CHROMIUM).size > 0)) throw new Error(`Loading an unpacked extension by flag needs Chromium; ${CHROMIUM} is not present`);
const repository = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "orbit-extension-gates-"));
const record: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), platform: process.platform };

/** The smallest CDP client that can reach a service worker: one socket, flat sessions, ids. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private socket: WebSocket) {
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`)); else waiter.resolve(message.result);
    };
  }
  static async open(endpoint: string) {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((ok, fail) => { socket.onopen = () => ok(); socket.onerror = () => fail(new Error("CDP connect failed")); });
    return new Cdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

type Target = { targetId: string; type: string; url: string };
// Chromium ships component extensions with workers of their own; the first run of this file
// attached to one of them, saw feedbackPrivate and no cookies API, and read that as ours. The
// worker script path is the discriminator, not the scheme.
const isOurWorker = (t: Target) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/dist\/service-worker\.js$/.test(t.url);
const workerTargets = async (cdp: Cdp): Promise<Target[]> => ((await cdp.send("Target.getTargets")).targetInfos as Target[]).filter(isOurWorker);

/** Attach for one expression and detach again, so DevTools itself never keeps the worker alive. */
async function inWorker<T>(cdp: Cdp, expression: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let worker: Target | undefined;
  while (!worker && Date.now() < deadline) { worker = (await workerTargets(cdp))[0]; if (!worker) await Bun.sleep(100); }
  if (!worker) throw new Error("The extension service worker never registered");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  try {
    // The bindings arrive one at a time: a worker that already had chrome.runtime answered a
    // cookies call with "undefined (reading 'getAll')" on the first attempt, so wait for the two
    // APIs this file uses rather than for the object.
    const ready = Date.now() + 10_000;
    while (Date.now() < ready) {
      const probe = await cdp.send("Runtime.evaluate", { expression: "typeof chrome === 'object' && typeof chrome.cookies === 'object' && typeof chrome.runtime?.connectNative === 'function'", returnByValue: true }, sessionId);
      if (probe.result?.value === true) break;
      await Bun.sleep(100);
    }
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`Worker threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}); }
}

/** A page session for the one tab, for navigation and the browser's own cookie jar. */
async function pageSession(cdp: Cdp) {
  const page = ((await cdp.send("Target.getTargets")).targetInfos as Target[]).find(t => t.type === "page");
  if (!page) throw new Error("No page target");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  return { send: (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId), detach: () => cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}) };
}

/**
 * Poll the target list through a socket opened and closed per sample, so the browser has no client
 * at all between samples and the worker's idle clock is its own. The interval is the measurement.
 */
async function watchWorker(endpoint: string, capMs: number, stepMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < capMs) {
    const cdp = await Cdp.open(endpoint);
    const alive = (await workerTargets(cdp)).length > 0;
    cdp.close();
    if (!alive) return { stoppedAfterMs: Date.now() - started, aliveAtCap: false };
    await Bun.sleep(stepMs);
  }
  return { stoppedAfterMs: null, aliveAtCap: true };
}

async function buildExtension(name: string, manifestPatch: Record<string, unknown>) {
  const dir = join(scratch, name);
  await mkdir(join(dir, "dist"), { recursive: true });
  const build = Bun.spawn([process.execPath, "build", join(repository, "extension/src/service-worker.ts"), "--target=browser", "--format=esm", `--outdir=${join(dir, "dist")}`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(`bun build failed: ${await new Response(build.stderr).text()}`);
  const manifest = { ...JSON.parse(await readFile(join(repository, "extension/manifest.json"), "utf8")), ...manifestPatch };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** The same flags launchChrome uses, minus the extension ban, plus the two that load ours. */
async function launchWith(extension: string, label: string) {
  const profile = await createWorkspaceDirectory(`extension-${label}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    !["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"].includes(key))) as Record<string, string>;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${profile}/no-session-bus`;
  const child = Bun.spawn([CHROMIUM, `--user-data-dir=${profile}`, "--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-dev-shm-usage", "--no-sandbox", "--password-store=basic",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { env, stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 15_000;
  let endpoint: string | undefined;
  while (!endpoint && Date.now() < deadline) {
    try {
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      if (port && path?.startsWith("/devtools/browser/")) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch {}
    if (!endpoint) await Bun.sleep(50);
  }
  if (!endpoint) { child.kill(); throw new Error("Chromium did not publish its endpoint"); }
  return { profile, endpoint, close: async () => { child.kill(); await child.exited; await rm(profile, { recursive: true, force: true }).catch(() => {}); } };
}

// Cookies for G12a: a server that sets one HttpOnly cookie and one the page can see.
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>cookie fixture</title>", {
  headers: [["Content-Type", "text/html"], ["Set-Cookie", "orbit_session=hidden; HttpOnly; Path=/"], ["Set-Cookie", "orbit_plain=visible; Path=/"]] }) });
const origin = `http://127.0.0.1:${server.port}`;
const partitioned = { url: "https://example.test/", topLevelSite: "https://top.test", hasCrossSiteAncestor: true };
const withKey = (key: { topLevelSite: string; hasCrossSiteAncestor: boolean }) =>
  `chrome.cookies.getAll({ url: ${JSON.stringify(partitioned.url)}, partitionKey: ${JSON.stringify(key)} })`;

try {
  // 1. The shipped manifest, unmodified, loads and its worker runs.
  {
    const pristine = await buildExtension("pristine", {});
    const run = await launchWith(pristine, "pristine");
    const cdp = await Cdp.open(run.endpoint);
    try {
      const started = Date.now();
      const id = await inWorker<string>(cdp, "chrome.runtime.id");
      const apis = await inWorker<string[]>(cdp, "Object.keys(chrome).sort()");
      // chrome.action is a toolbar surface, and a headless browser has no toolbar. Whether the API
      // object exists there is recorded rather than assumed, because the shipped worker registers
      // its click listener at top level and a missing object would throw before anything else ran.
      const action = await inWorker<string>(cdp, "typeof chrome.action === 'undefined' ? 'absent' : chrome.action.onClicked.hasListeners() ? 'listener registered' : 'present, no listener'");
      record.load = { ok: /^[a-p]{32}$/.test(id) && apis.includes("cookies") && apis.includes("storage") && action === "listener registered",
        extensionIdShape: /^[a-p]{32}$/.test(id) ? "32 lowercase a-p" : id, chromeApis: apis, action, workerReadyMs: Date.now() - started };
    } finally { cdp.close(); await run.close(); }
  }

  // 2. G12 on a probe that holds static host permission for the two test origins. A match pattern
  //    names no port; one that did matched nothing here, and getAll returned an empty list for a
  //    cookie the browser's own list showed. Without a port the pattern covers every port.
  const probe = await buildExtension("probe", { host_permissions: ["http://127.0.0.1/*", "https://example.test/*"] });
  const first = await launchWith(probe, "probe");
  const second = await launchWith(probe, "second");
  try {
    const cdp = await Cdp.open(first.endpoint);
    const page = await pageSession(cdp);
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: `${origin}/` });
    await Bun.sleep(500);
    const own = (await page.send("Network.getCookies", { urls: [`${origin}/`] })).cookies as { name: string; httpOnly: boolean }[];
    const seen = await inWorker<{ name: string; httpOnly: boolean; value: string }[]>(cdp, `chrome.cookies.getAll({ url: ${JSON.stringify(`${origin}/`)} })`);
    const hidden = seen.find(c => c.name === "orbit_session");
    record.g12HttpOnly = {
      ok: !!hidden && hidden.httpOnly === true && hidden.value === "hidden" && seen.length === own.length,
      browserOwnList: own.map(c => `${c.name}${c.httpOnly ? " (HttpOnly)" : ""}`).sort(),
      getAllReturned: seen.map(c => `${c.name}${c.httpOnly ? " (HttpOnly)" : ""}`).sort(),
    };

    // G12b: partitioned in, partitioned out, and the returned shape accepted by a second browser.
    const set = await page.send("Network.setCookie", { name: "orbit_part", value: "p", url: partitioned.url, secure: true, sameSite: "None",
      partitionKey: { topLevelSite: partitioned.topLevelSite, hasCrossSiteAncestor: partitioned.hasCrossSiteAncestor } });
    const back = await inWorker<{ name: string; partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean } }[]>(cdp,
      withKey({ topLevelSite: partitioned.topLevelSite, hasCrossSiteAncestor: partitioned.hasCrossSiteAncestor }));
    const unkeyed = await inWorker<{ name: string }[]>(cdp, `chrome.cookies.getAll({ url: ${JSON.stringify(partitioned.url)} })`);
    const key = back.find(c => c.name === "orbit_part")?.partitionKey;
    await page.detach();
    cdp.close();
    // The same {topLevelSite, hasCrossSiteAncestor} the worker returned, offered to a fresh browser
    // the way the broker side would offer a minted cookie, and read back there the same way.
    const cdp2 = await Cdp.open(second.endpoint);
    const page2 = await pageSession(cdp2);
    const complete = typeof key?.topLevelSite === "string" && typeof key.hasCrossSiteAncestor === "boolean";
    const returnedKey = complete ? { topLevelSite: key.topLevelSite as string, hasCrossSiteAncestor: key.hasCrossSiteAncestor as boolean } : undefined;
    const accepted = returnedKey
      ? await page2.send("Network.setCookie", { name: "orbit_part", value: "p", url: partitioned.url, secure: true, sameSite: "None", partitionKey: returnedKey })
      : { success: false };
    const landed = returnedKey ? await inWorker<{ name: string; partitionKey?: unknown }[]>(cdp2, withKey(returnedKey)) : [];
    const secondId = await inWorker<string>(cdp2, "chrome.runtime.id");
    await page2.detach();
    cdp2.close();
    record.g12Partition = {
      ok: set.success === true && !!returnedKey && returnedKey.topLevelSite === partitioned.topLevelSite && returnedKey.hasCrossSiteAncestor === partitioned.hasCrossSiteAncestor && accepted.success === true && landed.some(c => c.name === "orbit_part"),
      setThroughCdp: set.success, returnedPartitionKey: key ?? null,
      visibleWithoutPartitionKey: unkeyed.some(c => c.name === "orbit_part"),
      secondBrowserAccepted: accepted.success, secondBrowserReadBack: landed.filter(c => c.name === "orbit_part").map(c => c.partitionKey ?? "no partitionKey field"),
    };

    // 3. G14, first half: the idle worker in the first browser, nothing attached, sampled by a
    //    socket that closes between samples.
    record.g14Idle = { ...(await watchWorker(first.endpoint, IDLE_CAP_MS)), capMs: IDLE_CAP_MS };

    // 4. G14, second half: in the second browser, open a port to the real host and watch the same way.
    //    On Linux the user level hosts directory is NativeMessagingHosts under the user data
    //    directory, which is why ~/.config/chromium is where it usually appears. A private profile
    //    therefore has a private hosts directory and the person's own is never read. Measured: a
    //    manifest under a scratch XDG_CONFIG_HOME was "not found"; the same file under the profile is.
    //    By now the second browser's worker has idled out as well, measured on the first run of this
    //    version: "never registered", because a stopped worker has no target. It is started again
    //    through DevTools, ServiceWorker.startWorker, which is a debugger's wake path and not an
    //    answer to G13; the person's own wake path is the click the shipped worker waits for.
    const cdp3 = await Cdp.open(second.endpoint);
    await mkdir(join(second.profile, "NativeMessagingHosts"), { recursive: true });
    await writeFile(join(second.profile, "NativeMessagingHosts", `${HOST_NAME}.json`), JSON.stringify({
      name: HOST_NAME, description: "Orbit extension gate probe", type: "stdio",
      path: join(repository, "extension/host/mint_host.py"), allowed_origins: [`chrome-extension://${secondId}/`] }));
    const wake = await pageSession(cdp3);
    await wake.send("ServiceWorker.enable");
    await wake.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${secondId}/` });
    await wake.detach();
    const opened = await inWorker<string>(cdp3, `new Promise(resolve => {
      const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
      globalThis.__orbitPort = port;
      let settled = false;
      port.onDisconnect.addListener(() => { if (!settled) { settled = true; resolve("disconnected: " + (chrome.runtime.lastError?.message ?? "no error")); } });
      setTimeout(() => { if (!settled) { settled = true; resolve("open"); } }, 1500);
    })`);
    cdp3.close();
    const hostRunning = async () => await Bun.spawn(["/usr/bin/pgrep", "-f", "extension/host/mint_host.py"], { stdout: "ignore" }).exited === 0;
    const hostBefore = await hostRunning();
    const held = opened === "open" ? await watchWorker(second.endpoint, HELD_CAP_MS) : { stoppedAfterMs: null, aliveAtCap: false };
    record.g14Held = { portOpened: opened, hostProcessRunning: hostBefore, hostProcessRunningAtEnd: await hostRunning(), ...held, capMs: HELD_CAP_MS,
      host: "extension/host/mint_host.py, blocking on stdin, no message sent" };
  } finally { await first.close(); await second.close(); }
} finally {
  server.stop(true);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

record.g13 = "not measured: the wake paths are about what appears on the person's screen, and this browser has no screen";
record.limitations = [
  "Chromium, not the branded Google Chrome that is Orbit's default executable on this host: branded Chrome ignores --load-extension, so a person loading the shipped extension into Chrome does it unpacked through chrome://extensions.",
  "Owned headless Chromium with a private profile and no session bus; nothing in the person's browser or hosts directory was read or written.",
  "The G12 probe manifest carries static host_permissions for the two test origins because a headless run has no user gesture for chrome.permissions.request; the load check runs the shipped manifest unchanged.",
  "Cookies come from a local fixture server and a CDP setCookie, not from a signed in service.",
  "Worker lifecycle is sampled once a second through a socket closed between samples, so a stop is dated to within a second.",
];
const chromium = Bun.spawn([CHROMIUM, "--version"], { stdout: "pipe" });
record.browser = (await new Response(chromium.stdout).text()).trim();
await mkdir(join(repository, "output"), { recursive: true });
const out = join(repository, "output", `extension-gates-${record.date}.json`);
await writeFile(out, JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
console.log(`Recorded at ${out}`);
