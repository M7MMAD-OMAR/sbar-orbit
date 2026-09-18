/**
 * The macOS primitives, through bun:ffi and libSystem.
 *
 * Linux gives Orbit a cgroup: the kernel enforces the budget and reports live counters, and killing
 * the cgroup kills the tree. Windows gives a job object: the kernel enforces a committed memory
 * ceiling and kills the tree when the last handle closes. macOS gives neither, and the honest port
 * says so rather than printing a number shaped like `memory.max`.
 *
 * What macOS does give, and what this file is built on:
 *
 *   - `proc_listpids(PROC_PGRP_ONLY, pgid, ...)` enumerates every process in a process group, from
 *     the kernel, in one call. That is the membership list the Windows port gets from
 *     `QueryInformationJobObject` and the Linux port gets from the cgroup, and it is exact.
 *   - `proc_pid_rusage(pid, RUSAGE_INFO_V4, ...)` reports a process's physical footprint and its
 *     user and system CPU time, with no helper binary and no elevation. Measured reachable from Bun
 *     on a macOS 26.6.2 runner on 14 September 2026.
 *   - `killpg(2)` addresses a whole group with one signal.
 *
 * What it does not give, stated once here so every caller can repeat it: there is no kernel ceiling.
 * A process group is an accounting boundary Orbit reads and a scheduling hint Orbit sets, and a
 * browser that allocates past the budget is refused its NEXT session rather than stopped mid page.
 * `requireResourceBudget()` reports `enforcement: "advisory"` on this platform for that reason, and
 * nothing in this file should ever be described in a way that implies otherwise.
 *
 * Nothing here reads a command line, an environment, a cookie or a page. `proc_pidpath` is the one
 * call that returns a path, and it is used to tell Orbit's own browser from the person's, which is
 * the question this whole project exists to answer correctly.
 */

import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { OrbitError } from "./errors";

const { i32, u32, u64, ptr: pointer } = FFIType;

/** Only ever opened on darwin. Every caller goes through `requireDarwin` first. */
function libSystem() {
  requireDarwin();
  // `libSystem.B.dylib` by name rather than by path: the dyld shared cache has no file at
  // /usr/lib/libSystem.B.dylib on macOS 11 and later, so a path open fails on every supported
  // version while the name resolves through the cache. Measured working on the macOS runner.
  return dlopen("libSystem.B.dylib", {
    proc_pid_rusage: { args: [i32, i32, pointer], returns: i32 },
    proc_listpids: { args: [u32, u32, pointer, i32], returns: i32 },
    proc_listchildpids: { args: [i32, pointer, i32], returns: i32 },
    proc_pidpath: { args: [i32, pointer, u32], returns: i32 },
    proc_pidinfo: { args: [i32, i32, u64, pointer, i32], returns: i32 },
    getpgid: { args: [i32], returns: i32 },
    setpgid: { args: [i32, i32], returns: i32 },
    setsid: { args: [], returns: i32 },
    killpg: { args: [i32, i32], returns: i32 },
  }).symbols;
}

let opened: ReturnType<typeof libSystem> | undefined;
function system() {
  return opened ??= libSystem();
}

export function requireDarwin() {
  if (process.platform !== "darwin")
    throw new OrbitError("UNSUPPORTED", "The macOS process layer is darwin only");
}

/** libproc.h. Only the selectors this design uses, so an unused constant cannot drift out of date. */
const PROC_PGRP_ONLY = 2;
/** `proc_listpids` by parent pid, which is the documented way to ask the children question. */
const PROC_PPID_ONLY = 6;
const RUSAGE_INFO_V4 = 4;
/** `PROC_PIDPATHINFO_MAXSIZE`, 4 * MAXPATHLEN. */
const PATH_MAX_BYTES = 4096;

