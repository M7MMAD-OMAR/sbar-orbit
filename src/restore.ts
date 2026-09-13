import { chmod, mkdir, rename, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripSingletonMarkers } from "./platform";

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

/**
 * Ask btrfs for something, and treat a machine that has no btrfs as a machine that cannot do it.
 *
 * `Bun.spawn` throws on a binary that is not there rather than returning a failing exit code, so the
 * absence of `btrfs-progs` was not a false from this function, it was an exception through every
 * caller. Measured 13 September 2026 on a fresh Fedora machine with no btrfs-progs installed: every
 * `session.create` failed with `ENOENT: posix_spawn '/usr/bin/btrfs'`, browser and native alike, on a
 * filesystem that was never going to hold a restore point anyway. Restore points are the feature that
 * needs this tool; sessions are not.
 */
type BtrfsChild = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };
export async function btrfs(args: string[],
  spawn: (command: string[]) => BtrfsChild = command => Bun.spawn(command, { stdout: "pipe", stderr: "pipe" }) as unknown as BtrfsChild,
): Promise<{ ok: boolean; output: string }> {
  let child: BtrfsChild;
  try { child = spawn(["/usr/bin/btrfs", ...args]); }
  catch (error) { return { ok: false, output: error instanceof Error ? error.message : "btrfs is not installed" }; }
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

/**
 * Put a profile back to what a point holds, by swapping paths rather than copying into place.
 *
 * A copy into the live directory would not be a restore. It leaves behind everything the point does
 * not mention, so a file the session created afterwards survives its own undo, and a browser profile is
 * mostly files nothing else knows the names of. The swap replaces the directory itself.
 *
 * The browser must be gone first. Chrome holds its profile open, so a swap under a live browser puts
 * the files back while the browser keeps working from the copy in its own memory and writes that out
 * again when it exits. That is not a restore, it is a restore that undoes itself.
 *
 * A filesystem that cannot make the writable snapshot leaves everything exactly as it was, which is the
 * same contract as `createSubvolume` and for the same reason: the caller has a profile either way.
 */
export async function restoreProfile(profile: string, point: RestorePoint): Promise<boolean> {
  const incoming = `${profile}.restored`;
  const outgoing = `${profile}.replaced`;
  await removeRestorePoint(incoming).catch(() => {});
  // A snapshot of the read only point, writable, so the session can carry on into it. It is itself a
  // subvolume, so further points can still be taken after a restore.
  const made = await btrfs(["subvolume", "snapshot", point.path, incoming]);
  if (!made.ok) return false;
  try {
    await rename(profile, outgoing);
    await rename(incoming, profile);
    await chmod(profile, 0o700);
  } catch {
    await removeRestorePoint(incoming).catch(() => {});
    // Whatever the first rename did, put the name back rather than leave a session with no profile.
    try { await stat(profile); } catch { await rename(outgoing, profile).catch(() => {}); }
    return false;
  }
  // The point was taken from a running browser, so it holds that browser's singleton markers. Another
  // Chrome starting on them either refuses the profile or asks the first one to hand over, and the
  // first one is gone.
  await stripSingletonMarkers(profile);
  // What was replaced is a copy of the person's live cookies, like every other point.
  await removeRestorePoint(outgoing).catch(() => {});
  return true;
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
