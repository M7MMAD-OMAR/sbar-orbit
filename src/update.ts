import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep, resolve } from "node:path";
import { call } from "./ipc";
import { withUpdateLock } from "./update-lock";
import { serviceSocketPath } from "./service";
// One spelling of "how Orbit finds its own Bun". This path had `process.execPath || "bun"`, which
// drops the `Bun.which` fallback the install path keeps, so a host where `execPath` is empty behaved
// differently depending on which of the two ran. The whole point of resolving Bun by location is
// that it is off PATH on Windows.
import { bunExecutable } from "./install";

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
  // `%LOCALAPPDATA%` is the Windows equivalent of `$XDG_DATA_HOME`: per user and non roaming, so a
  // tree of prepared versions is never synced to a domain share. Same reasoning as `workspaceRoot()`.
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit");
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "sbar-orbit");
}

/**
 * What makes a directory a prepared version: its launcher, which is the file `current` ultimately
 * resolves to. The name differs by platform, and hardcoding the bash one made every Windows
 * activation refuse with "is not a prepared version" even though the directory was complete.
 */
export function launcherName() {
  return process.platform === "win32" ? "bin/sbar-orbit.cmd" : "bin/sbar-orbit";
}

/** Where the launcher this install runs from is expected to live, per platform. */
export function defaultLauncherPath() {
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit", "bin", "sbar-orbit.cmd");
  return join(homedir(), ".local/bin/sbar-orbit");
}

export function layout(root = updateRoot()): Layout {
  return { root, versions: join(root, "versions"), current: join(root, "current"), previous: join(root, "previous") };
}

/**
 * Which version is current is recorded differently per platform, and the difference is forced rather
 * than chosen.
 *
 * Linux keeps a symlink and repoints it by rename, so no reader ever sees the name missing. Windows
 * cannot do that: measured unelevated on a Windows 11 guest, `symlink()` is EPERM without Developer
 * Mode, and `rename` over a live junction is EPERM as well. The cause is not reparse points, because
 * `rename` over an empty PLAIN directory is EPERM too while the same call succeeds on Linux. Windows
 * does not replace a directory by rename at all, so no junction arrangement recovers the swap.
 *
 * What it does allow is rename over an existing FILE, which is atomic. So Windows records the current
 * version in a pointer file beside the name Linux uses for its link. Measured on the same guest: the
 * swap survived a reader that had already read, and a reader holding the file OPEN across it, which is
 * the property the design actually depends on. It needs no link, no elevation and no Developer Mode.
 *
 * See docs/windows-measured.md section 9, and experiments/windows-vm/link-atomicity-probe.ps1.
 */
const pointerFile = (link: string) => `${link}.txt`;

/**
 * What a pointer names, whichever form this platform uses: a symlink's target, or the pointer file's
 * contents on Windows. Exported so a test can ask the same question the updater asks rather than
 * reaching for `readlink`, which is only half the answer and fails outright on Windows.
 */
export async function linkTarget(path: string) {
  if (process.platform === "win32") {
    // A pointer file written by this code, not a path the user typed, so a trailing newline is the
    // only tolerance needed. An absent file means no version is current, the same as an absent link.
    try { return (await readFile(pointerFile(path), "utf8")).trim() || null; } catch { return null; }
  }
  try { return await readlink(path); } catch { return null; }
}

/** The versions prepared on this machine, newest name last, which is not the same as newest version. */
const validVersion = (version: string) => /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version);
function requireVersion(version: string) {
  if (!validVersion(version)) throw new Error("Invalid release version");
}