/**
 * Offsets into `struct rusage_info_v4`, in bytes, from `sys/resource.h`.
 *
 * Read as a table rather than hardcoded at each call site, because the two fields Orbit governs on
 * sit 8 bytes apart and swapping them silently reports a browser's resident size as its footprint.
 * The first three were confirmed against `ps -o rss=` on the macOS runner: footprint 88.9 MiB,
 * resident 115.1 MiB, `ps` 115.4 MiB, which is the expected ordering and the reason Orbit governs on
 * the footprint. It is the smaller and the more honest of the two.
 */
const RUSAGE = {
  userTimeNs: 16,
  systemTimeNs: 24,
  residentBytes: 64,
  /** What Activity Monitor calls Memory, and what Jetsam decides on. */
  physFootprintBytes: 72,
} as const;

export type ProcessUsage = {
  pid: number;
  /** Physical footprint in bytes: compressed and wired memory this process is charged for. */
  footprintBytes: number;
  residentBytes: number;
  /** User plus system CPU, in nanoseconds since this process was executed. */
  cpuNs: number;
};

/**
 * One process's usage, or null when it is gone.
 *
 * A dead process is not an error here. Sampling a browser tree races every renderer Chrome starts
 * and stops, and treating a pid that vanished between the enumeration and the read as a failure
 * would make the sampler fail under exactly the load it exists to measure.
 */
export function processUsage(pid: number): ProcessUsage | null {
  const buffer = new Uint8Array(512);
  if (system().proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buffer)) !== 0) return null;
  const at = (offset: number) => Number(read.u64(ptr(buffer), offset));
  return {
    pid,
    footprintBytes: at(RUSAGE.physFootprintBytes),
    residentBytes: at(RUSAGE.residentBytes),
    cpuNs: at(RUSAGE.userTimeNs) + at(RUSAGE.systemTimeNs),
  };
}

/**
 * Every process in a process group, asked of the kernel.
 *
 * This is the whole reason a macOS session is a process group rather than a bag of pids the broker
 * remembers: Chrome starts renderer, GPU and utility processes for the life of a session, so a list
 * captured at launch is wrong within a second. The group is what they all inherit, and this call
 * reads its current membership.
 *
 * `proc_listpids` returns the number of BYTES written, not the number of pids, and a buffer that is
 * exactly full is indistinguishable from one that overflowed. So it is sized generously and grown
 * once if it comes back full, and a group that still does not fit is reported as what was seen with
 * `complete: false` rather than as a short list that looks complete.
 */
export function processGroupMembers(pgid: number): { pids: number[]; complete: boolean } {
  if (!Number.isInteger(pgid) || pgid <= 1) return { pids: [], complete: true };
  for (const capacity of [1024, 8192]) {
    const buffer = new Int32Array(capacity);
    const bytes = system().proc_listpids(PROC_PGRP_ONLY, pgid, ptr(buffer), buffer.byteLength);
    if (bytes < 0) return { pids: [], complete: true };
    const count = Math.floor(bytes / 4);
    // A full buffer means the answer may have been truncated, so try the larger one.
    if (count === capacity && capacity !== 8192) continue;
    // The kernel leaves zeroes in the tail of the region it wrote.
    const pids = [...buffer.subarray(0, count)].filter(pid => pid > 0);
    return { pids, complete: count < capacity };
  }
  return { pids: [], complete: false };
}

/**
 * The direct children of a process.
 *
 * Asked two ways, because one of them returned nothing on a real Mac. `tests/browser-crash.test.ts`
 * found a broker with a demonstrably live browser tree under it and enumerated **0** descendants
 * through `proc_listchildpids` alone, while `experiments/macos-reaping.ts` measured the same tree at
 * nine processes through the process group. A walk that answers zero for a live tree cannot fail for
 * the right reason, which on that particular test means it cannot detect a browser that outlived its
 * broker: the thing the whole project promises.
 *
 * So `proc_listpids(PROC_PPID_ONLY)` is asked as well and the two are unioned. It is the documented
 * selector for exactly this question, and taking the union rather than picking a winner is
 * deliberate: for a containment check, a process either call reports is a process that has to be
 * accounted for, and missing one is the expensive direction of being wrong.
 */
