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
  const { cleanWorkspaces, markWorkspaceOwner, brokerAnswers } = await import("../src/workspace-storage");
  const scratch = await mkdtemp(resolve("output/storage-clean-"));
  const root = join(scratch, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sockets = await mkdtemp("/tmp/orbit-clean-sockets-");
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
    expect(await cleanWorkspaces(join(scratch, "missing"))).toMatchObject({ removed: [], kept: [] });
  } finally { answering.stop(true); foreign.stop(true); }
});
