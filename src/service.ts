import { totalmem, homedir } from "node:os";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  if (platform === "win32")
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "sbar-orbit");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sbar-orbit");
}

/**
 * A fixed socket path for a managed broker. Brokers started by tests and experiments keep their own
 * private directories, so only the managed one uses this path and they cannot collide.
 */
export function serviceSocketPath(runtimeDirectory = process.env.XDG_RUNTIME_DIR, env = process.env, platform = process.platform) {
  // Windows has no XDG_RUNTIME_DIR and no tmpfs to put one in, and `Bun.serve({unix})` was measured
  // serving an AF_UNIX socket on an ordinary Windows filesystem path, so the fixed socket goes where
  // every other per user Orbit path already goes there. %LOCALAPPDATA% is the precedent
  // `workspaceRoot()` set: per user, non roaming, and inheriting an ACL of SYSTEM, Administrators
  // and the owning user with no Everyone and no Anonymous. See docs/windows-measured.md.
  //
  // It differs from the Linux path in one way worth stating: a runtime directory is cleared when the
  // person logs out and this is not, so a socket file can outlive the broker that bound it. That is
  // what `claimSocket` already handles, by probing the socket before replacing it.
  if (!runtimeDirectory && platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit", "broker.sock");
  if (!runtimeDirectory) throw new OrbitError("CONFIG_REQUIRED", "XDG_RUNTIME_DIR is required for a managed broker socket");
  return join(runtimeDirectory, "sbar-orbit", "broker.sock");
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