export function childProcesses(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const found = new Set<number>();
  const direct = new Int32Array(1024);
  const bytes = system().proc_listchildpids(pid, ptr(direct), direct.byteLength);
  if (bytes > 0) for (const child of direct.subarray(0, Math.floor(bytes / 4))) if (child > 0) found.add(child);
  const byParent = new Int32Array(1024);
  const parentBytes = system().proc_listpids(PROC_PPID_ONLY, pid, ptr(byParent), byParent.byteLength);
  if (parentBytes > 0) for (const child of byParent.subarray(0, Math.floor(parentBytes / 4))) if (child > 0) found.add(child);
  // Never itself: `PROC_PPID_ONLY` answers about a parent, and a process that appeared in its own
  // child list would make a recursive walk loop forever.
  found.delete(pid);
  return [...found];
}

/**
 * The executable path of a process, or null when it is gone or unreadable.
 *
 * The one call in this file that returns anything about a process other than a number, and it exists
 * for one question: is this Orbit's browser or the person's. `tests/person-browser.test.ts` answers
 * it by executable path and profile directory, and on macOS the profile is not in the command line
 * Orbit is willing to read, so the path is what is left.
 */
export function processPath(pid: number): string | null {
  const buffer = new Uint8Array(PATH_MAX_BYTES);
  const length = system().proc_pidpath(pid, ptr(buffer), buffer.byteLength);
  if (length <= 0) return null;
  return new TextDecoder().decode(buffer.subarray(0, length));
}

export function processGroupOf(pid: number): number | null {
  const pgid = system().getpgid(pid);
  return pgid < 0 ? null : pgid;
}

/**
 * Make this process the leader of a new process group.
 *
 * Called by the supervisor, never by the broker: a broker that moved itself into a new group would
 * leave the group launchd knows about, which is the group `launchctl bootout` sweeps.
 */
export function becomeGroupLeader() {
  if (system().setpgid(0, 0) !== 0)
    throw new OrbitError("BACKEND_FAILED", "Could not start a process group for this session");
  return process.pid;
}

/**
 * A new SESSION, which is a new process group and a detachment from the controlling terminal.
 *
 * Stronger than `becomeGroupLeader` and used for the same reason the Linux supervisor starts its
 * child with `start_new_session=True`: without it, a Ctrl-C or a hangup in the person's terminal
 * propagates into the browser tree, and the browser can reach for the terminal. A session leader
 * cannot be dragged around by a shell it does not belong to.
 *
 * Returns the new session id, which equals this pid, or throws. `setsid` fails with EPERM when the
 * caller is ALREADY a process group leader, so it is called before anything else moves this process
 * into a group of its own.
 */
export function becomeSessionLeader() {
  const sid = system().setsid();
  if (sid < 0) throw new OrbitError("BACKEND_FAILED", "Could not start a session for this browser");
  return sid;
}

/** Signal numbers, written down rather than spelled at each call site. */
export const SIGNAL = { TERM: 15, KILL: 9, CONT: 19 } as const;

/**
 * Signal a whole process group.
 *
 * Returns false when the group is already gone, which is a success for every caller here and not
 * worth an exception: the point of sending it was that nothing should be left.
 */
export function signalProcessGroup(pgid: number, signal: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  return system().killpg(pgid, signal) === 0;
}

/**
 * When a process started, in milliseconds since the epoch, or null when it is gone.
 *
 * This is the field that makes a process group identity rather than a number. A pgid is reused: the
 * kernel hands the same value out again once the old group is gone, and `killpg` on a recycled one
 * reaches whatever now holds it, which on this platform could be the person's own browser or their
 * shell. That is the worst thing this code could do, so a group is never signalled on its number
 * alone. The leader's start time, recorded when Orbit created the group and checked before every
 * sweep, is what says the group is still the same group.
 *
 * `PROC_PIDTBSDINFO` returns `struct proc_bsdinfo`, whose `pbi_start_tvsec` and `pbi_start_tvusec`
 * sit at the end of the structure. The offsets are read from XNU's `sys/proc_info.h`, and the size
 * check below is what catches a structure that is not the one those offsets describe: a short read
 * is reported as unknown rather than decoded into a plausible wrong number.
 */
