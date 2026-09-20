import { test, expect } from "bun:test";
import { linuxOnlyTest, needsSymlink, onBtrfs as onBtrfsPath, fixtureRoot } from "./platform-support";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join, posix, win32 } from "node:path";
import { createWorkspaceDirectory, workspaceRoot } from "../src/workspace-storage";
import { tmpdir, homedir } from "node:os";

linuxOnlyTest("POSIX mode bits on the root and a /dev/shm root, neither of which Windows has")(
  "workspace storage creates unique private directories and rejects unsafe or RAM-backed roots", async () => {
  await mkdir("output", { recursive: true });
  const scratch = await mkdtemp(resolve("output/storage-test-"));
  const root = join(scratch, "workspaces");
  const a = await createWorkspaceDirectory("test", root);
  const b = await createWorkspaceDirectory("test", root);
  expect(a).not.toBe(b);
  expect((await lstat(a)).mode & 0o777).toBe(0o700);
  expect((await lstat(root)).mode & 0o777).toBe(0o700);
  await chmod(root, 0o755);
  await expect(createWorkspaceDirectory("test", root)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await chmod(root, 0o700);
  const link = join(scratch, "link"); await symlink(root, link);
  await expect(createWorkspaceDirectory("test", link)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(createWorkspaceDirectory("test", "relative")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  const ram = await mkdtemp("/dev/shm/orbit-storage-test-");
  await expect(createWorkspaceDirectory("test", ram)).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

needsSymlink("a symlinked workspace root, which the sweep must refuse to follow")(
  "clean removes workspaces whose broker is gone and keeps live or recent ones", async () => {
  const { cleanWorkspaces, markWorkspaceOwner, brokerAnswers } = await import("../src/workspace-storage");
  const scratch = await mkdtemp(resolve("output/storage-clean-"));
  const root = join(scratch, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sockets = await mkdtemp(join(tmpdir(), "orbit-clean-sockets-"));
  // A live broker: something answers the doctor call on its socket.
  const answering = Bun.serve({ unix: join(sockets, "live.sock"), fetch: () => Response.json({ ok: true, result: {} }) });
  const live = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(live, join(sockets, "live.sock"));
  // An earlier managed broker: it recorded the fixed socket the live one now answers on, and a pid
  // that no process has. The socket alone would keep it forever.
  const predecessor = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(predecessor, join(sockets, "live.sock"), 4194304 + 7);
  // A dead broker: its socket file is gone, or is there with nothing behind it.
  const dead = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(dead, join(sockets, "dead.sock"));
  const stale = Bun.serve({ unix: join(sockets, "stale.sock"), fetch: () => new Response("x") });
  stale.stop(true);
  const staleSocket = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(staleSocket, join(sockets, "stale.sock"));
  // A socket something else answers on, not a broker.
  const foreign = Bun.serve({ unix: join(sockets, "foreign.sock"), fetch: () => new Response("not orbit", { status: 404 }) });
  const reused = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(reused, join(sockets, "foreign.sock"));
  // Directories from before the owner record: one recent, one old.
  const recent = await createWorkspaceDirectory("preview-test", root);
  const old = await createWorkspaceDirectory("session-test", root);
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(old, past, past);
  const link = join(root, "link"); await symlink(scratch, link);
  try {
    expect(await brokerAnswers(join(sockets, "live.sock"))).toBe(true);
    const result = await cleanWorkspaces(root);
    const name = (path: string) => path.slice(root.length + 1);
    expect(result.removed).toEqual([name(predecessor), name(dead), name(staleSocket), name(reused), name(old)].sort());
    expect(result.kept).toEqual([name(live), name(recent)].sort());
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await lstat(scratch)).isDirectory()).toBe(true);
    expect(await cleanWorkspaces(join(scratch, "missing"))).toMatchObject({ removed: [], kept: [], refused: [] });
  } finally { answering.stop(true); foreign.stop(true); }
});

test("one workspace that will not go does not end the sweep", async () => {
  const { cleanWorkspaces, markWorkspaceOwner, createWorkspaceDirectory } = await import("../src/workspace-storage");
  const { chmod, rm } = await import("node:fs/promises");
  const scratch = await mkdtemp(resolve("output/storage-refused-"));
  const root = join(scratch, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Two dead workspaces. The first one alphabetically holds a record nothing may unlink, which is
  // what a read-only path looks like from here, so its removal fails and the second one's must not.
  const stuck = await createWorkspaceDirectory("aaa-stuck", root);
  const ordinary = await createWorkspaceDirectory("zzz-ordinary", root);
  for (const directory of [stuck, ordinary]) await markWorkspaceOwner(directory, "/nowhere/broker.sock", 4194304 + 11);
  // Making a directory refuse removal is a different act on each kernel. POSIX drops write permission
  // on the parent record. Windows ignores that mode entirely, so the sweep would delete both and the
  // test would assert nothing: there a file is held OPEN inside it, which really does block removal.
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  if (process.platform === "win32") {
    // Node's `openSync` opens with delete sharing on Windows, so a handle held that way does NOT
    // block `rm`: the first attempt at this fix still deleted both workspaces. A running process with
    // its working directory inside the folder does block it, because a current directory is a real
    // reference the kernel enforces, and it needs no native call to arrange.
    holder = Bun.spawn(["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
      { cwd: stuck, stdout: "ignore", stderr: "ignore" });
    // The directory is only pinned once the child is actually up, so this waits for it to answer
    // rather than assuming a spawn is instant.
    for (let i = 0; i < 100 && !Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${holder.pid}").ProcessId`]).stdout.toString().trim(); i++)
      await Bun.sleep(50);
  } else {
    await chmod(stuck, 0o500);
  }
  try {
    const result = await cleanWorkspaces(root, async () => false);
    const name = (path: string) => path.slice(root.length + 1);
    // The sweep reached the second one, and named the first rather than dying on it.
    expect(result.refused.map(entry => entry.name)).toEqual([name(stuck)]);
    expect(result.refused[0]?.reason).toBeTruthy();
    expect(result.removed).toEqual([name(ordinary)]);
  } finally {
    if (holder) { holder.kill(); await holder.exited; }
    else await chmod(stuck, 0o700);
    await rm(scratch, { recursive: true, force: true });
  }
});

/**
 * The workspace root is where a multi gigabyte browser profile lands, so where it goes on each
 * platform is a decision rather than a default. Measured on a Windows 11 guest, 16 September 2026:
 * `createWorkspaceDirectory` refused every Windows host with "must be a private directory owned by
 * this user", because `process.getuid` is undefined there and `mode` is synthesised from the read
 * only attribute, so `mode & 0o077` tested nothing and failed anyway. See docs/windows-measured.md.
 */
test("the workspace root follows the platform's own private per user location", () => {
  // Linux, and anything else POSIX: the XDG cache home, or its documented default.
  expect(workspaceRoot({ XDG_CACHE_HOME: "/data/cache" } as NodeJS.ProcessEnv, "linux"))
    .toBe(posix.join("/data/cache", "sbar-orbit/workspaces"));
  // An explicit XDG_CACHE_HOME wins on every platform, which is what keeps the tests above portable.
  expect(workspaceRoot({ XDG_CACHE_HOME: "/data/cache", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv, "linux"))
    .toBe(posix.join("/data/cache", "sbar-orbit/workspaces"));
  // The Windows branch is asked DIRECTLY now, on any host. It used to be reachable only on win32, so
  // on Linux this test asserted the absence of the branch rather than its result, and the one path a
  // Windows user depends on was verified by inference. That is this project's own "not measured"
  // rule being bent inside the test for it.
  // `win32.join`, not `join`: the host's separator would build the Windows expectation with forward
  // slashes on Linux, which is asserting the very bug this file was fixed for.
  expect(workspaceRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv, "win32"))
    .toBe(win32.join("C:\\Users\\x\\AppData\\Local", "sbar-orbit", "workspaces"));
  // And LOCALAPPDATA alone must still not divert a POSIX host, which is the other half of the rule.
  // Asked with `posix.join`, not `join`: the host's separator would compare a backslash path against
  // a POSIX answer about Linux, which is the same mistake the darwin path builders made and the same
  // one this file's Windows branch exists to avoid asserting by inference.
  expect(workspaceRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", XDG_CACHE_HOME: "/data/cache" } as NodeJS.ProcessEnv, "linux"))
    .toBe(posix.join("/data/cache", "sbar-orbit/workspaces"));
  // macOS keeps regenerable per user data in ~/Library/Caches, asked in its own terms for the same reason.
  expect(workspaceRoot({} as NodeJS.ProcessEnv, "darwin")).toContain("Library/Caches");
});

/**
 * The sweep could not remove a workspace that held a restore point, and reported the reason as
 * "Read-only file system": a point is a read-only btrfs snapshot, and unlinking inside one answers
 * EROFS whatever the path's own permissions are. Measured on this workstation on 20 September 2026:
 * `clean` removed 141 of 192 workspaces and refused 21 with that message, leaving 107 GB of a 108 GB
 * cache in place. `src/restore.ts` has cleared the `ro` property before deleting a point since it was
 * written; the sweep simply never asked it to. Snapshots need btrfs, so this runs where the workspaces
 * actually live.
 */
const onBtrfs = await onBtrfsPath(workspaceRoot());
test.if(onBtrfs)("a workspace holding a read-only restore point is removed, not refused", async () => {
  const { cleanWorkspaces, createWorkspaceDirectory, markWorkspaceOwner } = await import("../src/workspace-storage");
  const { createSubvolume, takeRestorePoint } = await import("../src/restore");
  // Disk-backed, because `createWorkspaceDirectory` refuses a RAM-backed root and this fixture has to
  // be one it accepts. Snapshot subvolumes need btrfs too, so the base is where workspaces live.
  const scratch = await fixtureRoot("orbit-clean-restore-", join(homedir(), ".cache"));
  const root = join(scratch, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspace = await createWorkspaceDirectory("broker", root);
  // A broker nobody can reach, so the workspace is a candidate rather than a kept one.
  await markWorkspaceOwner(workspace, "/nowhere/broker.sock", 4194304 + 21);
  // The shape a killed broker leaves behind: a profile that is its own subvolume, with one read-only
  // point taken beside it.
  const profile = join(workspace, "profile");
  expect(await createSubvolume(profile)).toBe(true);
  // A file inside the subvolume BEFORE the point is taken. This is the whole difference: an empty
  // read-only snapshot has nothing in it to unlink, so `rm` removes it and the defect stays hidden.
  // The real ones held a browser profile, file by file.
  await writeFile(join(profile, "Preferences"), "before");
  const store = join(workspace, "restore-00000000-0000-0000-0000-000000000000");
  await mkdir(store, { recursive: true, mode: 0o700 });
  expect(await takeRestorePoint(profile, store, 1, "launch", true)).not.toBeNull();
  try {
    const result = await cleanWorkspaces(root);
    expect(result.refused).toEqual([]);
    expect(result.removed).toEqual([workspace.slice(root.length + 1)]);
    // The directory itself is gone, not merely reported as gone.
    await expect(lstat(workspace)).rejects.toThrow();
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
});
