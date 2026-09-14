import { mkdir, readdir, readlink, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "./ipc";
import { serviceSocketPath } from "./service";

/**
 * Changing which version of Orbit is the running one, without taking away a session.
 *
 * The rule the whole thing turns on: a session is state inside the broker process, so a version swap
 * ends every open session. Activation therefore waits for a boundary instead of moving anything, and
 * refuses while a session is open. See [docs/updates.md](../docs/updates.md) for why a socket handover
 * does not help here.
 *
 * Preparing is the opposite: versions live side by side in their own directories and one symlink says
 * which is current, so a new version can be unpacked, its dependencies prepared and its `preflight` run
 * while the old one keeps serving, with nothing written into the tree the running broker executes from.
 */

export type Layout = { root: string; versions: string; current: string; previous: string };

export function updateRoot() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "sbar-orbit");
}

export function layout(root = updateRoot()): Layout {
  return { root, versions: join(root, "versions"), current: join(root, "current"), previous: join(root, "previous") };
}

async function linkTarget(path: string) {
  try { return await readlink(path); } catch { return null; }
}

/** The versions prepared on this machine, newest name last, which is not the same as newest version. */
export async function preparedVersions(root = updateRoot()) {
  try { return (await readdir(layout(root).versions)).sort(); } catch { return []; }
}

export async function currentVersion(root = updateRoot()) {
  const target = await linkTarget(layout(root).current);
  return target ? target.split("/").filter(Boolean).at(-1) ?? null : null;
}

/**
 * Whether this install is one the updater may touch. A source checkout is not: its updater is git, and
 * a machine's working tree is not something an automatic swap should ever move.
 */
export async function updatableInstall(root = updateRoot(), launcher = join(homedir(), ".local/bin/sbar-orbit")) {
  const target = await realpath(launcher).catch(() => null);
  if (!target) return { updatable: false as const, reason: "no sbar-orbit launcher is linked on this machine" };
  const versions = await realpath(layout(root).versions).catch(() => null);
  if (!versions || !target.startsWith(`${versions}/`))
    return { updatable: false as const, reason: `this install runs from ${dirname(dirname(target))}, not from a managed version directory; a source checkout updates with git` };
  return { updatable: true as const, launcher: target };
}

/** Repoint one symlink by rename, so no reader ever sees the name missing. */
async function point(link: string, target: string) {
  const temporary = `${link}.${crypto.randomUUID()}`;
  await symlink(target, temporary);
  try { await rename(temporary, link); }
  finally { await unlink(temporary).catch(() => {}); }
}

export type ActivationEnvironment = {
  root?: string;
  /** Open sessions the broker reports. `null` means no broker answered, which is itself a boundary. */
  openSessions?: () => Promise<number | null>;
  restart?: () => Promise<{ ok: boolean; output: string }>;
  /** Whether the broker answers after a restart. The health check that decides a rollback. */
  healthy?: () => Promise<boolean>;
};

async function brokerSessions(): Promise<number | null> {
  try {
    const sessions = await call(serviceSocketPath(), "session.list") as { state: string }[];
    return sessions.filter(session => session.state !== "closed").length;
  } catch { return null; }
}

async function restartService() {
  const child = Bun.spawn(["systemctl", "--user", "restart", "sbar-orbit.service"], { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-2).join(" ").slice(0, 300) };
}

/** The broker answering is the only evidence a version works on this machine. */
async function brokerAnswers(attempts = 20, waitMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await call(serviceSocketPath(), "doctor"); return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return false;
}

export type Activation =
  | { activated: false; reason: string; openSessions?: number }
  | { activated: true; version: string; previous: string | null }
  | { activated: false; version: string; previous: string | null; rolledBack: true; reason: string };

/**
 * Point `current` at a prepared version and restart the broker, or refuse and say why.
 *
 * Refuses while any session is open, always, with no way to waive it short of stopping the sessions:
 * the person watching one did not ask for it to end. If the new version's broker does not answer, the
 * link goes back to the version that was working and the broker is restarted again, and the report says
 * that happened rather than reporting a success.
 */
export async function activateVersion(version: string, environment: ActivationEnvironment = {}): Promise<Activation> {
  const paths = layout(environment.root);
  const target = join(paths.versions, version);
  const openSessions = await (environment.openSessions ?? brokerSessions)();
  if (openSessions !== null && openSessions > 0)
    return { activated: false, reason: "a session is open, and activating would end it", openSessions };
  if (!await Bun.file(join(target, "bin/sbar-orbit")).exists())
    return { activated: false, reason: `${version} is not a prepared version on this machine` };
  const previous = await currentVersion(paths.root);
  if (previous === version) return { activated: false, reason: `${version} is already the current version` };
  await mkdir(paths.root, { recursive: true });
  if (previous) await point(paths.previous, join(paths.versions, previous));
  await point(paths.current, target);
  const restarted = await (environment.restart ?? restartService)();
  const healthy = restarted.ok && await (environment.healthy ?? brokerAnswers)();
  if (healthy) return { activated: true, version, previous };
  // The rollback is the reason `previous` exists. Nothing here deletes the version that failed: it is
  // the evidence, and `doctor` on the restored broker is what says the machine is working again.
  if (previous) await point(paths.current, join(paths.versions, previous));
  await (environment.restart ?? restartService)();
  return { activated: false, version, previous, rolledBack: true,
    reason: restarted.ok ? `${version} did not answer doctor after its restart` : `restarting on ${version} failed: ${restarted.output}` };
}

/** What a person or a panel needs to decide whether anything is waiting. */
export async function updateStatus(environment: ActivationEnvironment = {}) {
  const root = environment.root ?? updateRoot();
  const [current, prepared, sessions, install] = await Promise.all([
    currentVersion(root), preparedVersions(root),
    (environment.openSessions ?? brokerSessions)(), updatableInstall(root),
  ]);
  const pending = prepared.filter(version => version !== current);
  return {
    current, prepared, pending,
    openSessions: sessions,
    // Both halves of the boundary, separately, because a machine that cannot activate for two different
    // reasons should say which one.
    canActivate: install.updatable && (sessions === null || sessions === 0),
    managed: install.updatable,
    ...(install.updatable ? {} : { reason: install.reason }),
  };
}

/** Remove prepared versions that are neither current nor the one to roll back to. */
export async function pruneVersions(root = updateRoot(), keep = 2) {
  const paths = layout(root);
  const current = await currentVersion(root);
  const previous = (await linkTarget(paths.previous))?.split("/").filter(Boolean).at(-1) ?? null;
  const protectedNames = new Set([current, previous].filter(Boolean) as string[]);
  const removable = (await preparedVersions(root)).filter(version => !protectedNames.has(version));
  const removed: string[] = [];
  for (const version of removable.slice(0, Math.max(0, removable.length - Math.max(0, keep - protectedNames.size)))) {
    await rm(join(paths.versions, version), { recursive: true, force: true });
    removed.push(version);
  }
  return { removed, kept: [...protectedNames, ...removable.filter(version => !removed.includes(version))] };
}
