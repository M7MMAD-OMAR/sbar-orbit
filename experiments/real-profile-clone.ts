import { chromium, type BrowserContext } from "playwright";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, cp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Does the profile clone actually work on the person's real browser, at real size, with their real
 * extensions? Every other measurement in this repository used a small synthetic profile.
 *
 * This experiment reads the person's real browser profile, so it is opt in and it is disciplined: the
 * source is only ever read, the clone is deleted before the process exits, and nothing about a cookie
 * is recorded except aggregate counts. No cookie name, domain, path or value is read into the report,
 * printed, or sent anywhere, and the browser is never navigated to any site.
 *
 * Run with ORBIT_REAL_PROFILE=1 only when the person has asked for it.
 */
if (process.env.ORBIT_REAL_PROFILE !== "1")
  throw new Error("Refusing to read a real browser profile. Set ORBIT_REAL_PROFILE=1 only when the person asked for this.");
await requireResourceBudget();

const CHROME = "/opt/google/chrome/chrome";
// Which profile to clone. Defaults to the system Chrome profile; pass a path to test another, for
// example a Flatpak browser's profile under ~/.var/app, whose key is held through the Secret portal.
const source = process.argv[2] ?? join(homedir(), ".config", "google-chrome");
const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? "/run/user/1000";
// The clone must share a filesystem with the source for the extents to be shared instead of copied.
const base = await mkdtemp(join(homedir(), ".cache", "orbit-real-clone-"));
const busRoot = await mkdtemp(join(runtimeRoot, "orbit-bus-"));   // unix socket paths cap near 108 bytes
const socket = join(busRoot, "bus");
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), source: source.replace(homedir(), "~") };

/** Counts rows and encryption versions. Never selects a name, host, path or value. */
function jarShape(directory: string) {
  try {
    const database = new Database(join(directory, "Default", "Cookies"), { readonly: true });
    const rows = database.query("select hex(substr(encrypted_value,1,3)) prefix, count(*) n from cookies group by 1").all() as { prefix: string; n: number }[];
    database.close();
    const versions: Record<string, number> = {};
    for (const row of rows) versions[Buffer.from(row.prefix, "hex").toString() || "empty"] = row.n;
    return { rows: rows.reduce((sum, row) => sum + row.n, 0), versions };
  } catch (error) { return { rows: 0, versions: {}, unreadable: String(error).slice(0, 80) }; }
}

let proxy: ReturnType<typeof Bun.spawn> | undefined;
let context: BrowserContext | undefined;
try {
  report.sourceRunning = (await Bun.spawn(["/usr/bin/pgrep", "-f", CHROME], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  report.sourceJar = jarShape(source);
  report.extensionsInSource = (await readdir(join(source, "Default", "Extensions")).catch(() => [])).length;

  const clone = join(base, "profile");
  const started = performance.now();
  await cp(source, clone, { recursive: true, dereference: false, force: true });
  report.copy = { milliseconds: Math.round(performance.now() - started) };

  const inherited: string[] = [];
  for (const entry of await readdir(clone)) {
    if (!entry.startsWith("Singleton")) continue;
    inherited.push(entry);
    await rm(join(clone, entry), { force: true });
  }
  report.singletonMarkersRemoved = inherited;
  report.cloneJar = jarShape(clone);

  const usage = Bun.spawn(["/usr/bin/btrfs", "filesystem", "du", "-s", clone], { stdout: "pipe", stderr: "ignore" });
  (report.copy as Record<string, unknown>).btrfsSummary = await usage.exited === 0
    ? ((await new Response(usage.stdout).text()).trim().split("\n").pop() ?? "").trim() : "btrfs du unavailable";

  // The keyring holds the key, and a filtered bus is the only way to reach it without handing the
  // browser the whole session bus. The exposure that carries is recorded in the review document.
  proxy = Bun.spawn(["/usr/bin/xdg-dbus-proxy", `unix:path=${runtimeRoot}/bus`, socket, "--filter", "--talk=org.freedesktop.secrets"],
    { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 120 && !(await readdir(busRoot)).includes("bus"); i++) await Bun.sleep(50);

  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${socket}` } as Record<string, string>;
  // Playwright's own defaults include --disable-extensions, so the person's extensions stay dormant
  // unless that default is dropped. ORBIT_KEEP_EXTENSIONS=1 drops it, to measure the difference.
  const keepExtensions = process.env.ORBIT_KEEP_EXTENSIONS === "1";
  const launchArgs = ["--password-store=gnome-libsecret", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--no-sandbox"];
  context = await chromium.launchPersistentContext(clone, {
    headless: true, executablePath: CHROME, env, args: launchArgs,
    ...(keepExtensions ? { ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"] } : {}),
  });
  report.browserStarted = true;

  // The decisive number. If the keyring key is wrong, cookies come back with empty values.
  const cookies = await context.cookies();
  const withValue = cookies.filter(cookie => cookie.value.length > 0).length;
  report.decryption = {
    cookiesReturned: cookies.length,
    withNonEmptyValue: withValue,
    // A single ratio is the whole result. No name, domain or value leaves this process.
    decryptedShare: cookies.length ? Number((withValue / cookies.length).toFixed(4)) : 0,
  };

  // Did the person's own extensions survive into the clone, and did any of them start? Playwright
  // forces --disable-extensions into its default arguments, so this is measured both ways.
  const live = context;
  report.extensions = {
    inClone: (await readdir(join(clone, "Default", "Extensions")).catch(() => [])).length,
    backgroundPages: live.backgroundPages().length,
    serviceWorkers: live.serviceWorkers().length,
    launchArguments: launchArgs,
  };
} catch (error) {
  report.failure = (String(error).split("\n").at(0) ?? "unknown failure").slice(0, 300);
} finally {
  if (context) await context.close().catch(() => {});
  proxy?.kill();
  // The clone is a complete copy of the person's browsing identity. It does not outlive this run.
  await rm(base, { recursive: true, force: true });
  await rm(busRoot, { recursive: true, force: true });
}

await mkdir("output", { recursive: true, mode: 0o700 });
const label = source.includes("/.var/app/") ? "flatpak" : "system";
const path = join("output", `real-profile-clone-${label}-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`\nclone deleted; report written to ${path}`);
