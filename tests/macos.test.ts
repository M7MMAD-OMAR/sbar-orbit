import { test, expect } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

darwinOnly("an enumeration error is not an empty group, and the difference gates a SIGKILL")(
  "a failed group read is reported as failed, never as empty", async () => {
  const { processGroupMembers, processGroupOf } = await import("../src/macos");
  // THIS PROCESS'S GROUP, asked of the kernel. Not `process.pid`: a pid is only a group id when the
  // process happens to be a group leader, and a test runner started by a shell is not one. Asserting
  // members for `process.pid` measured a group that does not exist and read 0, which is the same
  // mistake in miniature as the one this test guards, so it is worth naming rather than quietly
  // correcting.
  const pgid = processGroupOf(process.pid);
  expect(pgid).not.toBeNull();
  const mine = processGroupMembers(pgid!);
  expect(mine.failed).toBe(false);
  expect(mine.pids.length).toBeGreaterThan(0);

  // A pgid that does not exist. Measured on a macOS runner: `proc_listpids` returns **0 bytes**
  // here, not a negative, so the kernel is answering "that group has no members" rather than
  // refusing. `failed` is reserved for the kernel declining to answer at all.
  const absent = processGroupMembers(0x7ffffffe);
  expect(absent.pids).toEqual([]);
  expect(absent.failed).toBe(false);

  // A group id that is structurally not ours is a clean empty answer rather than a failure, so
  // callers never escalate over pgid 1 or 0.
  expect(processGroupMembers(1).failed).toBe(false);
  expect(processGroupMembers(0).failed).toBe(false);

  // The property that matters: a live group and an absent one are distinguishable. A caller that
  // escalates to SIGKILL reads membership to decide, so a live group reading as empty is what let a
  // tree that ignored SIGTERM survive.
  expect(mine.pids.length).toBeGreaterThan(absent.pids.length);
});

darwinOnly("the registry root check runs after requireDarwin, so it is only reachable on a Mac")(
  "the budget registry refuses a root that is not a private directory of this user", async () => {
  // `ORBIT_BUDGET_ROOT` is how a test points the registry somewhere disposable, and it was taken
  // verbatim: any process that could set it or pre-create the path could forge a registration, and
  // `requireResourceBudget()` passes for any process whose group is listed. That is the whole budget
  // gate, so the root gets the same four checks `createWorkspaceDirectory` applies.
  //
  // Asserted against the validator directly rather than through `registerBudgetGroup`, because that
  // function checks group leadership FIRST and the suite is not usually a group leader: driving it
  // through the front door tested the leader guard and never reached the path guard at all. Measured
  // on a macOS runner, where this test failed with "has to come from a process group leader".
  const { assertPrivateRegistryRoot } = await import("../src/macos-budget");
  await expect(assertPrivateRegistryRoot("relative/path")).rejects.toThrow(/absolute/);
  // A world writable directory is refused even though it is absolute and really is a directory: the
  // mode is what decides whether anything else on the machine could have written the registrations
  // this gate then trusts.
  const loose = await mkdtemp(join(tmpdir(), "orbit-budget-loose-"));
  try {
    await chmod(loose, 0o777);
    await expect(assertPrivateRegistryRoot(loose)).rejects.toThrow(/private directory/);
    // And the ordinary case passes, so this is not a function that refuses everything.
    await chmod(loose, 0o700);
    expect(await assertPrivateRegistryRoot(loose)).toBe(loose);
  } finally { await rm(loose, { recursive: true, force: true }); }
});

