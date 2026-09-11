import { chromium, type BrowserContext } from "playwright";
import { mkdir, mkdtemp, cp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { requireResourceBudget } from "../src/resource-budget";
import { stripSingletonMarkers } from "../src/platform";

/**
 * Gate G8: can a session reach its browser key without holding the whole keyring?
 *
 * A filtering proxy narrows the bus NAME but not which items may be searched, and measured on this
 * workstation a client on one enumerated all twenty five items in the login collection to reach a
 * single key. This compares that against a private bus carrying exactly one item, on the two things
 * that decide it: how much is reachable, and whether the profile still decrypts.
 *
 * Reads the person's real profile and one item from their real keyring, so it is opt in. No cookie
 * name, host or value is recorded, and the clone is deleted before the process exits.
 */
if (process.env.ORBIT_REAL_PROFILE !== "1")
  throw new Error("This reads a real profile and one real keyring item. Set ORBIT_REAL_PROFILE=1 only when the person asked for it.");
await requireResourceBudget();

const CHROME = "/opt/google/chrome/chrome";
const SOURCE = join(homedir(), ".config", "google-chrome");
const RUNTIME = process.env.XDG_RUNTIME_DIR ?? "/run/user/1000";
const base = await mkdtemp(join(homedir(), ".cache", "orbit-one-secret-"));
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

/** How many keyring items a client on this bus can enumerate. The whole point of the gate. */
async function reachableItems(address: string) {
  const probe = Bun.spawn(["/usr/bin/gdbus", "call", "--address", address, "--dest", "org.freedesktop.secrets",
    "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.SearchItems", "{}"],
    { stdout: "pipe", stderr: "pipe" });
  if (await probe.exited !== 0) return { count: 0, error: (await new Response(probe.stderr).text()).split("\n")[0]?.slice(0, 120) };
  const text = await new Response(probe.stdout).text();
  return { count: (text.match(/\/org\/freedesktop\/secrets\/[A-Za-z0-9_\/]+/g) ?? []).length };
}

/** Is the route Chrome uses to move itself into an uncapped systemd scope reachable from this bus? */
async function systemdReachable(address: string) {
  const probe = Bun.spawn(["/usr/bin/gdbus", "call", "--address", address, "--dest", "org.freedesktop.systemd1",
    "--object-path", "/org/freedesktop/systemd1", "--method", "org.freedesktop.DBus.Peer.Ping"],
    { stdout: "ignore", stderr: "ignore" });
  return await probe.exited === 0;
}

async function cloneFor(name: string) {
  const directory = join(base, name);
  await cp(SOURCE, directory, { recursive: true, dereference: false, force: true });
  await stripSingletonMarkers(directory);
  const { chmod } = await import("node:fs/promises");
  await chmod(directory, 0o700);
  return directory;
}

/** The share of cookies that come back with a value. Counts only; no name, host or value is read. */
async function decryptedShare(profile: string, address: string | undefined) {
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: CHROME,
      args: ["--password-store=gnome-libsecret", "--no-first-run", "--no-default-browser-check", "--no-sandbox"],
      ...(address ? { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } as Record<string, string> } : {}),
    });
    const cookies = await context.cookies();
    const withValue = cookies.filter(cookie => cookie.value.length > 0).length;
    return { returned: cookies.length, withValue, share: cookies.length ? Number((withValue / cookies.length).toFixed(4)) : 0 };
  } catch (error) { return { error: String(error).split("\n").at(0)?.slice(0, 160) }; }
  finally { if (context) await context.close().catch(() => {}); }
}

/** Bun types a spawn's pipes from its options, which a later-assigned binding loses. */
type Piped = { stdin: { end(): void }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; kill(): void };
let holder: Piped | undefined;
let proxy: ReturnType<typeof Bun.spawn> | undefined;
let proxyRoot: string | undefined;
try {
  // The narrow bus: one item, read out of the real keyring by the broker and served on a bus of its own.
  holder = Bun.spawn(["/usr/bin/python3", resolve("src/native/one_secret.py"), JSON.stringify({ application: "chrome" }), "Chrome Safe Storage"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as Piped;
  const line = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the one-item bus did not announce itself")), 15000);
    (async () => {
      const reader = holder!.stdout.getReader();
      const { value } = await reader.read();
      clearTimeout(timer);
      done(new TextDecoder().decode(value).trim());
    })().catch(error => { clearTimeout(timer); fail(error); });
  });
  const narrow = (JSON.parse(line) as { address: string }).address;
  report.oneItemBus = {
    reachable: await reachableItems(narrow),
    systemdReachable: await systemdReachable(narrow),
    decryption: await decryptedShare(await cloneFor("narrow"), narrow),
  };

  // The filtering proxy, for comparison. This is what shipped before this gate.
  proxyRoot = await mkdtemp(join(RUNTIME, "orbit-bus-"));
  const socket = join(proxyRoot, "bus");
  proxy = Bun.spawn(["/usr/bin/xdg-dbus-proxy", `unix:path=${RUNTIME}/bus`, socket, "--filter", "--talk=org.freedesktop.secrets"],
    { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 120 && !(await readdir(proxyRoot)).includes("bus"); attempt++) await Bun.sleep(50);
  const filtered = `unix:path=${socket}`;
  report.filteredProxy = {
    reachable: await reachableItems(filtered),
    systemdReachable: await systemdReachable(filtered),
    decryption: await decryptedShare(await cloneFor("filtered"), filtered),
  };

  // The control: no bus at all, which is what Orbit did before any of this.
  report.noBus = { decryption: await decryptedShare(await cloneFor("none"), `unix:path=${base}/absent`) };
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  if (holder) {
    holder.stdin.end();
    holder.kill();
    // The last line is the read count the service reports on its way out; anything before it is noise.
    const tail = (await new Response(holder.stderr).text()).trim().split("\n").at(-1) ?? "";
    report.holderReads = tail.startsWith("{") ? JSON.parse(tail) : tail.slice(0, 160);
  }
  proxy?.kill();
  if (proxyRoot) await rm(proxyRoot, { recursive: true, force: true }).catch(() => {});
  await rm(base, { recursive: true, force: true });
}

await mkdir("output", { recursive: true, mode: 0o700 });
const path = join("output", `one-secret-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