export async function preparedVersions(root = updateRoot()) {
  try { return (await readdir(layout(root).versions, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && validVersion(entry.name)).map(entry => entry.name).sort(compareVersions); }
  catch { return []; }
}

export async function currentVersion(root = updateRoot()) {
  const target = await linkTarget(layout(root).current);
  // Split on both separators: the pointer file records a Windows path, and the symlink a POSIX one.
  return target ? target.split(/[/\\]/).filter(Boolean).at(-1) ?? null : null;
}

/**
 * Whether this install is one the updater may touch. A source checkout is not: its updater is git, and
 * a machine's working tree is not something an automatic swap should ever move.
 */
export async function updatableInstall(root = updateRoot(), launcher = defaultLauncherPath()) {
  const target = await realpath(launcher).catch(() => null);
  if (!target) return { updatable: false as const, reason: "no sbar-orbit launcher is linked on this machine" };
  const versions = await realpath(layout(root).versions).catch(() => null);
  // Compare with the platform's own separator. On Windows `realpath` returns backslashes, so a POSIX
  // prefix test would call every managed install unmanaged and silently refuse to update it.
  if (!versions || !target.startsWith(versions + sep))
    return { updatable: false as const, reason: `this install runs from ${dirname(dirname(target))}, not from a managed version directory; a source checkout updates with git` };
  return { updatable: true as const, launcher: target };
}

/**
 * Repoint `current` (or `previous`) atomically, so no reader ever sees the name missing.
 *
 * Both branches are a rename onto the live name, because that is the only shape either platform makes
 * atomic. Linux renames a freshly made symlink over the old one. Windows writes the target into a
 * temporary file and renames that over the pointer file, which is allowed there while renaming over a
 * directory or a junction is not.
 */
async function point(link: string, target: string) {
  const destination = process.platform === "win32" ? pointerFile(link) : link;
  const temporary = `${destination}.${crypto.randomUUID()}`;
  if (process.platform === "win32") await writeFile(temporary, target, "utf8");
  else await symlink(target, temporary);
  try { await rename(temporary, destination); }
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
  if (process.platform !== "linux")
    return { ok: false, output: "Managed update activation is currently supported only on Linux" };
  try {
    const child = Bun.spawn(["systemctl", "--user", "restart", "sbar-orbit.service"], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 40_000);
    try {
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-2).join(" ").slice(0, 300) };
    } finally { clearTimeout(timeout); }
  }
  // A missing binary is a failed restart, not an exception out of the middle of an activation: the
  // rollback below is what has to run, and it only runs if this returns.
  catch (error) { return { ok: false, output: error instanceof Error ? error.message.slice(0, 300) : "systemctl could not be started" }; }
}

/** The broker answering is the only evidence a version works on this machine. */
async function brokerAnswers(version?: string, attempts = 20, waitMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const doctor = await call(serviceSocketPath(), "doctor") as { version?: string };
      if (!version || doctor.version === version) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return false;
}

export type Activation =
  | { activated: false; reason: string; openSessions?: number }
  | { activated: true; version: string; previous: string | null }
  | { activated: false; version: string; previous: string | null; rolledBack: true; rollbackHealthy?: boolean; reason: string };

/**
 * Point `current` at a prepared version and restart the broker, or refuse and say why.
 *
 * Refuses while any session is open, always, with no way to waive it short of stopping the sessions:
 * the person watching one did not ask for it to end. If the new version's broker does not answer, the
 * link goes back to the version that was working and the broker is restarted again, and the report says
 * that happened rather than reporting a success.
 */
export async function activateVersion(version: string, environment: ActivationEnvironment = {}): Promise<Activation> {
  return withUpdateLock(environment.root ?? updateRoot(), () => activateVersionUnlocked(version, environment));
}