const PROC_PIDTBSDINFO = 3;
/** `sizeof(struct proc_bsdinfo)`, from sys/proc_info.h. */
const PROC_BSDINFO_SIZE = 136;
/** Offsets of `pbi_start_tvsec` and `pbi_start_tvusec` within that structure. */
const BSDINFO_START_SEC = 120;
const BSDINFO_START_USEC = 128;

export function processStartedAtMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE);
  const written = system().proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(buffer), buffer.byteLength);
  // A partial answer is not an answer. Decoding a short buffer would read whatever happened to be
  // in the tail as a timestamp, and this value gates a kill.
  if (written !== PROC_BSDINFO_SIZE) return null;
  const seconds = Number(read.u64(ptr(buffer), BSDINFO_START_SEC));
  const microseconds = Number(read.u64(ptr(buffer), BSDINFO_START_USEC));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000 + Math.floor(microseconds / 1000);
}

/**
 * Is this still the process group Orbit created, or a different one wearing a reused number?
 *
 * The same question `ownsGroup()` answers on Linux by reading the leader's environment out of
 * `/proc`, asked the way macOS can answer it. Two independent facts have to agree:
 *
 *   1. The leader still exists and started when Orbit recorded that it started. A recycled pgid
 *      belongs to a process that started later, so the timestamps differ.
 *   2. The leader's executable is the one Orbit launched. This is the guard that holds even if the
 *      clock is strange or a timestamp is unreadable.
 *
 * A tolerance of one second is allowed on the timestamp because the recorded value and the kernel's
 * are read through different paths, not because the comparison is approximate: two processes that
 * are genuinely different are separated by the lifetime of the first, never by a millisecond.
 */
export function groupIsStillOurs(pgid: number, expected: { startedAtMs: number; executable?: string }): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const startedAt = processStartedAtMs(pgid);
  if (startedAt === null) return false;
  if (Math.abs(startedAt - expected.startedAtMs) > 1000) return false;
  if (expected.executable) {
    const path = processPath(pgid);
    if (path !== expected.executable) return false;
  }
  return true;
}

/**
 * Signal a whole process group, but only after confirming it is still the group Orbit created.
 *
 * Every sweep goes through this rather than through `signalProcessGroup`. The unchecked version
 * exists for the supervisor signalling its OWN group, where the caller is inside the group it is
 * addressing and reuse is impossible by construction; anything signalling a group it merely
 * remembers the number of has to prove the group first.
 */
export function signalOwnedProcessGroup(pgid: number, signal: number, expected: { startedAtMs: number; executable?: string }): boolean {
  if (!groupIsStillOurs(pgid, expected)) return false;
  return signalProcessGroup(pgid, signal);
}

/**
 * What a process group is charged with: its own membership, its summed footprint and its summed CPU.
 *
 * Summed rather than sampled from one process, because a Chrome session is a dozen processes and the
 * browser process is not the expensive one. Measured on the macOS runner: a headless Chrome's
 * renderer used more CPU than its browser process in every sample.
 */
export function processGroupUsage(pgid: number) {
  const { pids, complete } = processGroupMembers(pgid);
  let footprintBytes = 0, cpuNs = 0, counted = 0;
  for (const pid of pids) {
    const usage = processUsage(pid);
    if (!usage) continue;
    footprintBytes += usage.footprintBytes;
    cpuNs += usage.cpuNs;
    counted++;
  }
  // `processes` is what the kernel listed and `counted` is what could still be read, and they differ
  // whenever a renderer exits mid sample. Both are reported rather than one standing in for the
  // other, because a caller deciding whether a tree is contained needs the kernel's list and a
  // caller deciding whether there is headroom needs the figure that was actually summed.
  return { pgid, processes: pids.length, counted, footprintBytes, cpuNs, complete };
}
