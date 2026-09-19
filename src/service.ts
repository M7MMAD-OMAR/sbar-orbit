import { totalmem, homedir } from "node:os";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
/**
 * A macOS path is a POSIX path, whatever host computed it.
 *
 * `node:path`'s `join` is bound to the HOST platform, so on Windows it produces backslashes. Every
 * function here takes an explicit `platform` argument precisely so the rule can be asked from any
 * host, and building a darwin answer with the host's separator makes that simulation answer about
 * the runner rather than about macOS. Measured: six darwin path tests failed on the Windows guest
 * for exactly this, against product code that is correct on a Mac.
 */
import { OrbitError } from "./errors";

/**
 * How much processor everything Orbit owns may use together, as a hard ceiling. A quarter of the
 * machine, never less than one logical CPU and never more than four: on a four core laptop that is
 * the one core it always was, on this 24 thread workstation it is four. The weight and niceness below
 * are what keep the desktop responsive under contention; the quota only says how far Orbit can go
 * when nothing else wants the processor.
 *
 * Measured 13 September 2026 at the old fixed 100%: with three browser sessions open for another
 * agent, the slice was throttled in 18,252 of 49,195 scheduling periods, 37%, with 10,476 seconds of
 * throttled time and `cpu.pressure full avg60` at 26.5%, and every further Chrome start timed out at
 * its 20 second handshake. One core was the whole ceiling for four agents' browsers on a 24 thread
 * machine that was otherwise 60% idle.
 */
export const cpuCores = Math.max(1, Math.min(4, Math.floor(navigator.hardwareConcurrency / 4)));
/**
 * Memory the same way: a quarter of the machine, never under 2 GiB and never over 8 GiB, with the
 * pressure threshold 256 MiB below the hard cap so reclaim starts before the kill does. Measured
 * 13 September 2026 at the old fixed 2 GiB on a 31 GiB host: the slice sat pinned at its 1792 MiB
 * threshold with 1,569,927 `memory.high` reclaim events and `memory.pressure full avg60` at 9.4%,
 * and a browser asked for a new page inside that throttling hung, or lost its renderer to
 * `Target crashed`. Reported in whole mebibytes, which is what systemd accepts.
 */
export const memoryMiB = Math.max(2048, Math.min(8192, Math.floor(totalmem() / 4 / 1048576)));
/** The shared budget the broker must run inside, matching what scripts/limited.ts applies at runtime. */
export const budget = { CPUQuota: `${cpuCores * 100}%`, MemoryHigh: `${memoryMiB - 256}M`, MemoryMax: `${memoryMiB}M`, MemorySwapMax: "0", TasksMax: "1536", CPUWeight: "10", IOWeight: "10" };

/**
 * Where the connector configuration this machine registers lives, per platform.
 *
 * `$XDG_CONFIG_HOME` on Linux, `%APPDATA%` on Windows. Every other per user Orbit path already
 * branches this way, `serviceSocketPath` and `workspaceRoot` among them, and this one did not: it
 * wrote a POSIX `.config` dotfile into the Windows profile, measured on the guest as
 * `%USERPROFILE%\.config\sbar-orbit\mcp.json`. A file naming the broker socket in Windows terms,
 * sitting at a path only POSIX uses, is a thing no Windows tool would think to look for.
 *
 * `%APPDATA%` rather than `%LOCALAPPDATA%`, deliberately: this is configuration a person may want to
 * follow them between machines, which is exactly the roaming/non roaming distinction Windows draws.
 * The socket and the workspaces stay local because they are machine state.
 */
export function connectorConfigDirectory(env = process.env, platform = process.platform) {
  // The declared `HOME` rather than this process's, for the reason spelled out on `stateDirectory`.
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "sbar-orbit");
  // macOS has no XDG layout, and `~/Library/Application Support` is the documented place a per user
  // application keeps its own configuration. `XDG_CONFIG_HOME` is still honoured when the person has
  // set one, because somebody who has deliberately configured an XDG layout on a Mac means it.
  if (platform === "darwin" && !env.XDG_CONFIG_HOME)
    return posix.join(home, "Library", "Application Support", "sbar-orbit");
  // Linux and darwin only: win32 returned above, and both of these are POSIX platforms, so the
  // separator is theirs rather than the host's. See the note above.
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "sbar-orbit");
}

