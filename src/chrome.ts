import { requireHeadroom, requireResourceBudget } from "./resource-budget";
import { chromium, type Browser, type ConnectOverCDPTransport } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OrbitError } from "./errors";
import { chromeExecutables, darwinBrowserInstalls, windowsBrowserInstalls } from "./runtime-paths";
import { inheritedBackgroundClass } from "./macos";
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
 *
 * On Windows the fixed Linux paths cannot apply. The install roots are probed in the order Chrome,
 * then Edge, because a profile is tied to the branding that wrote it and Chrome is the one Orbit's
 * other measurements were taken against. The registry `App Paths` key is authoritative when present,
 * and on the measured guest `msedge.exe` was registered there and `chrome.exe` was absent because
 * Chrome was not installed.
 */
/**
 * How long a browser gets to publish its CDP endpoint, scaled to the machine rather than fixed.
 *
 * This was a flat 15 seconds, which is generous on a 24 thread workstation and tight on a two or
 * three core runner starting several Chrome trees at once. Measured on a macOS runner with 3 cores:
 * a single quiet launch takes about 1.0 s, and under the suite's own concurrency the same launch
 * missed 15 s and failed with "did not publish its local endpoint", which reads as a broken browser
 * rather than as a busy machine.
 *
 * Scaled the same way `src/service.ts` scales the budget, and for the same reason: the number that is
 * right for one machine is wrong for another, and a constant hides which. A small machine gets more
 * time because its browser genuinely needs more, not to paper over a hang. The two CDP deadlines in
 * `launchChrome` already allow 20 s each, so a 15 s cap on the most expensive step in the sequence
 * was also the inconsistent one.
 *
 * The ceiling matters as much as the floor: a browser that is truly wedged must still fail, and fail
 * while somebody is watching, so this tops out rather than growing without limit.
 *
 * Exported and taking its input as a parameter so the rule can be tested on any host, rather than
 * only on whatever core count the machine running the suite happens to have.
 */
export function endpointWaitMs(cores = navigator.hardwareConcurrency) {
  // `Math.max(1, NaN)` is NaN, not 1, so a platform that reports a non number would produce a NaN
  // deadline, and `Date.now() + NaN` is NaN, which no comparison is ever true against: the launch
  // loop would exit on its first pass and every browser would be reported as never having published
  // its endpoint. Guarded explicitly rather than relying on `Math.max` to sanitise, which it does
  // not. The test pins 0, -1 and NaN for exactly this reason.
  const usable = Number.isFinite(cores) && cores >= 1 ? cores : 1;
  return Math.max(15000, Math.min(45000, Math.round(60000 / usable)));
}

export function defaultChromeExecutable(): string | undefined {
  if (process.platform === "win32") return windowsBrowserInstalls()[0]?.executable;
  // macOS resolves bundles rather than fixed paths, and returns the Mach-O inside the bundle: the
  // bundle directory itself is not executable, and handing it to `open` is the one launch route
  // that would reach the person's own running browser.
  if (process.platform === "darwin") return darwinBrowserInstalls()[0]?.executable;
  return chromeExecutables.find(path => Bun.file(path).size > 0);
}


/**
 * The launched browser and whatever keeps it contained, which is a different mechanism per platform.
 *
 * Linux: a Python subreaper holds the tree and `owner.json` names the browser's pid, and containment
 * is the cgroup the whole process tree is already in.
 * Windows: a job object holds the tree, because `KILL_ON_JOB_CLOSE` is the kernel doing what the
 * subreaper does by hand, and there is no `/proc` to compare afterwards.
 */
type OwnedBrowser = {
  /** Ask it to stop, and wait for it. */
  stop: () => Promise<void>;
  /** Null while running. */
  exitCode: () => number | null;
  /** Resolves when the browser is gone, however it went. */
  exited: Promise<unknown>;
  /** The last of what the browser said, for the failure message. */
  diagnostics: () => string;
  /** Throws `RESOURCE_BOUNDARY_LOST` if the tree left its budget. Called once, after the handshake. */
  assertContained: () => Promise<void>;
};

