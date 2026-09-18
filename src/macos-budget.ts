/**
 * The shared Orbit budget on macOS, and the exact sense in which it is one.
 *
 * On Linux every Orbit process on the machine lands in one cgroup slice and the kernel enforces a
 * single CPU, memory, swap and task ceiling over all of them together. On Windows a NAMED job object
 * carries the same shape: a second process holding only the name joins the same pool. Both are
 * kernel enforced, and `budgetHeadroom()` reads live counters out of the kernel.
 *
 * macOS has no equivalent, and this file does not pretend otherwise.
 *
 * What it builds instead is a registry: every Orbit entry point puts itself in a process group of
 * its own and writes that group into a shared directory, and the pool is the sum over every
 * registered group that still has members. The membership of each group comes from the kernel
 * through `proc_listpids(PROC_PGRP_ONLY)`, and the footprint and CPU of each process come from the
 * kernel through `proc_pid_rusage`, so the NUMBERS are real. The CEILING is not: nothing stops a
 * process that is over it. What the ceiling does is refuse the next session, which is
 * `requireHeadroom()` doing its job before a fork rather than after an out of memory kill.
 *
 * Three things this cannot do, said here so every caller can repeat them rather than discover them:
 *
 *   - It cannot stop a browser that allocates past the ceiling. `enforcement` is `"advisory"` and
 *     `unbounded` names every dimension, because on macOS all of them are.
 *   - It cannot see an Orbit process that never registered. A registry is a convention among
 *     cooperating processes, and every Orbit entry point goes through `scripts/limited.ts`, but a
 *     person who runs a browser by hand is outside it.
 *   - It cannot survive a pid namespace it does not have. A process group id is reused eventually,
 *     so a stale registration is reaped by asking the kernel whether the group has members, not by
 *     trusting the file.
 *
 * The scheduling half of the budget is real and is not in this file: `taskpolicy -b` places the
 * session in the darwin-background class, which on Apple silicon is what puts its threads on the
 * efficiency cluster. That is the nearest analogue of `CPUWeight=10` and it is a hint, not a cap.
 */

import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { processGroupMembers, processGroupOf, processGroupUsage, processStartedAtMs, requireDarwin } from "./macos";
import { OrbitError } from "./errors";

/**
 * Where the registry lives.
 *
 * `~/Library/Application Support`, not the per user temporary directory: `$TMPDIR` under
 * `/var/folders` is periodically swept, and a registry that loses an entry under-reports the pool,
 * which is the direction that hands out a session the machine cannot afford. Application Support is
 * not swept and is not synced to iCloud.
 *
 * It is NOT cleared at logout, which the Linux runtime directory is. That is why every read reaps
 * stale entries by asking the kernel rather than trusting what is on disk.
 */
export function budgetRegistryRoot(env = process.env, home = homedir()) {
  return env.ORBIT_BUDGET_ROOT || join(home, "Library", "Application Support", "sbar-orbit", "budget");
}

/**
 * The registry directory, created private and verified private before anything is read from it.
 *
 * `ORBIT_BUDGET_ROOT` exists so tests can point the registry somewhere disposable, and it was taken
 * verbatim: not checked for absoluteness, not `lstat`ed, no owner or mode check. That is weaker than
 * `createWorkspaceDirectory` already is about a directory holding far less consequence, and it made
 * the budget gate forgeable by anything that could set the variable or pre-create the path, since
 * `requireResourceBudget()` passes for any process whose group appears here.
 *
 * Four checks, the same set the workspace path applies: absolute, a real directory, not a symlink,
 * owned by this user with no group or other permissions. A symlink is refused rather than followed,
 * because following one is how a registry write lands in a directory somebody else chose.
 */
export async function assertPrivateRegistryRoot(root: string) {
  if (!isAbsolute(root))
    throw new OrbitError("INVALID_REQUEST", "The budget registry needs an absolute path");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const foreign = info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0;
  if (!info.isDirectory() || info.isSymbolicLink() || foreign)
    throw new OrbitError("INVALID_REQUEST", "The budget registry must be a private directory owned by this user");
  return root;
}

export type Registration = { pgid: number; label: string; startedAt: string; leaderStartedAtMs?: number | null };

/**
 * Put this process's group in the pool.
 *
 * The caller has already made itself a group leader, so the registration names a group that exists
 * and that this process is in. Registering a group this process is NOT in would let a caller charge
 * the pool for work it does not own, which is refused here rather than trusted.
 */