/**
 * Darwin's `sun_path` is 104 bytes where Linux gives 108, and the failure mode is silent truncation
 * rather than an error: a socket path one byte too long binds SOMEWHERE ELSE, and the broker then
 * serves a path no client will ever dial. A long user name plus a long label reaches it.
 *
 * So the length is asserted rather than hoped for, with the limit and the actual length in the
 * message, because the remedy depends on which it is. 103 rather than 104: the terminating NUL is
 * inside the field.
 */
export const DARWIN_SOCKET_PATH_MAX = 103;

export function assertDarwinSocketPath(path: string) {
  const bytes = Buffer.byteLength(path);
  if (bytes > DARWIN_SOCKET_PATH_MAX)
    throw new OrbitError("CONFIG_REQUIRED",
      `The broker socket path is ${bytes} bytes and macOS allows ${DARWIN_SOCKET_PATH_MAX}. Set ORBIT_SOCKET to a shorter path; a path over the limit is truncated silently rather than refused.`);
  return path;
}

/**
 * Machine state that is not a socket and not a workspace: the diagnostics journal and the usage
 * switch. Same branch as `serviceSocketPath` and `workspaceRoot` for the same reason, and local
 * rather than roaming because none of it should follow a person to another machine. Without this,
 * both landed in `%USERPROFILE%\.config`-shaped POSIX dot directories on Windows, which is the
 * mistake `connectorConfigDirectory` was already fixed for: a file nothing on Windows looks in, and
 * in the usage case a person's opt-out left behind when they clear `%LOCALAPPDATA%`.
 */
export function stateDirectory(env = process.env, platform = process.platform) {
  // `HOME` from the env the CALLER stated, falling back to this process's own. `homedir()` reads the
  // real process every time, so a caller describing another machine, which is every platform test and
  // every dry run, got this host's home spliced into an otherwise hypothetical path. The same reason
  // `serviceSocketPath` resolves its runtime directory from the declared env rather than a default
  // parameter: the two disagree exactly when the answer matters.
  const home = env.HOME || env.USERPROFILE || homedir();
  // XDG is NOT honoured on Windows. It is a POSIX convention, and a Windows process that has
  // XDG_CACHE_HOME set got it from Git Bash, MSYS2 or an agent host rather than from a person
  // choosing a cache location, so honouring it moved live session profiles somewhere nothing checks.
  // The POSIX mode test that would have caught a world readable directory is disabled on Windows
  // precisely because Windows does not store a mode, and the ACL reasoning that replaces it is about
  // %LOCALAPPDATA% specifically: measured on the guest as SYSTEM, Administrators and the owning user,
  // where a drive root directory was measured handing down Authenticated Users: Modify. `updateRoot`
  // already ignores XDG on Windows for this reason; these three now agree with it.
  if (platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "sbar-orbit");
  // macOS keeps a per user application's own records under `~/Library/Application Support`, and the
  // diagnostics journal is exactly that: state the person may want to read and paste into an issue,
  // not a cache that can be regenerated and not configuration. The same branch as the socket, for
  // the same reason `connectorConfigDirectory` has one.
  if (platform === "darwin" && !env.XDG_STATE_HOME)
    return posix.join(home, "Library", "Application Support", "sbar-orbit");
  return posix.join(env.XDG_STATE_HOME ?? posix.join(home, ".local/state"), "sbar-orbit");
}

/**
 * A fixed socket path for a managed broker. Brokers started by tests and experiments keep their own
 * private directories, so only the managed one uses this path and they cannot collide.
 */
