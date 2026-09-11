import { test, expect } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";

test("workspace storage creates unique private directories and rejects unsafe or RAM-backed roots", async () => {
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

test("clean removes workspaces whose broker is gone and keeps live or recent ones", async () => {
  const { cleanWorkspaces, markWorkspaceOwner } = await import("../src/workspace-storage");
  const scratch = await mkdtemp(resolve("output/storage-clean-"));
  const root = join(scratch, "workspaces");
  const procRoot = join(scratch, "proc");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // A live broker: its pid and command line are present under the fake proc root.
  const live = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(live, 4242);
  await mkdir(join(procRoot, "4242"), { recursive: true });
  await Bun.write(join(procRoot, "4242/cmdline"), [...process.argv.slice(0, 2), "serve"].join("\x00") + "\x00");
  // A dead broker: its pid is gone.
  const dead = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(dead, 4243);
  // A reused pid: alive, but running something else.
  const reused = await createWorkspaceDirectory("broker", root);
  await markWorkspaceOwner(reused, 4244);
  await mkdir(join(procRoot, "4244"), { recursive: true });
  await Bun.write(join(procRoot, "4244/cmdline"), "/usr/bin/sleep\x00100\x00");
  // Directories from before the owner record: one recent, one old.
  const recent = await createWorkspaceDirectory("preview-test", root);
  const old = await createWorkspaceDirectory("session-test", root);
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(old, past, past);
  const link = join(root, "link"); await symlink(scratch, link);
  const result = await cleanWorkspaces(root, { procRoot });
  const name = (path: string) => path.slice(root.length + 1);
  expect(result.removed).toEqual([name(dead), name(reused), name(old)].sort());
  expect(result.kept).toEqual([name(live), name(recent)].sort());
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect((await lstat(scratch)).isDirectory()).toBe(true);
  expect(await cleanWorkspaces(join(scratch, "missing"))).toMatchObject({ removed: [], kept: [] });
});