/** Linux: the Python subreaper, exactly as it was, because it is the measured path. */
function launchOnLinux(executable: string, profile: string, argv: string[], env: Record<string, string>): OwnedBrowser {
  const owner = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "native/supervise.py"), join(profile, "owner.json"), executable, ...argv],
    { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  let diagnostics = "";
  void (async () => {
    try { for await (const chunk of owner.stderr) diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-4096); }
    catch {}
  })();
  return {
    exitCode: () => owner.exitCode,
    exited: owner.exited,
    diagnostics: () => {
      // The supervisor records the cause in owner.json, which is how a refused fork stopped being
      // reported as "did not publish its endpoint".
      try { return String(JSON.parse(readFileSync(join(profile, "owner.json"), "utf8")).error?.message ?? ""); } catch { return ""; }
    },
    async stop() {
      owner.stdin.end();
      const kill = setTimeout(() => owner.kill("SIGKILL"), 4000);
      try { await owner.exited; } finally { clearTimeout(kill); }
    },
    async assertContained() {
      const { pid } = JSON.parse(await readFile(join(profile, "owner.json"), "utf8"));
      if (await readFile(`/proc/${pid}/cgroup`, "utf8") !== await readFile("/proc/self/cgroup", "utf8"))
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome moved outside its resource scope");
    },
    get stderrTail() { return diagnostics; },
  } as OwnedBrowser & { stderrTail: string };
}

/**
 * macOS: a process group held by a supervisor, which is the third answer to the same question.
 *
 * Linux has a subreaper the kernel honours and Windows has a job object the kernel enforces. macOS
 * has neither, so containment here is a process group plus a supervisor plus a sweep, and every
 * layer of it is best effort. `assertContained` asks the kernel for the group's membership, which
 * is exact, and that is the part that is as strong as the other platforms: whether the browser is in
 * the group Orbit owns is a question with a real answer.
 *
 * What is weaker is the guarantee that nothing survives. A supervisor that is SIGKILLed runs no
 * sweep. The broker's start-up sweep is the second layer, and two best effort layers do not add up
 * to `KILL_ON_JOB_CLOSE`. `docs/support-tiers.md` states the row at that tier.
 */
function launchOnDarwin(executable: string, profile: string, argv: string[], env: Record<string, string>): OwnedBrowser {
  // The scheduling half of the macOS budget, and the only half the system enforces. The
  // darwin-background class is the nearest analogue of the Linux slice's `CPUWeight=10` and
  // `IOWeight=10`: on Apple silicon it places threads on the efficiency cluster, and it also sets
  // throttled low priority I/O.
  //
  // `RLIMIT_AS` is deliberately not used instead. It IS enforced on macOS 12 and later, contrary to
  // the folklore, but it bounds address space rather than footprint, and V8 reserves hundreds of
  // gigabytes of address space, so any value that would bound a browser's memory kills a healthy one.
  //
  // Applied ONCE. The class is inherited, so a broker already running under `scripts/limited.ts`
  // has it and every browser it starts gets it for free; spawning `taskpolicy -b` again on top was
  // a second process per session buying nothing. `alreadyBackground` is how this path knows, and
  // `ORBIT_DARWIN_BACKGROUND=0` is the override `experiments/macos-qos-cost.ts` uses to measure
  // what the class costs by running one arm without it.
  const requested = process.env.ORBIT_DARWIN_BACKGROUND !== "0";
  const alreadyBackground = process.env.ORBIT_DARWIN_BACKGROUND === "1" ? false : inheritedBackgroundClass();
  const background = requested && !alreadyBackground && Bun.file("/usr/sbin/taskpolicy").size > 0
    ? ["/usr/sbin/taskpolicy", "-b"] : [];
  const owner = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "native/supervise-darwin.ts"),
    join(profile, "owner.json"), ...background, executable, ...argv],
    { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  let diagnostics = "";
  void (async () => {
    try { for await (const chunk of owner.stderr) diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-4096); }
    catch {}
  })();
  return {
    exitCode: () => owner.exitCode,
    exited: owner.exited,
    diagnostics: () => {
      try { return String(JSON.parse(readFileSync(join(profile, "owner.json"), "utf8")).error?.message ?? ""); } catch { return ""; }
    },
    async stop() {
      // Closing the pipe is the stop signal the supervisor waits on, and it is what a broker that
      // dies produces for free. Using the same route for both means the ordinary path is the one
      // that has been exercised, rather than the crash path being the untested one.
      owner.stdin.end();
      const kill = setTimeout(() => owner.kill("SIGKILL"), 6000);
      try { await owner.exited; } finally { clearTimeout(kill); }
    },
    async assertContained() {
      const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as
        { pgid?: number; leaderStartedAtMs?: number | null; leaderExecutable?: string };
      if (!Number.isInteger(owner.pgid))
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome did not record a process group");
      const { processGroupMembers, groupIsStillOurs } = await import("./macos");
      // The group has to still BE our group, not merely have members. A pgid is reused, so a
      // containment check that only counts processes would report a healthy session while looking
      // at a group that belongs to somebody else. The supervisor recorded its own start time and
      // executable when it created the group, and both are checked here.
      if (typeof owner.leaderStartedAtMs === "number"
        && !groupIsStillOurs(owner.pgid!, { startedAtMs: owner.leaderStartedAtMs, executable: owner.leaderExecutable }))
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome's process group is no longer the one Orbit created");
      // Asked of the kernel every time rather than checked once at launch, for the same reason the
      // Windows path walks the job's process list: Chrome keeps starting helpers for the life of
      // the session, so a single check at launch can never see the process created afterwards.
      const members = processGroupMembers(owner.pgid!);
      if (!members.pids.length)
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome's process group is empty");
    },
    get stderrTail() { return diagnostics; },
  } as OwnedBrowser & { stderrTail: string };
}