export function serviceSocketPath(runtimeDirectory?: string, env = process.env, platform = process.platform) {
  // The declared `HOME`, for the reason spelled out on `stateDirectory`.
  const home = env.HOME || env.USERPROFILE || homedir();
  // Resolved from the env the CALLER stated, rather than from a default parameter evaluated against
  // this machine. The two disagree exactly when a caller asks about another platform, which is every
  // test of this rule and the reason the macOS branch below was unreachable from any host that has a
  // runtime directory of its own. An explicit directory still wins over both, including one that
  // happens to equal this host's.
  // On Windows an XDG_RUNTIME_DIR from the environment is ignored for the reason given on
  // `stateDirectory`: it would relocate the CONTROL CHANNEL, whose only boundary is the ACL of the
  // directory it binds in. An explicitly passed directory still wins, since that is a caller stating
  // a path rather than a POSIX variable leaking in from a shell.
  const runtime = runtimeDirectory ?? (platform === "win32" ? undefined : env.XDG_RUNTIME_DIR);
  // macOS has no XDG_RUNTIME_DIR either, and the obvious substitute is wrong: the per user
  // `$TMPDIR` under /var/folders is periodically swept, so a socket there can be removed out from
  // under a live broker. `~/Library/Application Support` is not swept, is per user, and is not
  // synced to iCloud, which are the three properties the Linux runtime directory was chosen for
  // apart from being cleared at logout.
  //
  // Not being cleared at logout is the one real difference, and it is the same difference the
  // Windows path already records: a socket FILE can outlive the broker that bound it, so the stale
  // socket path in `claimSocket` is load bearing here rather than a corner case.
  //
  // The length is asserted, not assumed. Darwin's `sun_path` is 104 bytes and a longer path binds
  // somewhere else in silence rather than failing.
  if (!runtime && platform === "darwin")
    return assertDarwinSocketPath(posix.join(home, "Library", "Application Support", "sbar-orbit", "broker.sock"));
  // Windows has no XDG_RUNTIME_DIR and no tmpfs to put one in, and `Bun.serve({unix})` was measured
  // serving an AF_UNIX socket on an ordinary Windows filesystem path, so the fixed socket goes where
  // every other per user Orbit path already goes there. %LOCALAPPDATA% is the precedent
  // `workspaceRoot()` set: per user, non roaming, and inheriting an ACL of SYSTEM, Administrators
  // and the owning user with no Everyone and no Anonymous. See docs/windows-measured.md.
  //
  // It differs from the Linux path in one way worth stating: a runtime directory is cleared when the
  // person logs out and this is not, so a socket file can outlive the broker that bound it. That is
  // what `claimSocket` already handles, by probing the socket before replacing it.
  if (!runtime && platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "sbar-orbit", "broker.sock");
  if (!runtime) throw new OrbitError("CONFIG_REQUIRED", "XDG_RUNTIME_DIR is required for a managed broker socket");
  // `posix.join` and `win32.join` rather than the host-bound `join` on both of these. With `platform`
  // injectable, the Windows arm computed from Linux produced forward slashes and the Linux arm computed
  // from Windows produced `\run\user\1000`, each a path that is only ever used on the other platform.
  // The rule this port keeps relearning: the moment a function takes `platform`, every path it builds
  // for a platform that is not this one needs that platform's own join.
  return platform === "win32"
    ? win32.join(runtime, "sbar-orbit", "broker.sock")
    : posix.join(runtime, "sbar-orbit", "broker.sock");
}