export async function registerBudgetGroup(label: string, root = budgetRegistryRoot()) {
  requireDarwin();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(label))
    throw new OrbitError("INVALID_REQUEST", "A budget registration needs a simple label");
  const pgid = processGroupOf(process.pid);
  if (pgid === null || pgid !== process.pid)
    throw new OrbitError("RESOURCE_LIMIT_REQUIRED", "A budget registration has to come from a process group leader");
  await assertPrivateRegistryRoot(root);
  // The leader's start time, recorded at the one moment it is known to be true. A pgid is reused, so
  // without it a stale entry whose number has been handed out again would charge the pool for a
  // process that is not Orbit's, and `liveBudgetGroups` would keep the entry alive forever because
  // the group it names has members.
  //
  // Refused rather than written as null when the kernel will not say. A registration with no start
  // time cannot be checked against pgid reuse later, and `groupIsStillOurs` treats an absent time as
  // nothing to verify, so writing one would create exactly the unverifiable entry the field exists
  // to prevent. Failing here is loud and immediate; the alternative fails silently much later.
  const leaderStartedAtMs = processStartedAtMs(pgid);
  if (leaderStartedAtMs === null)
    throw new OrbitError("BACKEND_FAILED", "Could not read this process group's start time, so its registration could not be verified against process group reuse");
  const entry: Registration = { pgid, label, startedAt: new Date().toISOString(), leaderStartedAtMs };
  await writeFile(join(root, `${pgid}.json`), JSON.stringify(entry), { mode: 0o600 });
  return entry;
}

export async function unregisterBudgetGroup(pgid: number, root = budgetRegistryRoot()) {
  await rm(join(root, `${pgid}.json`), { force: true }).catch(() => {});
}

/**
 * Every registration that still names a live group, and removal of the ones that do not.
 *
 * A group with no members is gone, whatever its file says, and leaving the file would both
 * over-report the pool and eventually collide with a reused group id. The reaping is done here, on
 * the read path, because there is no supervisor on this platform that could be trusted to do it on
 * the way out: a process killed with SIGKILL runs no cleanup, which is exactly the case that leaves
 * a file behind.
 */
export async function liveBudgetGroups(root = budgetRegistryRoot()) {
  const live: Registration[] = [];
  let names: string[];
  try { names = await readdir(root); } catch { return live; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry: Registration;
    try { entry = JSON.parse(await readFile(join(root, name), "utf8")); } catch { continue; }
    if (!Number.isInteger(entry?.pgid) || entry.pgid <= 1) continue;
    const members = processGroupMembers(entry.pgid);
    // A read that FAILED is not an empty group, and conflating them here reaped live registrations:
    // the entry would be deleted while its processes were still charging the machine, so the pool
    // under-reported itself and handed out a session it could not afford. Kept on failure, which is
    // the conservative direction: an entry kept one sweep too long only refuses work.
    if (members.failed) { live.push(entry); continue; }
    // Gone, whatever the file says.
    if (!members.pids.length) { await rm(join(root, name), { force: true }).catch(() => {}); continue; }
    // Present, but is it still OUR group? A pgid is reused, and an entry whose number now belongs to
    // somebody else would charge the pool for their processes and never be reaped, because the group
    // it names does have members. Entries written before this field existed carry no start time and
    // are trusted on membership alone, which is the old behaviour rather than a new refusal.
    if (typeof entry.leaderStartedAtMs === "number") {
      const startedAt = processStartedAtMs(entry.pgid);
      if (startedAt === null || Math.abs(startedAt - entry.leaderStartedAtMs) > 1000) {
        await rm(join(root, name), { force: true }).catch(() => {});
        continue;
      }
    }
    live.push(entry);
  }
  return live;
}

/** What the pool is charged with right now, summed from the kernel over every live group. */
export async function sharedBudgetUsage(root = budgetRegistryRoot()) {
  const groups = await liveBudgetGroups(root);
  let processes = 0, footprintBytes = 0;
  const complete: boolean[] = [];
  for (const group of groups) {
    const usage = processGroupUsage(group.pgid);
    processes += usage.processes;
    footprintBytes += usage.footprintBytes;
    complete.push(usage.complete);
  }
  return { groups: groups.length, processes, footprintBytes, complete: complete.every(Boolean) };
}

/**
 * Whether this process is inside a registered Orbit group.
 *
 * The same discipline the other two platforms keep: `bun test` on its own refuses with
 * `RESOURCE_LIMIT_REQUIRED`, and `bun run verify` is what gives a command a budget. A registry is
 * weaker than a cgroup and the rule it enforces is the same one, so it is enforced the same way.
 *
 * Note what is asked: whether THIS process's group is registered, not whether any group is. A test
 * run that inherited the broker's environment but not its group is not inside the budget, and
 * answering yes would let every future command opt out by being started next to one that did not.
 */
export async function insideRegisteredGroup(root = budgetRegistryRoot()) {
  const pgid = processGroupOf(process.pid);
  if (pgid === null) return false;
  return (await liveBudgetGroups(root)).some(group => group.pgid === pgid);
}
