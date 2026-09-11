import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  canRestoreTo, clearRestorePoints, createSubvolume, isSubvolume, listRestorePoints,
  removeRestorePoint, reversibilityOf, takeRestorePoint, undoCompleteness,
} from "../src/restore";

/** Snapshots need btrfs, so the filesystem tests run where the workspaces actually live. */
const workspaceRoot = join(homedir(), ".cache");
const onBtrfs = await (async () => {
  const probe = Bun.spawn(["/usr/bin/findmnt", "-no", "FSTYPE", "--target", workspaceRoot], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(probe.stdout).text()).trim() === "btrfs" && await probe.exited === 0;
})();

test("what an action changed decides what taking it back would mean", () => {
  // A click can be a send, and Orbit cannot tell one from another, so it is the worst case.
  expect(reversibilityOf("click")).toBe("unknown");
  expect(reversibilityOf("fill")).toBe("unknown");
  expect(undoCompleteness[reversibilityOf("click")]).toBe("none");
  // A fetch leaves an access entry on the person's account: a disclosure, not a change.
  expect(reversibilityOf("navigate")).toBe("remote-read");
  expect(undoCompleteness["remote-read"]).toBe("none");
  // The clone is a fork that never reached the person's browser, so undoing it is moot.
  expect(reversibilityOf("close-tab")).toBe("profile-only");
  expect(undoCompleteness["profile-only"]).toBe("moot");
  // Inside the private display, which is disposable.
  expect(reversibilityOf("launch")).toBe("workspace");
  expect(undoCompleteness.workspace).toBe("complete");
  // Anything Orbit has not seen is the worst case, never the best.
  expect(reversibilityOf("wire-transfer")).toBe("unknown");
});

test("a restore point is refused when something already left the machine", () => {
  const point = { sequence: 3, path: "/tmp/p", actionType: "launch", reversibility: "workspace" as const, consistent: true, milliseconds: 12 };

  // Nothing since, or only things that changed nothing outside the workspace.
  expect(canRestoreTo(point, []).allowed).toBe(true);
  expect(canRestoreTo(point, [{ actionType: "read" }, { actionType: "close-tab" }]).allowed).toBe(true);

  // A click might have been a send. Restoring would put the profile back and leave the send sent,
  // and the person would have been told it was undone.
  const afterClick = canRestoreTo(point, [{ actionType: "read" }, { actionType: "click" }]);
  expect(afterClick.allowed).toBe(false);
  if (!afterClick.allowed) {
    expect(afterClick.reason).toContain("click");
    expect(afterClick.reason).toContain("does not undo what it cannot undo");
  }

  // A navigation disclosed something to the service, which no local snapshot retracts.
  expect(canRestoreTo(point, [{ actionType: "navigate" }]).allowed).toBe(false);
  expect(canRestoreTo(undefined, []).allowed).toBe(false);
});