/** Refuse to displace a broker that still answers; clear only a socket file nothing is serving. */
export async function claimSocket(socket: string, probe: (path: string) => Promise<boolean>) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await stat(socket); }
  catch (error) {
    // ENOENT is the ordinary "nothing to claim". On Windows a socket file that IS there answers
    // `stat` with EACCES while it is bound, and treating that as absent was measured to leave a
    // stale file in place and fail the bind with "Failed to listen on unix socket", which says
    // nothing about the cause. Anything that is not ENOENT means a path that exists and cannot be
    // inspected, so it is probed rather than assumed away.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claimed: true, replacedStaleSocket: false };
    if (await probe(socket)) throw new OrbitError("PROFILE_BUSY", `An Orbit broker is already serving ${socket}`);
    // Below here the path exists, could not be inspected, and nobody answers on it. The shape test
    // further down exists to refuse a path that is NOT a socket rather than delete it, and this
    // branch used to unlink whatever it found without asking anything at all.
    //
    // What to ask depends on why `stat` failed, and the two platforms fail differently. Measured on
    // the Windows guest: a LIVE AF_UNIX socket answers `stat` with EACCES and a read with EACCES,
    // and Bun removes the file when the server stops, so a stale one is ENOENT rather than EACCES.
    // EACCES on an existing path is therefore the socket's own shape there, and refusing it would
    // refuse the live-file case this function has to handle. On Linux a socket answers `stat`
    // perfectly well and never reaches this branch at all, so an unreadable path here is somebody
    // else's file and deleting it is the thing to refuse.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EACCES") {
      const readable = await Bun.file(socket).arrayBuffer().catch(() => null);
      if (readable === null || readable.byteLength > 0)
        throw new OrbitError("CONFIG_REQUIRED", `${socket} exists and could not be shown to be a socket; remove it deliberately`);
    }
    await unlink(socket).catch(() => {});
    return { claimed: true, replacedStaleSocket: true };
  }
  // `isSocket()` is false for a Windows AF_UNIX socket file, which reports as a regular file, so the
  // shape test cannot be the same on both. What a socket is NOT, on either platform, is a file with
  // contents: Bun's socket file is empty, and a config or a note someone left at this path is not.
  // Dropping the test entirely on Windows would have let `claimSocket` delete a person's file, which
  // is the thing this function exists to refuse.
  const plausibleSocket = process.platform === "win32" ? existing.size === 0 : existing.isSocket();
  if (!plausibleSocket)
    throw new OrbitError("CONFIG_REQUIRED", `${socket} exists and is not a socket; remove it deliberately`);
  if (await probe(socket)) throw new OrbitError("PROFILE_BUSY", `An Orbit broker is already serving ${socket}`);
  await unlink(socket);
  return { claimed: true, replacedStaleSocket: true };
}

/** The budget sits on the slice, because the broker looks for sbarorbit.slice in its own cgroup path. */
export function sliceUnit() {
  return ["[Unit]", "Description=Sbar Orbit shared resource budget", "", "[Slice]",
    ...Object.entries(budget).map(([key, value]) => `${key}=${value}`), ""].join("\n");
}

