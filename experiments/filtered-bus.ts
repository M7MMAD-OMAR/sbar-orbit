import { chromium } from "playwright";
import { mkdtemp, mkdir, cp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Orbit severs the session bus for a good reason: the comment in src/chrome.ts records that Chrome
 * can use the desktop bus to move itself into an uncapped systemd scope, which would break the one
 * core budget. Cookies written against the login keyring need that same bus to decrypt, so the two
 * goals look mutually exclusive. They are not. A filtering proxy exposes the secret service and
 * nothing else, which is what flatpak does for sandboxed applications.
 *
 * Nothing here reads a real profile or a real account. A disposable local fixture stands in.
 */
await requireResourceBudget();
const CHROME = "/usr/bin/google-chrome";
const KEYRING = ["--password-store=gnome-libsecret", "--no-first-run", "--no-default-browser-check"];
const HOST_BUS = `unix:path=${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/bus`;
const base = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "orbit-filtered-bus-"));
// A unix socket path cannot exceed about 108 characters, so the proxy lives in the runtime directory.
const runtime = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? "/run/user/1000", "orbit-bus-"));
const socket = join(runtime, "bus");
const token = crypto.randomUUID();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/login") return new Response("ok", { headers: { "Set-Cookie": `fixture=${token}; HttpOnly; Path=/; Max-Age=86400` } });
  const signedIn = request.headers.get("cookie")?.includes(`fixture=${token}`);
  return new Response(`<h1>${signedIn ? "Signed in" : "Signed out"}</h1><button onclick="fetch('/login').then(()=>location.reload())">login</button>`,
    { headers: { "Content-Type": "text/html" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

/** How many keyring items can a client on this bus enumerate? Counts only, never labels or values. */
async function reachableItems(address: string) {
  const probe = Bun.spawn(["/usr/bin/busctl", "--user", "call", "org.freedesktop.secrets", "/org/freedesktop/secrets",
    "org.freedesktop.Secret.Service", "SearchItems", "a{ss}", "0"],
    { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } as Record<string, string>, stdout: "pipe", stderr: "ignore" });
  if (await probe.exited !== 0) return 0;
  return (await new Response(probe.stdout).text()).split(/\s+/).filter(v => v.startsWith('"/org/freedesktop/secrets')).length;
}

/** A name is reachable when a bare Peer.Ping through this bus address succeeds. */
async function reachable(address: string, name: string, path: string) {
  const probe = Bun.spawn(["/usr/bin/busctl", "--user", "call", name, path, "org.freedesktop.DBus.Peer", "Ping"],
    { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } as Record<string, string>, stdout: "ignore", stderr: "ignore" });
  return await probe.exited === 0;
}

async function signedIn(directory: string, address: string) {
  const context = await chromium.launchPersistentContext(directory, { headless: true, executablePath: CHROME, args: KEYRING,
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } as Record<string, string> });
  try {
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    return (await page.textContent("h1")) === "Signed in";
  } finally { await context.close(); }
}

async function cloneOf(source: string, name: string) {
  const directory = join(base, name);
  await cp(source, directory, { recursive: true });
  for (const entry of await readdir(directory)) if (entry.startsWith("Singleton")) await rm(join(directory, entry), { force: true });
  return directory;
}

let proxy: ReturnType<typeof Bun.spawn> | undefined;
try {
  // The person's profile, written against the real login keyring, so its cookies are v11.
  const personal = join(base, "personal");
  const context = await chromium.launchPersistentContext(personal, { headless: true, executablePath: CHROME, args: KEYRING });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.click("button");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Signed in", null, { timeout: 10000 });
  await context.close();

  proxy = Bun.spawn(["/usr/bin/xdg-dbus-proxy", HOST_BUS, socket, "--filter", "--talk=org.freedesktop.secrets"],
    { stdout: "ignore", stderr: "ignore" });
  const filtered = `unix:path=${socket}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { up = await reachable(filtered, "org.freedesktop.secrets", "/org/freedesktop/secrets"); if (!up) await Bun.sleep(50); }

  report.filteredBus = {
    proxyStarted: up,
    secretServiceReachable: up,
    // This is the name the src/chrome.ts comment warns about: the route to an uncapped scope.
    systemdReachable: await reachable(filtered, "org.freedesktop.systemd1", "/org/freedesktop/systemd1"),
    cloneStaysSignedIn: await signedIn(await cloneOf(personal, "clone-filtered"), filtered),
    // The filter constrains the bus NAME, not which items may be searched. This is the cost.
    keyringItemsExposed: await reachableItems(filtered),
  };
  report.severedBus = {
    // What Orbit does today.
    cloneStaysSignedIn: await signedIn(await cloneOf(personal, "clone-severed"), `unix:path=${base}/no-session-bus`),
  };
} finally { server.stop(true); proxy?.kill(); await rm(runtime, { recursive: true, force: true }); await rm(base, { recursive: true, force: true }); }

await mkdir("output", { recursive: true, mode: 0o700 });
const path = join("output", `filtered-bus-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
