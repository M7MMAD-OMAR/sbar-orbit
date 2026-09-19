/**
 * THE ESCAPE, attacked from the composed entry point rather than from the launcher.
 *
 * `tests/person-browser.test.ts` calls `launchChrome` directly and asks whether a second browser is
 * left alone. It is a good test of the singleton hazard and it holds one axis fixed: the browser is
 * started by the test, not by the broker, so nothing it asserts covers what the BROKER hands a
 * session. Every environment variable that would reach the person's compositor, pointer, keyboard,
 * clipboard or session bus is decided in `src/chrome.ts` on the path only `session.create` takes,
 * and on a confinable host that path is wrapped in `bwrap` by `src/egress.ts` as well, so the
 * process the launcher owns is not even the browser.
 *
 * So these drive `Sessions.dispatch`, which is the same object the broker's socket and the MCP
 * adapter call, and they assert the ABSENCE of a reach: a process whose environment names the
 * person's Wayland display can talk to their compositor, and no output of any action would show it.
 */
import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectPlatform } from "../../src/platform";
import { openBroker, startFixture, act } from "./probe";

const supported = (await detectPlatform()).browserBackendSupported && process.platform === "linux";

/** Every environment entry of a process, as the kernel holds it rather than as a launcher intended. */
async function environmentOf(pid: number): Promise<Map<string, string>> {
  const raw = await readFile(`/proc/${pid}/environ`, "utf8");
  const found = new Map<string, string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const split = entry.indexOf("=");
    if (split > 0) found.set(entry.slice(0, split), entry.slice(split + 1));
  }
  return found;
}

async function argvOf(pid: number): Promise<string[]> {
  return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
}

