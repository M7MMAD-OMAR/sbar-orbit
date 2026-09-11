import { chromium, type BrowserContext } from "playwright";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, cp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Can an agent inherit the person's real browser session by copying their profile? Orbit refuses to
 * reopen a personal profile today, and the owner wants the agent to use their real logins. This
 * measures what a copy actually carries, which binary may open it, and what a copy does to the
 * person's desktop when it is taken from a browser that is still running.
 *
 * Nothing here reads a real profile or a real account. A disposable local fixture stands in for the
 * person's browser: it is logged in with an HttpOnly cookie and a localStorage value, then copied.
 */
await requireResourceBudget();
const CHROME = "/usr/bin/google-chrome", CHROMIUM = "/usr/bin/chromium-browser";
const base = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "orbit-profile-clone-"));
const token = crypto.randomUUID();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/login") return new Response("ok", { headers: { "Set-Cookie": `fixture=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` } });
  const signedIn = request.headers.get("cookie")?.includes(`fixture=${token}`);
  return new Response(`<h1>${signedIn ? "Signed in" : "Signed out"}</h1>
<button onclick="fetch('/login').then(()=>{localStorage.setItem('k','blue');location.reload()})">login</button>
<output id=o></output><script>o.textContent=localStorage.getItem('k')||'none'</script>`, { headers: { "Content-Type": "text/html" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), chrome: CHROME, chromium: CHROMIUM };

/** Playwright forces --password-store=basic and --use-mock-keychain, which cannot read a keyring key. */
const open = (directory: string, executablePath: string, extra: string[] = []) =>
  chromium.launchPersistentContext(directory, { headless: true, executablePath, args: ["--no-first-run", "--no-default-browser-check", ...extra] });

async function signedIn(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { cookie: (await page.textContent("h1")) === "Signed in", localStorage: await page.textContent("#o") };
}

/** The v10 prefix is the hardcoded key every same-user program can reproduce; v11 is the keyring. */
function cookieScheme(directory: string) {
  try {
    const database = new Database(join(directory, "Default", "Cookies"), { readonly: true });
    const row = database.query("select hex(substr(encrypted_value,1,3)) prefix from cookies limit 1").get() as { prefix: string } | null;
    database.close();
    return row ? Buffer.from(row.prefix, "hex").toString() : "none";
  } catch { return "unreadable"; }
}

async function markers(directory: string) {
  const found: string[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith("Singleton")) continue;
    found.push(`${entry} -> ${await readlink(join(directory, entry)).catch(() => "(not a symlink)")}`);
  }
  return found;
}

async function personalProfile(name: string, store: string[]) {
  const directory = join(base, name);
  const context = await open(directory, CHROME, store);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.click("button");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Signed in", null, { timeout: 10000 });
  return { directory, context };
}

async function copyOf(source: string, name: string, dropMarkers: boolean) {
  const directory = join(base, name);
  await cp(source, directory, { recursive: true, dereference: false });
  if (dropMarkers) for (const entry of await readdir(directory)) if (entry.startsWith("Singleton")) await rm(join(directory, entry), { force: true });
  return directory;
}

async function attempt(directory: string, executablePath: string, store: string[]) {
  let context: BrowserContext | undefined;
  try { context = await open(directory, executablePath, store); return { started: true, ...await signedIn(context) }; }
  catch (error) { return { started: false, message: String(error).split("\n").at(0) ?? "unknown failure" }; }
  finally { await context?.close(); }
}