darwinOnly("the viewer must never open in the person's own browser profile")(
  "macOS lists real browser bundles, so the viewer never falls through to open(1)", async () => {
  const { listHostBrowsers, openViewer } = await import("../src/host-browsers");
  const browsers = await listHostBrowsers();
  // The defect this closes: `listHostBrowsers` scanned `.desktop` files, which do not exist on
  // macOS, so it returned [] on EVERY Mac and `openViewer` fell through to `open`. LaunchServices
  // then handed the viewer's access token to whichever browser the person was already using, in
  // their real profile. That is not a corner case, it was the only macOS path.
  for (const browser of browsers) {
    // The Mach-O inside the bundle, never `open` and never the bundle directory.
    expect(browser.command[0]).toMatch(/\/Contents\/MacOS\//);
    expect(browser.command[0]).not.toBe("open");
    // Chromium family, which is what makes `--user-data-dir` work and earns the viewer its own
    // profile. A browser listed without that would be a browser the viewer cannot isolate.
    expect(browser.appWindow).toBe(true);
  }
  // And when there is genuinely no usable browser, the viewer is REFUSED rather than opened in
  // theirs. Asserted through the real function with an id that cannot match anything installed.
  if (!browsers.length) {
    const result = await openViewer("http://127.0.0.1:1/viewer?token=fixture");
    expect(result.opened).toBe(false);
  }
});

darwinOnly("the orphan sweep decides what to signal, so its refusals have to be tested")(
  "the sweep refuses a group it cannot prove is Orbit's, and finds records at the real depth", async () => {
  const { sweepOrphanedSessions } = await import("../src/macos-orphans");
  const { processGroupOf } = await import("../src/macos");
  const root = await mkdtemp(join(tmpdir(), "orbit-orphan-test-"));
  try {
    // The REAL layout, which is what the first version of this sweep got wrong: a broker makes
    // `<root>/broker-XXXX/` and a session makes `<root>/broker-XXXX/profile-XXXX/`, so the record
    // sits two levels down. A fixture written one level down would have passed against a sweep that
    // finds nothing on a real machine.
    const workspace = await mkdtemp(join(root, "broker-"));
    const profile = await mkdtemp(join(workspace, "profile-"));

    // A live group, this process's own, with a start time that is deliberately wrong. That is the
    // shape of a reused process group id: the number is real and currently belongs to somebody, and
    // the facts recorded when Orbit created its group do not match. Signalling it would reach
    // whatever holds the number now, which on a person's Mac could be their own browser.
    const pgid = processGroupOf(process.pid)!;
    await writeFile(join(profile, "owner.json"), JSON.stringify({
      pid: process.pid, pgid,
      leaderStartedAtMs: Date.now() - 3_600_000,
      leaderExecutable: "/usr/bin/true",
    }));

    const swept = await sweepOrphanedSessions(root);
    // Found at the real depth: the whole point of the walk.
    expect(swept.inspected).toBe(1);
    // And REFUSED rather than signalled. This is the assertion that matters: nothing was killed.
    expect(swept.swept).toEqual([]);
    expect(swept.refused).toHaveLength(1);
    expect(swept.refused[0]!.pgid).toBe(pgid);
    // This process is still here, which is the direct proof that the refusal was honoured: a sweep
    // that signalled its own group would have taken the test runner with it.
    expect(processGroupOf(process.pid)).toBe(pgid);

    // A record with no start time at all is refused for the same reason, rather than trusted.
    await writeFile(join(profile, "owner.json"), JSON.stringify({ pid: process.pid, pgid }));
    const second = await sweepOrphanedSessions(root);
    expect(second.swept).toEqual([]);
    expect(second.refused[0]!.reason).toMatch(/start time/);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("no launcher or home path can inject plist structure", async () => {
  const { brokerAgentPlist } = await import("../src/macos-autostart");
  // Checked as STRUCTURE, not by grepping for dangerous words. A keyword check is how an audit probe
  // convinced itself this was broken: its detector matched the legitimate KeepAlive block that every
  // plist carries. What an injection has to achieve is a changed shape, so that is what is asserted.
  const expected = ["Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "ProcessType", "Nice",
    "LowPriorityIO", "LowPriorityBackgroundIO", "EnvironmentVariables", "StandardErrorPath"];
  for (const attack of [
    // The ordinary case first, so the assertions below are known to hold for a normal path before
    // any attack is tried. `example` is the reserved documentation name the audit exempts; any other
    // name here reads as a real person's home directory and is reported, correctly.
    "/Users/example/bin/sbar-orbit",
    // The worst case, and the reason this test exists: AbandonProcessGroup absent from the plist is
    // what makes `launchctl bootout` sweep the job's process group. An input that could add it as
    // true would silently disable a containment layer.
    "/Users/x</string><key>AbandonProcessGroup</key><true/><string>y",
    // Replacing the argv array outright, which would make launchd run something else entirely. The
    // payload names a harmless binary on purpose: writing a real Automation trigger here would be a
    // finding in `scripts/public-audit.ts`, and widening that audit's exemption to cover this file
    // would blind it to a genuine call. The injection being tested is structural, so the target does
    // not matter.
    "/Users/x</string></array><key>ProgramArguments</key><array><string>/usr/bin/true",
    '/Users/x"/><key>RunAtLoad</key><false/><string x="',
    "/Users/x]]><!--",
    // An ampersand is the ordinary case rather than an attack: a real account can be named this way,
    // and an unescaped one makes launchd refuse the whole file with a byte offset.
    "/Users/a&b/c",
  ]) {
    const plist = brokerAgentPlist(attack, "/tmp/s.sock", attack);
    const keys = [...plist.matchAll(/^ {2}<key>([^<]+)<\/key>$/gm)].map(match => match[1]);
    expect(keys).toEqual(expected);
    // The ProgramArguments array alone, so the EnvironmentVariables strings are not counted.
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
    const argv = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1]);
    expect(argv).toHaveLength(3);
    expect(argv[1]).toBe("serve");
    expect(argv[2]).toBe("--managed-socket");
    // Whatever the path was, it arrives as TEXT: no element survives inside it.
    expect(argv[0]).not.toMatch(/<(key|array|dict|true|false)\b/);
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
