import { chmod, mkdir, rename, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Restore points, and the honest limit on what they can take back.
 *
 * The owner asked for automatic undo. This is the part of that promise Orbit can actually keep, and
 * the part it cannot is written here rather than discovered later.
 *
 * Authorisation and reversibility are different questions. `read | navigate | write | irreversible`
 * answers "may this run". It does not answer "can this be taken back", and an undo that silently
 * covers the first while pretending to cover the second is worse than no undo at all: it invites a
 * person to believe a message was unsent.
 */

/** What an action changed, and therefore what taking it back would mean. */
export type Reversibility =
  /** Files inside the session profile. A snapshot restores it completely. */
  | "workspace"
  /** Browser state in the clone. Complete and moot: the clone never reached the person's browser. */
  | "profile-only"
  /** Nothing changed, but a disclosure happened and the service logged an access. */
  | "remote-read"
  /** The service changed. A message sent, an order placed, a setting saved. Nothing local undoes it. */
  | "remote-write"
  /** Orbit cannot tell, and so treats it as the worst case. */
  | "unknown";

/** Zero means nothing local can take it back, whatever a snapshot holds. */
export const undoCompleteness: Record<Reversibility, "complete" | "moot" | "none"> = {
  workspace: "complete", "profile-only": "moot", "remote-read": "none", "remote-write": "none", unknown: "none",
};

const reversibilityOfAction: Record<string, Reversibility> = {
  // Reading the loaded document touches nothing and asks nothing.
  read: "workspace", observe: "workspace", scroll: "workspace", resize: "workspace", "select-tab": "workspace",
  // A fetch leaves an access entry on the person's account, which is a disclosure and not a change.
  navigate: "remote-read", "open-tab": "remote-read",
  // The clone's own state, which is deleted with the session and never reached the person's browser.
  "close-tab": "profile-only",
  // A click can be a send. Orbit cannot tell one from another, and the doc's rule is that what it
  // cannot tell is the worst case, so these are not restorable even though a snapshot exists.
  click: "unknown", fill: "unknown", paste: "unknown", key: "unknown", text: "unknown", pointer: "unknown",
  // Inside the private display, which is disposable and reaped with the session.
  launch: "workspace", window: "workspace",
  download: "remote-read",
};

export function reversibilityOf(actionType: string): Reversibility {
  return reversibilityOfAction[actionType] ?? "unknown";
}

export type RestorePoint = {
  /** Sequence in the session's journal, so a point lines up with the action it precedes. */
  sequence: number;
  path: string;
  actionType: string;
  reversibility: Reversibility;
  /**
   * True only when the browser was quiesced and the commit window had passed. Cookies were measured
   * staying in browser memory for about 35 seconds, so a snapshot taken mid action is up to that
   * stale and possibly torn. It is still worth taking. It is not worth calling consistent.
   */
  consistent: boolean;
  milliseconds: number;
};

async function btrfs(args: string[]): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(["/usr/bin/btrfs", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: await child.exited === 0, output: `${out}${err}`.trim() };
}

/**
 * Turn an existing empty directory into its own subvolume, so it can be snapshotted. A plain
 * directory cannot be.
 *
 * The caller already has a directory and is going to use it either way, so a filesystem that cannot
 * do this must leave that directory exactly as it found it. Removing it first and only then asking
 * btrfs is how this was first written, and on tmpfs it deleted the session profile and returned
 * false, which every browser session then failed to start into.
 */
export async function createSubvolume(path: string): Promise<boolean> {
  const created = await btrfs(["subvolume", "create", `${path}.subvol`]);
  if (!created.ok) return false;
  try {
    await rm(path, { recursive: true, force: true });
    await rename(`${path}.subvol`, path);
    // btrfs creates a subvolume at the umask, and the directory this replaces was 0700 because it
    // holds a copy of the person's live sessions.
    await chmod(path, 0o700);
    return true;
  } catch {
    // Put nothing in a worse state than it was found in: drop the spare and leave the directory.
    await removeRestorePoint(`${path}.subvol`).catch(() => {});
    return false;
  }
}

export async function isSubvolume(path: string): Promise<boolean> {
  try { return (await stat(path)).ino === 256; } catch { return false; }
}

/**
 * Remove a restore point.
 *
 * Measured on this workstation, and the reason this function exists rather than a one line `rm`:
 * `btrfs subvolume delete` on a read only snapshot prints a success line and leaves the snapshot in
 * place, and `rm -rf` on one fails with "Read-only file system". Clearing the `ro` property first
 * succeeds unprivileged, and then `rm -rf` works.
 *
 * Getting this wrong is not a tidiness problem. A restore point is a copy of the person's live
 * cookies, so one that cannot be deleted is a credential that outlives its session.
 */
export async function removeRestorePoint(path: string): Promise<boolean> {
  await btrfs(["property", "set", "-ts", path, "ro", "false"]);
  await rm(path, { recursive: true, force: true }).catch(() => {});
  try { await stat(path); return false; } catch { return true; }
}

/** Take one, before the action rather than after it. Returns null where the filesystem cannot. */
export async function takeRestorePoint(profile: string, store: string, sequence: number, actionType: string, quiesced = false): Promise<RestorePoint | null> {
  const reversibility = reversibilityOf(actionType);
  // A point is only taken where it could be used. Taking one before a send would record a promise
  // the filesystem cannot keep.
  if (undoCompleteness[reversibility] !== "complete") return null;
  await mkdir(store, { recursive: true, mode: 0o700 });
  const path = join(store, `${String(sequence).padStart(6, "0")}-${actionType}`);
  const started = performance.now();
  const snapshot = await btrfs(["subvolume", "snapshot", "-r", profile, path]);
  if (!snapshot.ok) return null;
  return { sequence, path, actionType, reversibility, consistent: quiesced, milliseconds: Math.round(performance.now() - started) };
}

export type RestoreVerdict = { allowed: true; point: RestorePoint } | { allowed: false; reason: string };

/**
 * May the session be rolled back to this point?
 *
 * The refusal is the feature. Restoring a profile after the agent sent a message would put the
 * browser back and leave the message sent, and the person would have been told it was undone.
 */
export function canRestoreTo(point: RestorePoint | undefined, since: { actionType: string }[]): RestoreVerdict {
  if (!point) return { allowed: false, reason: "There is no restore point at that sequence." };
  const blocking = since
    .map(entry => ({ actionType: entry.actionType, reversibility: reversibilityOf(entry.actionType) }))
    .filter(entry => undoCompleteness[entry.reversibility] === "none");
  if (blocking.length) {
    const named = [...new Set(blocking.map(entry => `${entry.actionType} (${entry.reversibility})`))].join(", ");
    return { allowed: false, reason: `Restoring would put the profile back and leave what already left the machine: ${named}. Orbit does not undo what it cannot undo.` };
  }
  return { allowed: true, point };
}

/** Every point a session holds, oldest first. */
export async function listRestorePoints(store: string): Promise<string[]> {
  try { return (await readdir(store)).sort(); } catch { return []; }
}

/** Remove all of them. Called when a session ends, because each one is a copy of live credentials. */
export async function clearRestorePoints(store: string): Promise<{ removed: number; left: string[] }> {
  const left: string[] = [];
  let removed = 0;
  for (const name of await listRestorePoints(store)) {
    if (await removeRestorePoint(join(store, name))) removed++;
    else left.push(name);
  }
  await rm(store, { recursive: true, force: true }).catch(() => {});
  return { removed, left };
}
