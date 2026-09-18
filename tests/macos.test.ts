import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { homedir, tmpdir } from "node:os";
import { darwinBrowserInstalls } from "../src/runtime-paths";
import { canCloneProfile, detectPlatform, hostClassTier, type PlatformCapabilities } from "../src/platform";
import { assertDarwinSocketPath, connectorConfigDirectory, DARWIN_SOCKET_PATH_MAX, serviceSocketPath, stateDirectory } from "../src/service";
import { brokerAgentPlist, BROKER_LABEL, launchAgentPath } from "../src/macos-autostart";
import { budgetRegistryRoot, liveBudgetGroups, registerBudgetGroup, unregisterBudgetGroup } from "../src/macos-budget";

/**
 * The macOS adapter, tested where it can be tested from any host.
 *
 * Split deliberately into two kinds. Everything here that takes a `home` or an `env` is a pure
 * function and runs on every platform, including this Fedora workstation, which is the only way
 * these rules get a test at all before a Mac is in reach: the Windows port learned that lesson when
 * `parsePolicy`'s POSIX-only path check made an advisor impossible to configure on Windows and no
 * test could have caught it from Linux.
 *
 * Anything that asks the real kernel is gated on `process.platform === "darwin"` and skipped with a
 * reason elsewhere, because a skip is not a pass and `docs/support-tiers.md` counts them separately.
 */

const darwinOnly = (reason: string) => {
  if (!reason.trim()) throw new Error("A darwin only test has to say why");
  return process.platform === "darwin" ? test : test.skip;
};

const macHome = "/Users/example";