async function descendants(pid: number, seen = new Set<number>()): Promise<number[]> {
  if (seen.has(pid)) return [];
  seen.add(pid);
  const children = new Set<number>();
  try {
    for (const task of await readdir(`/proc/${pid}/task`)) {
      try {
        for (const id of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8")).split(/\s+/).filter(Boolean))
          children.add(Number(id));
      } catch {}
    }
  } catch { return []; }
  const deeper = await Promise.all([...children].map(child => descendants(child, seen)));
  return [...children, ...deeper.flat()];
}

/** The profile the broker made for this session, found the way a reviewer would: on disk. */
async function sessionProfile(workspace: string): Promise<string> {
  const entries = await readdir(workspace);
  const profile = entries.find(entry => entry.startsWith("profile-"));
  if (!profile) throw new Error("The session left no profile directory to inspect");
  return join(workspace, profile);
}

/**
 * The keys that are a reach onto the person's machine, not a preference.
 *
 * `WAYLAND_DISPLAY` and `WAYLAND_SOCKET` are the compositor: a client holding either can open
 * windows on the person's screen and, on wlroots, ask for a screencopy of it. `DISPLAY` and
 * `XAUTHORITY` are the X server, where an ordinary client can read every keystroke on the display.
 */
const forbidden = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"];

/**
 * The person's own browser state directories, which no process a session starts may name.
 *
 * This is the generalisation of the crash handler defect fixed in c9a5413: the handler's
 * `--database` came from the browser's BRANDING rather than from `--user-data-dir`, so a fresh
 * profile did not give a fresh crash database and a session's handler wrote into
 * `~/.config/google-chrome/Crash Reports`. A rule about one flag would not have caught it, so the
 * rule here is about the directory.
 */
const personalBrowserDirectories = [
  join(homedir(), ".config", "google-chrome"),
  join(homedir(), ".config", "chromium"),
  join(homedir(), ".config", "microsoft-edge"),
  join(homedir(), ".config", "BraveSoftware"),
  join(homedir(), ".mozilla"),
];

test.skipIf(!supported)("the browser a session is given cannot reach the person's display, pointer or keyboard", async () => {
  const broker = await openBroker("adversarial-escape");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "escape probe",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    await act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/` });

    const profile = await sessionProfile(broker.workspace);
    const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as { pid: number };
    const tree = [owner.pid, ...await descendants(owner.pid)];
    // A tree of one is a browser that never started its renderers, and asserting over it would be
    // asserting over nothing.
    expect(tree.length).toBeGreaterThan(3);

    let inspected = 0, withBus = 0, browsers = 0;
    for (const pid of tree) {
      let environment: Map<string, string>;
      let argv: string[];
      try { environment = await environmentOf(pid); argv = await argvOf(pid); } catch { continue }
      // Chrome scrubs its own renderers' environment down to one entry, so those say nothing either
      // way; the processes that carry the launcher's environment are the subject.
      if (environment.size < 2) continue;
      inspected++;
      for (const key of forbidden)
        expect({ pid, key, value: environment.get(key) }).toEqual({ pid, key, value: undefined });
      // The session bus is the other half of the same reach: through the person's bus a browser can
      // move itself into a systemd scope of its own, out of Orbit's resource budget, and a keyring
      // on that bus holds their live cookies. Where the address is set at all it must point inside
      // this session's own profile.
      const bus = environment.get("DBUS_SESSION_BUS_ADDRESS");
      if (bus !== undefined) {
        withBus++;
        expect({ pid, inside: bus.startsWith(`unix:path=${profile}/`) }).toEqual({ pid, inside: true });
        expect(bus).not.toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
      }
      // The browser process itself must name its own profile and stay headless. A Chromium launch
      // that handed off to a running instance would be driving the person's windows while reporting
      // a healthy session, and a second --user-data-dir would decide which profile silently.
      //
      // `chrome_crashpad_handler` matches /chrome/ and carries no `--type=`, so an unguarded filter
      // counts it as the browser and then fails on arguments that are not the browser's. It is a
      // separate program and is interrogated as one in the tree wide check below.
      const executable = argv[0] ?? "";
      const isBrowser = /chrome|chromium|msedge/.test(executable)
        && !/crashpad|crash_reporter|crash_handler/.test(executable)
        && !argv.some(entry => entry.startsWith("--type="));
      if (isBrowser) {
        browsers++;
        expect(argv).toContain(`--user-data-dir=${profile}`);
        expect(argv.filter(entry => entry.startsWith("--user-data-dir=")).length).toBe(1);
        expect(argv.some(entry => entry === "--headless" || entry.startsWith("--headless"))).toBe(true);
      }
      // The person's own browser directories are the subject of the dedicated test below, which
      // currently FAILS, so they are deliberately not asserted here: folding a known live defect into
      // this test would turn a proven finding into a red suite with no name on it.
    }
    // Each loop has to have had something to say, or the assertions inside it guarded nothing.
    expect(inspected).toBeGreaterThan(0);
    expect(withBus).toBeGreaterThan(0);
    expect(browsers).toBe(1);

    // And the value itself, not only the key. If the broker ever passed the person's display under
    // some other name, this is what would still catch it.
    const host = process.env.WAYLAND_DISPLAY;
    if (host) {
      const environment = await environmentOf(owner.pid);
      expect([...environment.entries()].filter(([, value]) => value === host)).toEqual([]);
    }
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);

/**
 * DEFECT, still live after c9a5413, and this is why the running tree has to be asked rather than the
 * source.
 *
 * c9a5413 added `--disable-crash-reporter` to the Linux branch and `tests/crash-handler.test.ts`
 * asserts it, from the source and from the browser's own argv. Both are true and the escape is still
 * there. Measured on Fedora 44 with Chrome 152, through a real broker session:
 *
 *   the browser  /opt/google/chrome/chrome ... --disable-crash-reporter --password-store=basic ...
 *   its child    /opt/google/chrome/chrome_crashpad_handler --monitor-self
 *                  --database=~/.config/google-chrome/Crash Reports
 *                  --url=https://clients2.google.com/cr/report
 *   and a second handler with --no-periodic-tasks, and every renderer carrying
 *                  --enable-crash-reporter=,
 *
 * So on this Chrome the flag does not stop the handler starting: two handlers run, both pointed at the
 * PERSON'S own `~/.config/google-chrome/Crash Reports`, and the browser tells its own children that
 * crash reporting is enabled. The fix's own test cannot see this because it asks the browser's argv
 * for a flag that is present, and the defect is in what the browser does with it.
 *
 * What is and is not claimed. This is a write into the person's browser state directory by a process
 * a session started, which is the promise the project is built on. It is NOT an unconstrained upload
 * on a leased session: the handler is a descendant of the `bwrap` wrapper, so on a session with
 * bounded origins it is inside the network namespace and `clients2.google.com` is not reachable from
 * there. On a session with `origins: "any"` no namespace is opened at all, and then it is.
 *
 * Remove `.failing` when no handler runs, or when its `--database` is inside the session profile.
 */
test.failing.skipIf(!supported)("no live process under a session names the person's crash database or its upload endpoint", async () => {
  const broker = await openBroker("adversarial-crashpad");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "crash handler",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    await act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/` });

    const profile = await sessionProfile(broker.workspace);
    const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as { pid: number };
    const tree = [owner.pid, ...await descendants(owner.pid)];
    expect(tree.length).toBeGreaterThan(3);

    // The control first: the flag IS being passed, so this is not a test of a missing flag.
    const browser = (await Promise.all(tree.map(async pid => {
      try { return await argvOf(pid); } catch { return [] }
    }))).find(argv => /chrome|chromium/.test(argv[0] ?? "")
      && !/crashpad|crash_reporter|crash_handler/.test(argv[0] ?? "")
      && !argv.some(entry => entry.startsWith("--type=")));
    expect(browser).toBeDefined();
    expect(browser).toContain("--disable-crash-reporter");

    // And now the thing the flag was supposed to achieve.
    const offenders: { pid: number; executable: string; named: string }[] = [];
    let examined = 0, handlers = 0;
    for (const pid of tree) {
      let argv: string[];
      try { argv = await argvOf(pid); } catch { continue }
      if (!argv.length) continue;
      examined++;
      const executable = argv[0] ?? "";
      if (/crashpad|crash_reporter|crash_handler/.test(executable)) handlers++;
      // The directory and the endpoint, each named rather than inferred from a flag: a handler that
      // came back under a different flag name would still fail these.
      for (const personal of [...personalBrowserDirectories, "clients2.google.com", "/cr/report"])
        if (argv.some(entry => entry.includes(personal))) offenders.push({ pid, executable, named: personal });
    }
    expect(examined).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
    expect(handlers).toBe(0);
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);