test("no restore point is taken for an action a snapshot could not undo", async () => {
  const root = await mkdtemp(join(workspaceRoot, "orbit-restore-none-"));
  try {
    // Taking one before a send would record a promise the filesystem cannot keep.
    expect(await takeRestorePoint(root, join(root, "points"), 1, "click")).toBeNull();
    expect(await takeRestorePoint(root, join(root, "points"), 2, "navigate")).toBeNull();
    expect(await takeRestorePoint(root, join(root, "points"), 3, "wire-transfer")).toBeNull();
    expect(await listRestorePoints(join(root, "points"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.if(onBtrfs)("a restore point is taken, restores the files, and can always be removed", async () => {
  const root = await mkdtemp(join(workspaceRoot, "orbit-restore-"));
  const profile = join(root, "profile");
  const store = join(root, "points");
  try {
    expect(await createSubvolume(profile)).toBe(true);
    expect(await isSubvolume(profile)).toBe(true);
    await writeFile(join(profile, "Preferences"), "before");

    const point = await takeRestorePoint(profile, store, 1, "launch", true);
    expect(point).not.toBeNull();
    if (!point) return;
    expect(point.consistent).toBe(true);
    expect(point.reversibility).toBe("workspace");
    // The point holds what the profile held when it was taken.
    expect(await readFile(join(point.path, "Preferences"), "utf8")).toBe("before");

    // The session carries on changing the profile; the point does not follow it.
    await writeFile(join(profile, "Preferences"), "after");
    expect(await readFile(join(point.path, "Preferences"), "utf8")).toBe("before");
    expect(await readFile(join(profile, "Preferences"), "utf8")).toBe("after");

    // A point taken mid action is not labelled consistent, because cookies were measured staying in
    // browser memory for about 35 seconds.
    const midAction = await takeRestorePoint(profile, store, 2, "launch");
    expect(midAction?.consistent).toBe(false);
    expect((await listRestorePoints(store)).length).toBe(2);

    // Removal is the property that matters most: a restore point is a copy of live cookies, so one
    // that cannot be deleted is a credential that outlives its session. btrfs subvolume delete
    // reports success on a read only snapshot and leaves it in place, which is why removeRestorePoint
    // clears the ro property first.
    expect(await removeRestorePoint(point.path)).toBe(true);
    const cleared = await clearRestorePoints(store);
    expect(cleared.left).toEqual([]);
    expect(cleared.removed).toBe(1);
    // Nothing at all is left behind, including the store itself.
    await expect(stat(store)).rejects.toThrow();
  } finally {
    await Bun.spawn(["/usr/bin/btrfs", "property", "set", "-ts", profile, "ro", "false"], { stdout: "ignore", stderr: "ignore" }).exited;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test.if(onBtrfs)("a snapshot costs no additional disk, which is what makes one per action affordable", async () => {
  const root = await mkdtemp(join(workspaceRoot, "orbit-restore-cost-"));
  const profile = join(root, "profile");
  const store = join(root, "points");
  try {
    await createSubvolume(profile);
    await mkdir(join(profile, "Default"), { recursive: true });
    // 64 MiB of incompressible data, so a real copy could not hide behind compression.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    crypto.getRandomValues(chunk.subarray(0, 65536));
    for (let offset = 65536; offset < chunk.length; offset += 65536) chunk.set(chunk.subarray(0, 65536), offset);
    for (let i = 0; i < 8; i++) await writeFile(join(profile, "Default", `f${i}`), chunk);

    const point = await takeRestorePoint(profile, store, 1, "launch", true);
    expect(point).not.toBeNull();
    if (!point) return;
    const usage = Bun.spawn(["/usr/bin/btrfs", "filesystem", "du", "-s", point.path], { stdout: "pipe", stderr: "ignore" });
    const summary = await new Response(usage.stdout).text();
    // Exclusive bytes are what a snapshot actually costs. Shared extents cost nothing.
    expect(summary).toContain("0.00B");
    await clearRestorePoints(store);
  } finally {
    await Bun.spawn(["/usr/bin/btrfs", "property", "set", "-ts", profile, "ro", "false"], { stdout: "ignore", stderr: "ignore" }).exited;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("a filesystem that cannot make a subvolume leaves the directory exactly as it was", async () => {
  // tmpfs has no subvolumes. The first version of this removed the directory before asking btrfs,
  // so on tmpfs it deleted the session profile and returned false, and every browser session then
  // failed to start into a profile that was no longer there.
  const root = await mkdtemp(join("/tmp", "orbit-nosubvol-"));
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, "marker"), "still here");
  try {
    expect(await createSubvolume(profile)).toBe(false);
    // The directory, its mode and its contents all survive a filesystem that said no.
    expect((await stat(profile)).isDirectory()).toBe(true);
    expect(await readFile(join(profile, "marker"), "utf8")).toBe("still here");
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    // And no half-made spare is left beside it.
    await expect(stat(`${profile}.subvol`)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.if(onBtrfs)("a new subvolume is no looser than the directory it replaces", async () => {
  const root = await mkdtemp(join(workspaceRoot, "orbit-subvol-mode-"));
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  try {
    expect(await createSubvolume(profile)).toBe(true);
    // btrfs creates at the umask, and this directory holds a copy of the person's live sessions.
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    expect(await isSubvolume(profile)).toBe(true);
  } finally {
    await Bun.spawn(["/usr/bin/btrfs", "property", "set", "-ts", profile, "ro", "false"], { stdout: "ignore", stderr: "ignore" }).exited;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