async function activateVersionUnlocked(version: string, environment: ActivationEnvironment = {}): Promise<Activation> {
  requireVersion(version);
  if (!environment.restart && process.platform !== "linux")
    return { activated: false, reason: "Managed update activation is currently supported only on Linux" };
  const paths = layout(environment.root);
  const target = join(paths.versions, version);
  const openSessions = await (environment.openSessions ?? brokerSessions)();
  if (openSessions !== null && openSessions > 0)
    return { activated: false, reason: "a session is open, and activating would end it", openSessions };
  if (!await Bun.file(join(target, launcherName())).exists())
    return { activated: false, reason: `${version} is not a prepared version on this machine` };
  const previous = await currentVersion(paths.root);
  if (previous === version) return { activated: false, reason: `${version} is already the current version` };
  // Unit tests inject the boundary. Production takes a broker lease that blocks new and queued
  // sessions before changing the pointer. Old brokers without this protocol refuse safely.
  let token: string | undefined;
  if (!environment.openSessions) {
    const managed = await updatableInstall(paths.root);
    if (!managed.updatable) return { activated: false, reason: managed.reason };
    try { token = (await call(serviceSocketPath(), "update.begin") as { token: string }).token; }
    catch { return { activated: false, reason: "Broker must be idle, reachable and support safe update admission" }; }
  }
  try {
    await mkdir(paths.root, { recursive: true });
    if (previous) await point(paths.previous, join(paths.versions, previous));
    await point(paths.current, target);
    const restart = environment.restart ?? restartService;
    const restarted = await restart();
    const healthy = restarted.ok && await (environment.healthy ?? (() => brokerAnswers(version)))();
    if (healthy) return { activated: true, version, previous };
    if (previous) await point(paths.current, join(paths.versions, previous));
    else await rm(process.platform === "win32" ? pointerFile(paths.current) : paths.current, { force: true });
    const restored = await restart();
    const rollbackHealthy = previous && restored.ok
      ? await (environment.healthy ?? (() => brokerAnswers(previous)))() : false;
    return { activated: false, version, previous, rolledBack: true, rollbackHealthy: Boolean(rollbackHealthy),
      reason: restarted.ok ? `${version} did not answer doctor after its restart` : `restarting on ${version} failed: ${restarted.output}` };
  } finally {
    if (token) await call(serviceSocketPath(), "update.end", { token }).catch(() => {});
  }
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

/**
 * Remove prepared versions nothing would go back to. The current one and the rollback target are never
 * touched; beyond those, `keep` says how many of the rest to hold, newest first by version rather than
 * by name, since `0.1.0-alpha.10` sorts before `0.1.0-alpha.9` in a directory listing and keeping the
 * one a listing happened to put last is not keeping anything in particular.
 */
export async function pruneVersions(root = updateRoot(), keep = 1) {
  return withUpdateLock(root, () => pruneVersionsUnlocked(root, keep));
}

async function pruneVersionsUnlocked(root = updateRoot(), keep = 1) {
  const paths = layout(root);
  const current = await currentVersion(root);
  // Both separators, for the same reason `currentVersion` splits on both: on Windows this reads a
  // pointer file holding a backslash path, and a POSIX-only split would leave `previous` unprotected
  // and let a prune delete the version a rollback needs.
  const previous = (await linkTarget(paths.previous))?.split(/[/\\]/).filter(Boolean).at(-1) ?? null;
  const protectedNames = new Set([current, previous].filter(Boolean) as string[]);
  const removable = (await preparedVersions(root)).filter(version => !protectedNames.has(version)).sort(compareVersions);
  const spare = removable.slice(Math.max(0, removable.length - Math.max(0, keep)));
  const removed: string[] = [];
  for (const version of removable.filter(version => !spare.includes(version))) {
    await rm(join(paths.versions, version), { recursive: true, force: true });
    removed.push(version);
  }
  return { removed, kept: [...protectedNames, ...spare] };
}

/**
 * Finding and preparing a version, which is the half that is allowed to happen on its own.
 *
 * Nothing here activates anything. The worst a run can do is leave a directory nobody points at, which
 * is why this is the automatic half and the swap is not.
 */

/** Order two versions the way the registry does, prerelease identifiers included. */
export function compareVersions(left: string, right: string) {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { numbers: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  // A version with a prerelease tag is below the same version without one.
  if (!a.pre.length !== !b.pre.length) return a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const one = a.pre[index], two = b.pre[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two);
    if (one !== two) return numeric ? Math.sign(Number(one) - Number(two)) : one < two ? -1 : 1;
  }
  return 0;
}

/** The 0.x rule: with a zero major, the minor is what a major would be anywhere else. */
export function sameLine(left: string, right: string) {
  const channel = (version: string) => version.split("-")[1]?.split(".")[0];
  if (channel(right) && channel(left) !== channel(right)) return false;
  const [leftMajor = "0", leftMinor = "0"] = left.split("-")[0]?.split(".") ?? [];
  const [rightMajor = "0", rightMinor = "0"] = right.split("-")[0]?.split(".") ?? [];
  return leftMajor === rightMajor && (leftMajor !== "0" || leftMinor === rightMinor);
}

/**
 * How long a published version waits before this machine will take it. The number is the whole control:
 * a compromised publishing account put a malicious package on a registry for under 40 minutes and about
 * 6,000 machines took it through auto update, and a signature would have verified every one of them,
 * because the attacker held the credentials. Days cost a fix nothing that matters.
 */
export const maturationHours = 72;

export type Feed = {
  /** The registry document for this package. Injected in tests, which never reach the network. */
  metadata?: () => Promise<{ versions: Record<string, { dist?: { tarball?: string; integrity?: string } }>; time?: Record<string, string> }>;
  download?: (url: string) => Promise<ArrayBuffer>;
  now?: () => number;
  maturationHours?: number;
};

/**
 * The full registry document, deliberately, and not the abbreviated
 * `application/vnd.npm.install-v1+json` form a client would normally ask for. Checked on
 * 14 September 2026: the abbreviated document for this package is 1.9 KB against 15.5 KB and carries no
 * `time` field at all, so asking for it would take the maturation delay's only input away and every
 * check would answer that the feed does not say when a version was published, forever. If that trade
 * ever needs revisiting, the delay needs another source for publication time first.
 */
const registryDocument = async () => {
  const response = await fetch("https://registry.npmjs.org/sbar-orbit", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the registry answered ${response.status}`);
  const body = await response.text();
  // A daily timer on somebody else's machine does not get to read an unbounded body into memory.
  if (body.length > 8 * 1024 * 1024) throw new Error("the registry document is larger than this reads");
  return JSON.parse(body) as Awaited<ReturnType<NonNullable<Feed["metadata"]>>>;
};

export type Candidate = { version: string; tarball: string; integrity: string; publishedAt: string };
export type CheckResult = { current: string | null; latest: string | null; eligible: Candidate | null; reason: string };

/** What the feed offers, and the reason whatever it offers is or is not something to take. */
export async function checkForUpdate(current: string, feed: Feed = {}): Promise<CheckResult> {
  const document = await (feed.metadata ?? registryDocument)();
  const now = (feed.now ?? Date.now)();
  const hours = feed.maturationHours ?? maturationHours;
  const published = document.time ?? {};
  const newer = Object.keys(document.versions ?? {})
    .filter(version => compareVersions(version, current) > 0)
    .sort(compareVersions);
  const latest = newer.at(-1) ?? null;
  if (!latest) return { current, latest: null, eligible: null, reason: "this is the newest version the feed has" };
  const withinLine = newer.filter(version => sameLine(version, current));
  if (!withinLine.length)
    return { current, latest, eligible: null, reason: `${latest} is a different release line; crossing it is a decision, not a fix` };
  const candidate = withinLine.at(-1) as string;
  const at = published[candidate];
  if (!at) return { current, latest, eligible: null, reason: `the feed does not say when ${candidate} was published` };
  const ageHours = (now - Date.parse(at)) / 3_600_000;
  if (!(ageHours >= hours))
    return { current, latest, eligible: null, reason: `${candidate} is ${Math.max(0, Math.floor(ageHours))} hours old and this machine waits ${hours}` };
  const distribution = document.versions?.[candidate]?.dist;
  if (!distribution?.tarball || !distribution.integrity)
    return { current, latest, eligible: null, reason: `the feed offers no verifiable archive for ${candidate}` };
  return { current, latest, eligible: { version: candidate, tarball: distribution.tarball, integrity: distribution.integrity, publishedAt: at }, reason: `${candidate} is eligible` };
}

async function integrityOf(bytes: ArrayBuffer) {
  return `sha512-${Buffer.from(await crypto.subtle.digest("SHA-512", bytes)).toString("base64")}`;
}

export type Preparation = { prepared: false; reason: string } | { prepared: true; version: string; directory: string; files: number };

/**
 * Unpack a candidate into its own version directory and make it ready to be activated, with nothing
 * written into the tree the running broker executes from.
 *
 * The digest check is against the digest the same document carried, so it proves the bytes arrived
 * whole and nothing about who published them. That is what the maturation delay above is for, and
 * saying so here is more use than a check that reads stronger than it is.
 */
export async function prepareVersion(candidate: Candidate, feed: Feed = {}, environment: { root?: string; install?: (directory: string) => Promise<{ ok: boolean; output: string }> } = {}): Promise<Preparation> {
  return withUpdateLock(environment.root ?? updateRoot(), () => prepareVersionUnlocked(candidate, feed, environment));
}

async function prepareVersionUnlocked(candidate: Candidate, feed: Feed = {}, environment: { root?: string; install?: (directory: string) => Promise<{ ok: boolean; output: string }> } = {}): Promise<Preparation> {
  requireVersion(candidate.version);
  const paths = layout(environment.root);
  const directory = join(paths.versions, candidate.version);
  // The same launcher name activation will look for, so a version cannot be "prepared" here and then
  // refused there as not prepared.
  if (await Bun.file(join(directory, launcherName())).exists())
    return { prepared: true, version: candidate.version, directory, files: 0 };
  const bytes = await (feed.download ?? (async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`the archive answered ${response.status}`);
    return await response.arrayBuffer();
  }))(candidate.tarball);
  const digest = await integrityOf(bytes);
  if (digest !== candidate.integrity) return { prepared: false, reason: "the archive does not match the digest the feed published for it" };
  const staging = join(paths.versions, `.${candidate.version}.${crypto.randomUUID()}.incoming`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const archive = join(staging, "package.tgz");
    await Bun.write(archive, bytes);
    // Unpacked with the system tar, which keeps symlinks as symlinks: a library copy that rewrites them
    // into absolute paths is how the shared runtime broke once already.
    const unpack = Bun.spawn(["tar", "xzf", archive, "-C", staging, "--strip-components=1"], { stdout: "pipe", stderr: "pipe" });
    const problem = (await new Response(unpack.stderr).text()).trim();
    if (await unpack.exited !== 0) return { prepared: false, reason: problem.split("\n").at(-1)?.slice(0, 200) || "the archive could not be unpacked" };
    await rm(archive, { force: true });
    if (!await Bun.file(join(staging, launcherName())).exists())
      return { prepared: false, reason: `the archive carries no ${launcherName()}, so it is not an Orbit release for this platform` };
    const manifest = await Bun.file(join(staging, "package.json")).json();
    if (manifest.name !== "sbar-orbit" || manifest.version !== candidate.version)
      return { prepared: false, reason: "Archive package identity does not match the requested version" };
    const installed = await (environment.install ?? (async (target: string) => {
      // The running interpreter, not a bare "bun": a broker started by a service or an agent host has
      // its own PATH, which need not carry Bun. Same reason `src/install.ts` resolves it this way.
      const child = Bun.spawn([bunExecutable(), "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: target, stdout: "pipe", stderr: "pipe" });
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-2).join(" ").slice(0, 300) };
    }))(staging);
    if (!installed.ok) return { prepared: false, reason: `preparing dependencies failed: ${installed.output}` };
    await rename(staging, directory);
    return { prepared: true, version: candidate.version, directory, files: (await readdir(directory)).length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/**
 * The switch, and the one command the timer runs.
 *
 * Off is the default and absence means off, so a machine that has never been told anything never
 * updates itself. The switch is a file this process reads before anything else, so `update off` stops a
 * run even when the timer is still enabled and even with no network and no broker, which is the state
 * the switch exists for.
 */
const switchPath = (root = updateRoot()) => join(root, "automatic");

export async function automaticUpdates(root = updateRoot()) {
  return (await Bun.file(switchPath(root)).text().catch(() => "off")).trim() === "on";
}

export async function setAutomaticUpdates(on: boolean, root = updateRoot(), timer: (on: boolean) => Promise<{ ok: boolean; output: string }> = systemdTimer) {
  await mkdir(root, { recursive: true });
  await Bun.write(switchPath(root), on ? "on\n" : "off\n");
  const unit = await timer(on);
  if (on && !unit.ok) await Bun.write(switchPath(root), "off\n");
  return { automatic: on && unit.ok, timer: unit.ok ? (on ? "enabled" : "disabled") : `unchanged: ${unit.output}` };
}

async function systemdTimer(on: boolean) {
  if (process.platform !== "linux")
    return { ok: false, output: "Automatic update scheduling is currently supported only on Linux" };
  if (on && !(await updatableInstall()).updatable)
    return { ok: false, output: "Run install --managed before enabling automatic updates" };
  try {
    const child = Bun.spawn(["systemctl", "--user", on ? "enable" : "disable", "--now", "sbar-orbit-update.timer"], { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, output: `${output}${errors}`.trim().split("\n").slice(-1).join(" ").slice(0, 200) };
  }
  catch (error) { return { ok: false, output: error instanceof Error ? error.message.slice(0, 200) : "systemctl could not be started" }; }
}

export type RunEnvironment = ActivationEnvironment & Feed & {
  install?: (directory: string) => Promise<{ ok: boolean; output: string }>;
  /** Whether this run may point the link at what it prepared, rather than leaving it waiting. */
  mayActivate?: boolean;
  /** The launcher link to judge, for tests; the real one is the person's ~/.local/bin/sbar-orbit. */
  launcher?: string;
};

/**
 * One pass: read the switch, ask the feed, prepare what is eligible, and activate only at a boundary.
 *
 * Activation from here is silent by design, and it can afford to be: it restarts the broker and touches
 * nothing the person is looking at. The desktop mark is a separate process that keeps running its own
 * version until it is restarted, which `updateStatus` reports rather than hiding.
 */
export async function runUpdate(current: string, environment: RunEnvironment = {}): Promise<Record<string, unknown>> {
  const root = environment.root ?? updateRoot();
  if (!await automaticUpdates(root)) return { ran: false, reason: "automatic updates are off on this machine" };
  const install = await updatableInstall(root, environment.launcher);
  if (!install.updatable) return { ran: false, reason: install.reason };
  const found = await checkForUpdate(current, environment);
  if (!found.eligible) return { ran: true, prepared: null, reason: found.reason, latest: found.latest };
  const prepared = await prepareVersion(found.eligible, environment, { root, install: environment.install });
  if (!prepared.prepared) return { ran: true, prepared: null, reason: prepared.reason, latest: found.latest };
  if (!await automaticUpdates(root))
    return { ran: true, prepared: prepared.version, activated: false, reason: "automatic updates were turned off during preparation" };
  if (environment.mayActivate === false) return { ran: true, prepared: prepared.version, activated: false, reason: "prepared only, activation was not asked for" };
  const activation = await activateVersion(prepared.version, environment);
  return { ran: true, prepared: prepared.version, ...activation };
}

/** Adopt a release into a persistent layout without modifying the package-manager installation. */
export async function prepareManagedInstall(source: string, options: {
  root?: string; dryRun?: boolean; openSessions?: () => Promise<number | null>;
  install?: (directory: string) => Promise<{ ok: boolean; output: string }>;
} = {}) {
  if (options.dryRun) return prepareManagedInstallUnlocked(source, options);
  return withUpdateLock(options.root ?? updateRoot(), () => prepareManagedInstallUnlocked(source, options));
}

async function prepareManagedInstallUnlocked(source: string, options: {
  root?: string; dryRun?: boolean; openSessions?: () => Promise<number | null>;
  install?: (directory: string) => Promise<{ ok: boolean; output: string }>;
} = {}) {
  if (process.platform !== "linux") throw new Error("Managed installation is currently supported only on Linux");
  const origin = await realpath(source);
  if (await lstat(join(origin, ".git")).catch(() => null))
    throw new Error("Use an extracted release or registry package for install --managed; keep source checkouts on git");
  const manifest = await Bun.file(join(origin, "package.json")).json();
  if (manifest.name !== "sbar-orbit" || typeof manifest.version !== "string") throw new Error("Not an Orbit release");
  requireVersion(manifest.version);
  const paths = layout(options.root);
  const current = await currentVersion(paths.root);
  if (current && current !== manifest.version)
    throw new Error("A managed version is already active; use update check, stage and activate instead");
  if (options.dryRun) return paths.current;
  const sessions = await (options.openSessions ?? brokerSessions)();
  if (sessions !== null && sessions > 0) throw new Error("Close Orbit sessions before adopting a managed installation");
  if (!current && sessions !== null)
    throw new Error("Stop the existing broker with systemctl --user stop sbar-orbit.service before first managed adoption");
  const directory = join(paths.versions, manifest.version);
  if (!await Bun.file(join(directory, launcherName())).exists()) {
    const staging = join(paths.versions, `.${manifest.version}.${crypto.randomUUID()}.adopt`);
    await mkdir(staging, { recursive: true });
    try {
      // Copy only shipped runtime inputs, never a checkout's output, credentials or workspace state.
      for (const name of ["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]) {
        if (await lstat(join(origin, name)).catch(() => null))
          await cp(join(origin, name), join(staging, name), { recursive: true, verbatimSymlinks: true });
      }
      const result = await (options.install ?? (async directory => {
        const child = Bun.spawn([bunExecutable(), "install", "--frozen-lockfile", "--ignore-scripts"],
          { cwd: directory, stdout: "pipe", stderr: "pipe" });
        const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { ok: code === 0, output: (output + error).slice(-300) };
      }))(staging);
      if (!result.ok) throw new Error(`Managed dependency preparation failed: ${result.output}`);
      await rename(staging, directory);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  if (!current) await point(paths.current, directory);
  return paths.current;
}