/**
 * Windows: a per session job object, which replaces both the subreaper and the cgroup check.
 *
 * Measured on a Windows 11 guest: closing the last job handle left zero survivors of a 14 process
 * Chrome tree, three runs. The one gap is the window between `CreateProcess` returning and the
 * assign landing, measured at 76 ms, in which Chrome's own crash handler was outside the job once
 * and inside it the next time. `--disable-crashpad` removes the process that escaped, and
 * `assertContained` walks the job's real process list rather than trusting one check at launch.
 */
async function launchOnWindows(executable: string, profile: string, argv: string[], env: Record<string, string>): Promise<OwnedBrowser> {
  const { WindowsJob } = await import("./windows-job");
  const { cpuCores } = await import("./service");
  const budget = {
    memoryBytes: 2 * 1024 * 1024 * 1024,
    // Hundredths of a percent of the WHOLE machine, not of a core, which is what CpuRate means.
    cpuCycleSharePercent: Math.min(10000, Math.round((cpuCores / navigator.hardwareConcurrency) * 10000)),
    activeProcesses: 512,
  };
  const job = new WindowsJob(budget);
  const child = Bun.spawn([executable, ...argv], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let diagnostics = "";
  void (async () => {
    try { for await (const chunk of child.stderr) diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-4096); }
    catch {}
  })();
  try {
    job.assign(child.pid);
  } catch (error) {
    child.kill();
    job.close();
    throw error;
  }
  let stopped = false;
  return {
    exitCode: () => child.exitCode,
    exited: child.exited,
    // A dead browser on Windows says nothing on stderr when the KERNEL is what killed it, and a job
    // object kills for two reasons this budget can reach: the commit ceiling and the process ceiling.
    // The counters that record it are the only witness, so they are read into the diagnostic line
    // rather than left for someone to guess at. `terminatedProcesses` above zero is the kernel
    // saying it reaped the tree; a peak at the ceiling says which limit it was.
    diagnostics: () => {
      const lines = diagnostics.split("\n").map(line => line.trim()).filter(Boolean).slice(-3);
      let charged = "";
      try {
        const counts = job.accounting();
        if (counts.terminatedProcesses > 0 || counts.peakJobMemoryBytes > budget.memoryBytes * 0.9)
          charged = `the job object charged ${Math.round(counts.peakJobMemoryBytes / 1048576)} MB of its ${Math.round(budget.memoryBytes / 1048576)} MB ceiling, ${counts.activeProcesses} of ${budget.activeProcesses} processes live, ${counts.terminatedProcesses} terminated by the kernel`;
      } catch {}
      return [charged, ...lines].filter(Boolean).join("; ");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // Closing the job handle is the kill: the kernel terminates every process inside it, which is
      // stronger than signalling the one pid we happen to know about.
      job.close();
      await Promise.race([child.exited, Bun.sleep(4000)]);
    },
    async assertContained() {
      if (stopped) return;
      // Chrome keeps starting renderer, GPU and utility processes for the life of the session, so a
      // single check at launch can never see the process created afterwards. This asks the kernel
      // for the job's current membership instead.
      if (!job.processIds().includes(child.pid))
        throw new OrbitError("RESOURCE_BOUNDARY_LOST", "Owned Chrome is not inside its job object");
    },
  };
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
  const windows = process.platform === "win32";
  const darwin = process.platform === "darwin";
  if ((process.platform !== "linux" && !windows && !darwin) || !executable)
    throw new OrbitError("UNSUPPORTED", "Owned Chrome launcher requires Linux, Windows or macOS with Chrome, Chromium or Edge");
  if (options.executable && !(Bun.file(options.executable).size > 0)) throw new OrbitError("UNSUPPORTED", "The requested browser executable is not present");
  // A profile that already holds one of these is a profile that held a browser: a restore point is a
  // snapshot of a running browser, and a clone is a copy of the person's. The poll below waits for this
  // file to appear, so a stale one is read as this browser's endpoint and dialled at a port that is
  // either nothing or somebody else.
  await rm(join(profile, "DevToolsActivePort"), { force: true }).catch(() => {});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    !["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"].includes(key))) as Record<string, string>;
  const common = [`--user-data-dir=${profile}`, "--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking"];
  let owner: OwnedBrowser;
  if (windows) {
    // No --no-sandbox: the Chrome sandbox works on Windows and dropping it is a straight regression.
    // No --password-store: that switch is the Linux keyring selector and means nothing here, where a
    // private user data directory already puts App Bound Encryption out of the picture.
    // --disable-crashpad: the crash handler is the process measured escaping the assign window.
    //
    // Built by `windowsChromeArguments`, which is where the containment flags are documented and
    // tested. Building the list again here is what let the two drift apart.
    const { windowsChromeArguments } = await import("./windows-job");
    owner = await launchOnWindows(executable, profile,
      windowsChromeArguments(profile, options.extraArgs ?? [], { extensions: options.extensions }), env);
  } else if (darwin) {
    // Five macOS specific flags, and every one of them is about not touching the person's machine.
    //
    // --use-mock-keychain is the one that matters most, and the reason is in Chromium's own source
    // rather than in a guess. `components/os_crypt/keychain_password_mac.mm` looks the key up with
    // `FindGenericPassword(service: "Chrome Safe Storage", account: "Chrome")`, and NOTHING in that
    // call mentions the profile directory: a fresh `--user-data-dir` does not give a fresh item. On
    // any Mac where the person has ever run Chrome the item already exists, so a binary that is not
    // on its ACL raises the "wants to use your confidential information" dialog on their screen,
    // and `--headless` does not suppress it. `os_crypt_switches.h` documents this switch as
    // existing precisely to prevent "blocking dialogs". `--password-store=basic` is the second line
    // of defence behind it. The cost is that this profile's cookies are encrypted with a throwaway
    // key, which is correct for a session profile that is deleted when the session ends.
    //
    // --disable-crash-reporter stops the Crashpad handler, which is the one process that genuinely
    // escapes containment here. `third_party/crashpad/.../util/posix/spawn_subprocess.cc` calls
    // `setsid()` in the child, so the handler leaves the process group AND the session and is
    // reparented to launchd: `killpg` misses it, a descendant walk misses it, and it is designed to
    // outlive the browser it served. This is the same process the Windows port removes with
    // `--disable-crashpad`, found there by measuring 13 of 14 processes inside the job.
    //
    // --disable-features=MediaRouter stops Chrome's Cast discovery, which on macOS 15 and later
    // raises a Local Network alert attributed to Google Chrome on the person's screen. Orbit has
    // no use for Cast and the alert is the exact class of interruption this project refuses.
    //
    // --disk-cache-dir is forced inside the session profile because Chrome on macOS otherwise
    // derives its cache from ~/Library/Caches/Google/Chrome, which is the directory the person's
    // OWN browser is writing to. A session that shared it would be writing into their browser's
    // state, which is the promise this project is built on.
    //
    // No --no-sandbox: the Chrome sandbox works on macOS and dropping it would be a straight
    // security regression, the same reasoning the Windows branch already records.
    owner = launchOnDarwin(executable, profile, [...common, "--use-mock-keychain", "--password-store=basic",
      "--disable-crash-reporter", "--disable-features=MediaRouter", `--disk-cache-dir=${join(profile, "cache")}`,
      ...(options.extensions ? [] : ["--disable-extensions"]), ...(options.extraArgs ?? []), "about:blank"], env);
  } else {
    // Chrome can use the desktop bus to move itself into an uncapped systemd scope.
    // This owned headless browser must not connect to the human session bus.
    env.DBUS_SESSION_BUS_ADDRESS = options.sessionBus ?? `unix:path=${profile}/no-session-bus`;
    owner = launchOnLinux(executable, profile, [...common, "--disable-dev-shm-usage", "--no-sandbox",
      `--password-store=${options.passwordStore ?? "basic"}`,
      ...(options.extensions ? [] : ["--disable-extensions"]), ...(options.extraArgs ?? []), "about:blank"], env);
  }
  // The last of what Chrome said, kept for the failure message. Dropping it entirely was how a
  // refused fork spent a day reported as "did not publish its local endpoint": the cause was on
  // stderr and stderr went nowhere. Bounded, because a healthy Chrome logs D-Bus complaints forever.
  const explain = async (message: string) => {
    const stderrTail = (owner as OwnedBrowser & { stderrTail?: string }).stderrTail ?? "";
    const lines = stderrTail.split("\n").map(line => line.trim()).filter(line => line && !/dbus|D-Bus|CHROME_VERSION_EXTRA/.test(line)).slice(-3);
    const cause = [owner.diagnostics(), ...lines].filter(Boolean).join("; ");
    return cause ? `${message}: ${cause}` : message;
  };
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  // Whether the CALLER asked for this shutdown, which is not the same question as whether a shutdown
  // is under way. Every path that notices a dead browser also calls `close()`, so `closing` is set by
  // the death itself and cannot tell a stop apart from a crash.
  let requested = false;
  let socket: WebSocket | undefined;
  const listeners: (() => void)[] = [];
  const close = () => closing ??= (async () => {
    await owner.stop();
    socket?.close();
    await browser?.close().catch(() => {});
    closed = true;
    for (const listener of listeners) listener();
  })();
  try {
    const waitMs = endpointWaitMs();
    const deadline = Date.now() + waitMs;
    let endpoint: string | undefined;
    while (Date.now() < deadline && owner.exitCode() === null) {
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        const reachable = options.endpointPort ? String(options.endpointPort) : port;
        if (port && /^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) { endpoint = `ws://127.0.0.1:${reachable}${path}`; break; }
      } catch {}
      await Bun.sleep(25);
    }
    // `exitCode` is a function on this interface, not a field. Comparing the function to null is
    // always false and interpolating it prints its source, so every timeout on every platform read
    // "Owned Chrome exited with code () => child.exitCode", which is not a code and not even a
    // claim. Read once, then used.
    const code = owner.exitCode();
    if (!endpoint) throw new OrbitError("BACKEND_FAILED", await explain(code === null
      ? `Owned Chrome did not publish its local endpoint within ${waitMs / 1000} seconds and is still running`
      : `Owned Chrome exited with code ${code} before publishing its endpoint`));
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
    // Playwright's own failure here is "Target page, context or browser has been closed", which names
    // no cause: the browser is gone and the reason it went is on its stderr. Measured on the Windows
    // guest on 16 September 2026, twice in seventeen runs through the broker, and never once in
    // fourteen direct launches, so a message without the browser's own last words sends the next
    // person looking in the wrong layer. The handshake is attributed the same way the endpoint wait
    // above already is.
    try { browser = await chromium.connectOverCDP(transport, { timeout: 20000 }); }
    catch (error) {
      throw new OrbitError("BACKEND_FAILED", await explain(
        `Owned Chrome published its endpoint and then dropped the connection (exit code ${owner.exitCode() ?? "none, still running"}): ${(error as Error).message}`));
    }
    const context = browser.contexts()[0];
    if (!context) throw new OrbitError("BACKEND_FAILED", "Owned Chrome has no default context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize(size);
    await owner.assertContained();
    browser.on("disconnected", () => { void close(); });
    // A browser that dies mid session takes every action after it down with "Target page, context or
    // browser has been closed", which names neither the browser nor the reason. The one moment the
    // cause is still readable is here, before the tree is reaped, so it goes to the broker's own
    // journal the way an unexpected RPC error already does. Without this line the next failure is
    // attributed to whichever action happened to be in flight.
    void owner.exited.then(async () => {
      // `requested`, not `closing`. Playwright's `disconnected` fires from the same socket EOF that
      // the process death produces and calls `close()` first more often than not, so a `closing`
      // check silently suppressed this line in exactly the case it exists for. Only a caller's own
      // `close()` sets `requested`, and the diagnostic is read BEFORE the job handle is closed.
      if (!requested) {
        const cause = await explain("Owned Chrome exited");
        console.error(JSON.stringify({ ownedBrowser: "exited while its session was open", exitCode: owner.exitCode(), cause }));
      }
      await close();
    });
    return {
      context, browser, page,
      close: () => { requested = true; return close(); },
      onClose(listener: () => void) { if (closed) listener(); else listeners.push(listener); },
    };
  } catch (error) { await close(); throw error; }
}
