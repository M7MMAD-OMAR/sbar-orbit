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