test("a macOS browser is found as the Mach-O inside its bundle, never the bundle itself", () => {
  // The whole hazard in one assertion. `open -a "Google Chrome"` hands the command line to the
  // person's already running browser and puts a window on their screen; running the binary inside
  // the bundle starts a separate process that LaunchServices is not involved in. If this function
  // ever returned a `.app` path, the launcher would have to go through `open` and the guarantee
  // would be gone.
  const installs = darwinBrowserInstalls(macHome, path =>
    path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  expect(installs).toHaveLength(1);
  expect(installs[0]!.executable).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  expect(installs[0]!.executable.endsWith(".app")).toBe(false);
  expect(installs[0]!.profileDirectory).toBe("/Users/example/Library/Application Support/Google/Chrome");
});

test("a per user install under ~/Applications is found, and /Applications wins when both exist", () => {
  const userOnly = darwinBrowserInstalls(macHome, path =>
    path === "/Users/example/Applications/Chromium.app/Contents/MacOS/Chromium");
  expect(userOnly.map(install => install.id)).toEqual(["chromium"]);

  const both = darwinBrowserInstalls(macHome, path => path.endsWith("/Contents/MacOS/Google Chrome"));
  // One entry, not two: a profile belongs to one install, and reporting the same branding twice
  // would let a session be handed the system bundle's profile and the user bundle's binary.
  expect(both).toHaveLength(1);
  expect(both[0]!.executable.startsWith("/Applications/")).toBe(true);
});

test("the browser order is Chrome first, because a profile is tied to the branding that wrote it", () => {
  const all = darwinBrowserInstalls(macHome, () => true);
  expect(all.map(install => install.id)).toEqual(["google-chrome", "chromium", "microsoft-edge", "brave"]);
});

test("a macOS socket path over Darwin's sun_path limit is refused rather than silently truncated", () => {
  const fits = "/Users/example/Library/Application Support/sbar-orbit/broker.sock";
  expect(Buffer.byteLength(fits)).toBeLessThanOrEqual(DARWIN_SOCKET_PATH_MAX);
  expect(assertDarwinSocketPath(fits)).toBe(fits);

  // The real failure this guards: a long user name. Darwin truncates at 104 bytes with no error, so
  // the broker binds a path that is not the one it reports and every client dials nothing.
  const tooLong = `/Users/${"a".repeat(80)}/Library/Application Support/sbar-orbit/broker.sock`;
  expect(Buffer.byteLength(tooLong)).toBeGreaterThan(DARWIN_SOCKET_PATH_MAX);
  expect(() => assertDarwinSocketPath(tooLong)).toThrow(/104|103|bytes/);
});

test("macOS per user paths are Library paths, and an explicit XDG setting still wins", () => {
  // Asked with an explicit platform so this runs on any host: the rule is what is under test, not
  // what this machine happens to be.
  // `homedir()` and a POSIX join, not `process.env.HOME` and the host's join: a macOS path is POSIX
  // whatever host computes it, and on Windows `HOME` is often unset while `join` writes backslashes,
  // so the old form was asserting about the runner rather than about macOS.
  const home = homedir();
  expect(connectorConfigDirectory({} as NodeJS.ProcessEnv, "darwin"))
    .toBe(posix.join(home, "Library/Application Support/sbar-orbit"));
  expect(stateDirectory({} as NodeJS.ProcessEnv, "darwin"))
    .toBe(posix.join(home, "Library/Application Support/sbar-orbit"));
  // Somebody who has deliberately set up an XDG layout on a Mac meant it.
  expect(connectorConfigDirectory({ XDG_CONFIG_HOME: "/x/config" } as NodeJS.ProcessEnv, "darwin")).toBe("/x/config/sbar-orbit");
  expect(stateDirectory({ XDG_STATE_HOME: "/x/state" } as NodeJS.ProcessEnv, "darwin")).toBe("/x/state/sbar-orbit");
});

test("the macOS broker socket does not go in the per user temporary directory", () => {
  const path = serviceSocketPath(undefined, {} as NodeJS.ProcessEnv, "darwin");
  // `/var/folders/...` is `$TMPDIR` on macOS and is periodically swept, which would remove a live
  // broker's socket out from under it. This assertion is the reason the path is where it is.
  expect(path.startsWith("/var/folders")).toBe(false);
  expect(path).toContain("Library/Application Support/sbar-orbit");
  expect(path.endsWith("broker.sock")).toBe(true);
});

test("the launch agent plist is valid XML, names the broker, and never abandons its process group", () => {
  const plist = brokerAgentPlist("/Users/example/.local/bin/sbar-orbit", "/Users/example/Library/Application Support/sbar-orbit/broker.sock", macHome);
  expect(plist).toContain(`<string>${BROKER_LABEL}</string>`);
  expect(plist).toContain("<string>serve</string>");
  expect(plist).toContain("<string>--managed-socket</string>");
  // The containment guarantee `launchctl bootout` provides depends on launchd killing the job's
  // remaining process group. `AbandonProcessGroup` would switch that off, so its ABSENCE is the
  // assertion, and this test exists so nobody adds it later as a tidy-up.
  expect(plist).not.toContain("AbandonProcessGroup");
  // The scheduling half of the budget, which is the only half macOS enforces.
  expect(plist).toContain("<key>ProcessType</key>");
  expect(plist).toContain("<string>Background</string>");
  expect(plist).toContain("<key>LowPriorityIO</key>");
  // NOT a resource limit: HardResourceLimits CPU is RLIMIT_CPU, cumulative seconds with a SIGKILL,
  // which kills a healthy long lived broker for staying alive. docs/porting.md records the deletion.
  expect(plist).not.toContain("HardResourceLimits");
  // A LaunchAgent inherits no usable PATH, so the launcher is named absolutely.
  expect(plist).toContain("<string>/Users/example/.local/bin/sbar-orbit</string>");
});

test("a home directory with XML metacharacters does not produce a broken plist", () => {
  // `launchctl bootstrap` refuses an unescaped ampersand with a parse error naming a byte offset,
  // which is unreadable, and a person whose account is named with one would never get an agent.
  const plist = brokerAgentPlist("/Users/a&b/bin/sbar-orbit", "/Users/a&b/sock", "/Users/a&b");
  expect(plist).toContain("/Users/a&amp;b/bin/sbar-orbit");
  expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
});

test("the launch agent goes in the person's own LaunchAgents directory, not a system one", () => {
  const path = launchAgentPath(macHome, {} as NodeJS.ProcessEnv);
  expect(path).toBe("/Users/example/Library/LaunchAgents/com.sbar.orbit.broker.plist");
  // A LaunchDaemon in /Library/LaunchDaemons would run as root at boot in session 0, which is both
  // more privilege than Orbit asks for and the wrong session for a browser.
  expect(path.startsWith("/Library/")).toBe(false);
});

test("starting from the person's own profile is refused on macOS, with the reason stated", async () => {
  const capabilities = { platform: "darwin", browsers: [], secretService: "absent" } as unknown as PlatformCapabilities;
  const refusal = await canCloneProfile("/Users/example/Library/Application Support/Google/Chrome", capabilities, tmpdir());
  expect(refusal.allowed).toBe(false);
  if (refusal.allowed) throw new Error("unreachable");
  // The refusal has to name the Keychain dialog and the inherited grants, because those are the two
  // facts that make this a refusal rather than an unimplemented feature.
  expect(refusal.reason).toMatch(/Keychain/);
  expect(refusal.reason).toMatch(/grants|camera|microphone/);
});

darwinOnly("the tier a real Mac claims before it has run anything")("a macOS host is Reasoned, never Measured, and the budget caveat is in the reason", async () => {
  const tier = await hostClassTier();
  expect(tier.assigned).toBe("Reasoned");
  // Never Measured from a probe, on any platform: Measured is a named test that ran and passed.
  expect(tier.assigned).not.toBe("Measured");
  expect(tier.why).toMatch(/advisory/);
});

darwinOnly("the capability report has to say the budget is advisory")("detectPlatform states the macOS limits honestly", async () => {
  const capabilities = await detectPlatform();
  expect(capabilities.platform).toBe("darwin");
  // No private display on macOS: there is no second GUI session for one user.
  expect(capabilities.nativeDisplaySupported).toBe(false);
  expect(capabilities.notes.some(note => /advisory/.test(note))).toBe(true);
  expect(capabilities.notes.some(note => /Keychain/.test(note))).toBe(true);
});

darwinOnly("the budget registry is what makes the pool shared across processes")("a registered group is listed, and a dead group is reaped on read", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-budget-"));
  try {
    // A registration for a group that does not exist: the file is on disk and the kernel says the
    // group is empty, which is exactly the shape a SIGKILLed process leaves behind.
    await writeFile(join(root, "999999.json"), JSON.stringify({ pgid: 999999, label: "stale", startedAt: new Date().toISOString() }));
    expect(await liveBudgetGroups(root)).toEqual([]);
    // Reaped on the read path, because nothing else is going to: a killed process runs no cleanup.
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

darwinOnly("a registration must come from a group leader")("registering a group this process is not in is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-budget-"));
  try {
    const { processGroupOf } = await import("../src/macos");
    const pgid = processGroupOf(process.pid);
    // The test process is normally NOT its own group leader, since the shell put it in one. That is
    // the case this refusal exists for: a process charging the pool for work it does not own.
    if (pgid !== process.pid) {
      await expect(registerBudgetGroup("probe", root)).rejects.toThrow(/group leader/);
    } else {
      const entry = await registerBudgetGroup("probe", root);
      expect(entry.pgid).toBe(process.pid);
      await unregisterBudgetGroup(entry.pgid, root);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

darwinOnly("the background class is inherited, so applying it twice costs a process and buys nothing")(
  "the scheduling class is read from the kernel, not assumed", async () => {
  const { inheritedBackgroundClass } = await import("../src/macos");
  // Whatever this process's class is, the answer has to be a real boolean read from the kernel and
  // not a throw, because a launch path branches on it. The suite runs under `scripts/limited.ts`,
  // which sets the class, so the expected answer here is true; asserting only the type keeps this
  // honest if the suite is ever run another way.
  expect(typeof inheritedBackgroundClass()).toBe("boolean");
  // pid 1 is launchd, which is not in the background class. A function that answered true for
  // everything would pass the check above and silently disable the only enforced half of the
  // budget, so this is the assertion that catches a stub.
  expect(inheritedBackgroundClass(1)).toBe(false);
  // A pid that cannot exist reads false rather than throwing: the caller is deciding whether to add
  // one argument, and an exception there would fail a session over a scheduling hint.
  expect(inheritedBackgroundClass(0x7fffffff)).toBe(false);
});

test("the endpoint deadline scales to the machine, with both ends pinned", async () => {
  const { endpointWaitMs } = await import("../src/chrome");
  // The defect this replaced: a flat 15 s that a 3 core runner missed while a quiet launch on the
  // same machine took 1.0 s. A small machine needs MORE time, not less, so the curve runs downward
  // in cores.
  expect(endpointWaitMs(2)).toBeGreaterThan(endpointWaitMs(24));
  // The floor. A big machine keeps the old deadline rather than getting a shorter one, so this is
  // never a regression for the host the project is measured on.
  expect(endpointWaitMs(24)).toBe(15000);
  expect(endpointWaitMs(64)).toBe(15000);
  // The ceiling, which matters as much: a browser that is truly wedged must still fail, and fail
  // while somebody is watching. Without this, a single core machine would wait a minute per launch.
  expect(endpointWaitMs(1)).toBe(45000);
  // The measured case: 3 cores, the runner where the flat deadline was missed.
  expect(endpointWaitMs(3)).toBe(20000);
  // Never zero, negative or NaN, whatever the platform reports. A deadline of zero would fail every
  // launch instantly and read as a browser that cannot start.
  for (const cores of [0, -1, Number.NaN]) {
    const value = endpointWaitMs(cores);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(15000);
  }
});

test("the budget registry root is not in a directory the system sweeps", () => {
  const root = budgetRegistryRoot({} as NodeJS.ProcessEnv, macHome);
  // Losing an entry under-reports the pool, which is the direction that hands out a session the
  // machine cannot afford. `/var/folders` is swept; Application Support is not.
  expect(root.startsWith("/var/folders")).toBe(false);
  expect(root).toBe("/Users/example/Library/Application Support/sbar-orbit/budget");
});

darwinOnly("a reused process group id must never be signalled as if it were ours")(
  "a group is proved by its leader's start time, not by its number", async () => {
  const { groupIsStillOurs, processStartedAtMs, processGroupOf } = await import("../src/macos");
  const pgid = processGroupOf(process.pid);
  expect(pgid).not.toBeNull();
  const startedAt = processStartedAtMs(pgid!);
  // The reading has to be a real timestamp, not a zero that every comparison would accept.
  expect(startedAt).not.toBeNull();
  expect(startedAt!).toBeGreaterThan(1_000_000_000_000);
  expect(startedAt!).toBeLessThanOrEqual(Date.now() + 1000);

  // The true case: the group really is the one that started when we say it did.
  expect(groupIsStillOurs(pgid!, { startedAtMs: startedAt! })).toBe(true);

  // The case this guard exists for. A recycled pgid carries the same NUMBER and a different
  // leader, which shows up as a different start time. Simulated by claiming the group started an
  // hour before it did: if `groupIsStillOurs` compared numbers alone this would pass, and Orbit
  // would go on to `killpg` a group belonging to the person.
  expect(groupIsStillOurs(pgid!, { startedAtMs: startedAt! - 3_600_000 })).toBe(false);

  // The second, independent guard: the leader's executable. It holds even where a timestamp is
  // unreadable or a clock is strange.
  expect(groupIsStillOurs(pgid!, { startedAtMs: startedAt!, executable: "/usr/bin/true" })).toBe(false);

  // A pid that cannot be a group Orbit created is refused before anything is read.
  expect(groupIsStillOurs(1, { startedAtMs: startedAt! })).toBe(false);
  expect(groupIsStillOurs(0, { startedAtMs: startedAt! })).toBe(false);
});

darwinOnly("a stale registration whose number was handed out again must not charge the pool")(
  "the registry reaps an entry whose group id now belongs to somebody else", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-budget-"));
  try {
    const { processGroupOf, processStartedAtMs } = await import("../src/macos");
    const pgid = processGroupOf(process.pid)!;
    // A live group, so membership alone would keep this entry forever, with a start time that says
    // the leader is a different process from the one running now. That is exactly the shape of a
    // reused pgid, and it is the case a membership-only check cannot see.
    await writeFile(join(root, `${pgid}.json`), JSON.stringify({
      pgid, label: "stale", startedAt: new Date().toISOString(),
      leaderStartedAtMs: (processStartedAtMs(pgid) ?? Date.now()) - 3_600_000,
    }));
    expect(await liveBudgetGroups(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