try {
  // Case one is NOT what this desktop chooses on its own. Playwright forces
  // --password-store=basic --use-mock-keychain into every launch, so this measures the hardcoded
  // key path. The person's real profiles here are v11, written against the login keyring, which is
  // why case two is the one that matters.
  const fallback = await personalProfile("default-store", []);
  await fallback.context.close();
  report.defaultStore = {
    scheme: cookieScheme(fallback.directory),
    sameBinary: await attempt(await copyOf(fallback.directory, "default-same", true), CHROME, []),
  };

  // Case two: force the keyring, which is what a GNOME or KDE desktop gives the person. The profile
  // is closed first, because a browser flushes its cookie batch on exit.
  const keyring = ["--password-store=gnome-libsecret"];
  const closed = await personalProfile("keyring-closed", keyring);
  await closed.context.close();
  report.closedProfile = {
    scheme: cookieScheme(closed.directory),
    sameBinary: await attempt(await copyOf(closed.directory, "closed-same", true), CHROME, keyring),
    crossBinary: await attempt(await copyOf(closed.directory, "closed-cross", true), CHROMIUM, keyring),
    wrongStore: await attempt(await copyOf(closed.directory, "closed-basic", true), CHROME, ["--password-store=basic"]),
  };

  // Case three: the copy the owner actually wants, taken from a browser the person is still using.
  const live = await personalProfile("keyring-live", keyring);
  const immediate = await copyOf(live.directory, "live-immediate", true);
  const inherited = await markers(live.directory);
  const naive = await copyOf(live.directory, "live-naive", false);
  const naiveAttempt = await attempt(naive, CHROME, keyring);
  // Chrome batches cookie writes, so give its commit timer room before copying again.
  await Bun.sleep(35000);
  const settled = await copyOf(live.directory, "live-settled", true);
  const stillRunning = live.context.pages().length > 0;
  await live.context.close();

  report.liveProfile = {
    schemeImmediately: cookieScheme(immediate), schemeAfterSettling: cookieScheme(settled),
    inheritedMarkers: inherited, naiveCopyKeepingMarkers: naiveAttempt,
    copiedImmediately: await attempt(immediate, CHROME, keyring),
    copiedAfterSettling: await attempt(settled, CHROME, keyring),
    originalSurvived: stillRunning,
  };
  // What does the copy cost? A real Chrome profile on this workstation is several gigabytes, so a
  // per session clone is only affordable when the filesystem shares the extents instead of copying
  // the bytes. The fixture profiles above live in TMPDIR, which is tmpfs here and has no reflink, so
  // the cost is measured where a real profile actually lives: the home filesystem.
  const costRoot = await mkdtemp(join(process.env.HOME ?? ".", ".cache", "orbit-clone-cost-"));
  try {
    const source = join(costRoot, "source");
    await mkdir(source, { recursive: true });
    // 480 MiB of incompressible data, so a real copy cannot hide behind compression.
    for (let i = 0; i < 12; i++) {
      const chunk = new Uint8Array(40 * 1024 * 1024);
      crypto.getRandomValues(chunk.subarray(0, 65536));
      for (let o = 65536; o < chunk.length; o += 65536) chunk.set(chunk.subarray(0, 65536), o);
      await writeFile(join(source, `f${i}`), chunk);
    }
    const started = performance.now();
    await cp(source, join(costRoot, "copy"), { recursive: true });
    const elapsed = Math.round(performance.now() - started);
    const usage = Bun.spawn(["/usr/bin/btrfs", "filesystem", "du", "-s", join(costRoot, "copy")], { stdout: "pipe", stderr: "ignore" });
    const summary = await usage.exited === 0 ? ((await new Response(usage.stdout).text()).trim().split("\n").pop() ?? "").trim() : "";
    report.copyCost = {
      filesystem: (await new Response(Bun.spawn(["/usr/bin/findmnt", "-no", "FSTYPE", "--target", costRoot], { stdout: "pipe" }).stdout).text()).trim(),
      bytes: 480 * 1024 * 1024, milliseconds: elapsed,
      btrfsSummary: summary || "btrfs du unavailable, so extent sharing was not measured",
    };
  } finally { await rm(costRoot, { recursive: true, force: true }); }
} finally { server.stop(true); await rm(base, { recursive: true, force: true }); }

await mkdir("output", { recursive: true, mode: 0o700 });
const path = join("output", `profile-clone-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`\nwritten to ${path}`);
