import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { createSubvolume, takeRestorePoint, restoreProfile, clearRestorePoints, removeRestorePoint } from "../src/restore";

// This is an admission gate, not a platform skip. Run on an owned Btrfs fixture after preparation.
test.if(process.env.ORBIT_TEST_SNAPSHOT_IOCTL === "1")("production snapshots precede mutation without a per action subprocess, and restore parity holds", async () => {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("This regression requires the Linux ioctl ABI");
  const root = await createWorkspaceDirectory("snapshot-production-test");
  const profile = join(root, "profile");
  const store = join(root, "points");
  await mkdir(profile, { mode: 0o700 });
  let spawnCalls = 0;
  const originalSpawn = Bun.spawn;
  try {
    expect(await createSubvolume(profile)).toBe(true);
    await writeFile(join(profile, "Preferences"), "before");
    // Count the actual production entry path. Baseline invokes btrfs here and fails zero spawn.
    Bun.spawn = ((...args: unknown[]) => {
      spawnCalls++;
      return Reflect.apply(originalSpawn, Bun, args);
    }) as typeof Bun.spawn;
    const first = await takeRestorePoint(profile, store, 1, "read");
    expect(first).not.toBeNull();
    expect(spawnCalls).toBe(0);
    if (!first) throw new Error("A missing production snapshot cannot pass this gate");
    expect(first.consistent).toBe(false);
    expect(await readFile(join(first.path, "Preferences"), "utf8")).toBe("before");
    await expect(writeFile(join(first.path, "Preferences"), "forbidden point mutation")).rejects.toMatchObject({ code: "EROFS" });
    await writeFile(join(profile, "Preferences"), "after");
    await writeFile(join(profile, "new-file"), "after");
    expect(await readFile(join(first.path, "Preferences"), "utf8")).toBe("before");
    // Existing target must refuse without changing it or invoking the compatibility CLI.
    expect(await takeRestorePoint(profile, store, 1, "read")).toBeNull();
    expect(spawnCalls).toBe(0);
    expect(await readFile(join(first.path, "Preferences"), "utf8")).toBe("before");
    Bun.spawn = originalSpawn;
    expect(await restoreProfile(profile, first)).toBe(true);
    expect(await readFile(join(profile, "Preferences"), "utf8")).toBe("before");
    await expect(lstat(join(profile, "new-file"))).rejects.toThrow();
    const afterRestore = await takeRestorePoint(profile, store, 2, "resize", true);
    expect(afterRestore?.consistent).toBe(true);
    expect((await clearRestorePoints(store)).left).toEqual([]);
  } finally {
    Bun.spawn = originalSpawn;
    expect((await clearRestorePoints(store)).left).toEqual([]);
    expect(await removeRestorePoint(profile)).toBe(true);
    expect(await removeRestorePoint(root)).toBe(true);
    await expect(lstat(store)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test.if(process.env.ORBIT_TEST_SNAPSHOT_IOCTL === "1")("guarded action sees its own completed predecessor point and keeps it on failure", async () => {
  const { Sessions } = await import("../src/session");
  const root = await createWorkspaceDirectory("snapshot-guarded-test");
  const profile = join(root, "profile");
  const store = join(root, "points");
  await mkdir(profile, { mode: 0o700 });
  const session = {
    id: "fixture", state: "running", profile, restoreStore: store, journal: [{}], restorePoints: [] as { path: string }[],
    backend: { act: async () => {
      const point = session.restorePoints.at(-1);
      if (!point) throw new Error("Backend ran without a completed predecessor snapshot");
      expect(await readFile(join(point.path, "Preferences"), "utf8")).toBe("before");
      await writeFile(join(profile, "Preferences"), "failed action wrote");
      throw new Error("controlled action failure");
    } },
  };
  const guarded = Sessions.prototype as unknown as { guarded(session: unknown, action: { type: string }): Promise<unknown> };
  try {
    expect(await createSubvolume(profile)).toBe(true);
    await writeFile(join(profile, "Preferences"), "before");
    await expect(guarded.guarded.call({
      ensureOpen: (held: { state: string }) => { if (held.state !== "running") throw new Error("closed"); },
      taintedBy: () => {},
    }, session, { type: "read" })).rejects.toThrow("controlled action failure");
    expect(session.restorePoints.length).toBe(1);
    const point = session.restorePoints.at(-1);
    if (!point) throw new Error("Failed action lost its predecessor snapshot");
    expect(await readFile(join(point.path, "Preferences"), "utf8")).toBe("before");
  } finally {
    expect((await clearRestorePoints(store)).left).toEqual([]);
    expect(await removeRestorePoint(profile)).toBe(true);
    expect(await removeRestorePoint(root)).toBe(true);
    await expect(lstat(store)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test.if(process.env.ORBIT_TEST_SNAPSHOT_IOCTL === "1")("stop admitted during snapshot prevents backend action after completion", async () => {
  const { Sessions } = await import("../src/session");
  const root = await createWorkspaceDirectory("snapshot-stop-test");
  const profile = join(root, "profile");
  const store = join(root, "points");
  await mkdir(profile, { mode: 0o700 });
  let actions = 0;
  const session = {
    id: "fixture", state: "running", profile, restoreStore: store, journal: [{}], restorePoints: [] as { path: string }[],
    backend: { act: async () => { actions++; return {}; } },
  };
  const guarded = Sessions.prototype as unknown as { guarded(session: unknown, action: { type: string }): Promise<unknown> };
  try {
    expect(await createSubvolume(profile)).toBe(true);
    const work = guarded.guarded.call({
      ensureOpen: (held: { state: string }) => { if (held.state !== "running") throw new Error("closed"); },
      taintedBy: () => {},
    }, session, { type: "read" });
    // takeRestorePoint is already waiting for filesystem work. Close is admitted before it settles.
    session.state = "closing";
    await expect(work).rejects.toThrow("closed");
    expect(actions).toBe(0);
    expect(session.restorePoints.length).toBe(1);
  } finally {
    expect((await clearRestorePoints(store)).left).toEqual([]);
    expect(await removeRestorePoint(profile)).toBe(true);
    expect(await removeRestorePoint(root)).toBe(true);
    await expect(lstat(store)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test.if(process.env.ORBIT_TEST_SNAPSHOT_IOCTL === "1")("real session stop drains accepted and queued actions before private snapshot cleanup", async () => {
  const { Sessions } = await import("../src/session");
  const root = await createWorkspaceDirectory("snapshot-stop-queue-test");
  const sessions = new Sessions(root);
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined;
  const admission = new Promise<void>(resolve => { entered = resolve; });
  try {
    const session = await run("session.create", { backend: "browser" }) as { sessionId: string };
    const held = (sessions as unknown as { sessions: Map<string, {
      profile: string; restoreStore: string; restorePoints: { path: string }[];
      backend: { act(action: unknown): Promise<unknown> };
    }> }).sessions.get(session.sessionId);
    if (!held) throw new Error("Owned real session missing");
    const originalAct = held.backend.act.bind(held.backend);
    let backendCalls = 0;
    held.backend.act = async action => {
      backendCalls++;
      expect(held.restorePoints.length).toBe(1);
      entered?.();
      await gate;
      return originalAct(action);
    };
    const first = run("session.act", { ...session, requestId: "held-first", action: { type: "resize", width: 900, height: 700 } });
    // Attach rejection collection before close so controlled backend failure is never unhandled.
    const firstSettled = first.then(() => "fulfilled", () => "rejected");
    await admission;
    const queued = run("session.act", { ...session, requestId: "held-second", action: { type: "resize", width: 901, height: 701 } });
    const queuedSettled = queued.then(() => "fulfilled", () => "rejected");
    let stopped = false;
    const stop = run("session.stop", session).then(result => { stopped = true; return result; });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    release?.();
    await stop;
    expect(await queuedSettled).toBe("rejected");
    await firstSettled;
    expect(backendCalls).toBe(1);
    await expect(lstat(held.restoreStore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(held.profile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release?.();
    await sessions.close();
    expect(await removeRestorePoint(root)).toBe(true);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 15000);