export function serviceUnit(launcher: string) {
  return ["[Unit]", "Description=Sbar Orbit local broker", "", "[Service]", "Type=simple",
    `ExecStart=${launcher} serve --managed-socket`, "Slice=sbarorbit.slice",
    // Operator switches such as ORBIT_NATIVE_RENDERER live in a file the installer never rewrites.
    "EnvironmentFile=-%h/.config/sbar-orbit/broker.env",
    "Restart=on-failure", "RestartSec=2", "Nice=10",
    // The broker owns browsers and private displays, so give it time to close them.
    "TimeoutStopSec=30", "KillMode=mixed", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

/**
 * The automatic update pair, written by every install and enabled by none of it. `update on` is the only
 * thing that starts the timer, and `update off` is the kill switch, which has to work with no network
 * and no broker because that is the case it exists for.
 *
 * Daily with a randomized delay, so a release does not reach every machine in the same minute, and
 * `Persistent=true` so a machine that was asleep at the hour still checks once when it wakes.
 */
export function updateTimerUnit() {
  return ["[Unit]", "Description=Sbar Orbit update check", "", "[Timer]",
    "OnCalendar=daily", "RandomizedDelaySec=4h", "Persistent=true", "", "[Install]", "WantedBy=timers.target", ""].join("\n");
}

export function updateServiceUnit(launcher: string) {
  return ["[Unit]", "Description=Sbar Orbit update check", "", "[Service]", "Type=oneshot",
    // Preparing a version downloads and unpacks, which is work like any other and belongs in the budget.
    `ExecStart=${launcher} update run`, "Slice=sbarorbit.slice", "Nice=15", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

const units = { "sbarorbit.slice": sliceUnit, "sbar-orbit.service": serviceUnit,
  "sbar-orbit-update.service": updateServiceUnit, "sbar-orbit-update.timer": updateTimerUnit } as const;

/** Write the units atomically. Enabling is a separate function, and `service install` calls it by default. */
export async function installService(launcher: string, unitDirectory: string) {
  const source = resolve(launcher);
  try { if (!(await stat(source)).isFile()) throw new Error("Launcher is not a regular file"); }
  catch { throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file"); }
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const [name, build] of Object.entries(units)) {
    const target = join(unitDirectory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, build(source), { mode: 0o644 });
    await rename(temporary, target);
    written.push(target);
  }
  return { written, launcher: source, enabled: false, started: false };
}

/** Remove only units this project wrote, identified by their own description line. */
export async function uninstallService(unitDirectory: string) {
  const removed: string[] = [];
  // The panel unit belongs to the autostart pair rather than to the broker, and it is removed here for
  // the same reason: a unit left behind after an uninstall starts something that is no longer installed.
  for (const name of [...Object.keys(units), "sbar-orbit-panel.service"]) {
    const target = join(unitDirectory, name);
    let contents;
    try { contents = await readFile(target, "utf8"); } catch { continue; }
    if (!contents.includes("Description=Sbar Orbit")) throw new OrbitError("CONFIG_REQUIRED", `${target} was not written by Orbit; remove it deliberately`);
    await rm(target);
    removed.push(target);
  }
  return { removed, sourceAndDataRetained: true };
}

/**
 * Whether the units on disk are the ones this version of Orbit writes.
 *
 * An install rewrites every unit, so drift is never permanent; the problem is that nothing SAYS the
 * installed unit is older than the code, and a unit is exactly the kind of file nobody re-reads.
 * Found on the development host: the installed `sbar-orbit.service` predated
 * `EnvironmentFile=-%h/.config/sbar-orbit/broker.env`, so `ORBIT_NATIVE_RENDERER`,
 * `ORBIT_CAPTURE_TIMEOUT_MS` and every other documented operator switch reached the managed broker on
 * a fresh install and silently did not on that machine. The documentation was correct and the machine
 * disagreed with it, which is the failure this project calls a stale claim.
 *
 * Comparison is on CONTENT rather than on a version string, because a version string is a second
 * thing to keep in sync and would have been equally stale here. `launcher` is what the installed unit
 * already names, so a unit that points at a different checkout is reported as drifted rather than
 * being compared against the wrong expectation.
 */
export async function serviceUnitDrift(unitDirectory: string, launcher?: string) {
  const drifted: { unit: string; reason: string }[] = [];
  const missing: string[] = [];
  for (const [name, build] of Object.entries(units)) {
    const target = join(unitDirectory, name);
    let installed: string;
    try { installed = await readFile(target, "utf8"); }
    catch { missing.push(name); continue; }
    // The launcher path is per machine, so it is read back from the unit rather than assumed, unless
    // a caller names one. Without this every unit on every machine would read as drifted.
    //
    // Two of the four units carry no ExecStart at all and do not need one: the slice is a budget and
    // the timer is a schedule, and their builders take no launcher. Treating a missing ExecStart as
    // "cannot compare" reported a FRESH INSTALL as drifted in two of four units, which is the shape
    // of false alarm that gets a check ignored. So the builder's own arity decides: a builder that
    // takes no argument is compared directly.
    const needsLauncher = build.length > 0;
    const named = needsLauncher ? launcher ?? /^ExecStart=(\S+)/m.exec(installed)?.[1] : "";
    if (named === undefined) { drifted.push({ unit: name, reason: "the installed unit has no ExecStart to compare against" }); continue; }
    if (installed !== build(named)) {
      // Name the missing directives rather than printing two files, because that is what a person
      // needs to decide whether it matters before reinstalling.
      const expected = build(named).split("\n").filter(line => line.includes("="));
      const absent = expected.filter(line => !installed.includes(line));
      drifted.push({ unit: name, reason: absent.length
        ? `does not carry ${absent.join(", ")}`
        : "differs from what this version writes" });
    }
  }
  return { drifted, missing, current: drifted.length === 0 && missing.length === 0,
    remedy: drifted.length || missing.length ? "Run ./install.sh again to rewrite the units, then `systemctl --user daemon-reload`." : undefined };
}
