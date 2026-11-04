import { test, expect } from "bun:test";
import { Sessions } from "../src/session";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedUpdateRoot, requireUpdateAdmission } from "../src/update-admission";
import { defaultLauncherPath } from "../src/update";
import { stateDirectory } from "../src/service";
import { workspaceRoot } from "../src/workspace-storage";

test("ordinary application state and workspace metadata do not occupy the managed runtime root", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orbit-runtime-root-"));
  const keys = ["LOCALAPPDATA", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.LOCALAPPDATA = join(fixture, "local");
    process.env.XDG_DATA_HOME = join(fixture, "data");
    process.env.XDG_STATE_HOME = join(fixture, "state");
    process.env.XDG_CACHE_HOME = join(fixture, "cache");
    const state = stateDirectory(), workspaces = workspaceRoot(), runtime = managedUpdateRoot();
    await mkdir(state, { recursive: true }); await mkdir(workspaces, { recursive: true });
    const preferences = join(state, "owner-fixture-preferences.json");
    await writeFile(preferences, '{"preserve":true}');
    expect(await lstat(runtime).catch(error => { if (error.code === "ENOENT") return null; throw error; })).toBeNull();
    if (process.platform === "win32") {
      expect(runtime).toBe(join(state, "managed"));
      expect(workspaces).toBe(join(state, "workspaces"));
      expect(defaultLauncherPath()).toBe(join(runtime, "bin", "sbar-orbit.cmd"));
    } else expect(runtime).toBe(join(fixture, "data", "sbar-orbit"));
    await requireUpdateAdmission(runtime);
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "activation-recovery.json"), '{"phase":"pending"}');
    await expect(requireUpdateAdmission(runtime)).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    expect(await readFile(preferences, "utf8")).toBe('{"preserve":true}');
    expect((await lstat(workspaces)).isDirectory()).toBe(true);
  } finally {
    for (const key of keys) { const value = prior[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(fixture, { recursive: true, force: true });
  }
});

test("an update lease blocks new sessions until its owner releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-update-admission-"));
  const sessions = new Sessions(root);
  try {
    const lease = await sessions.dispatch({ method: "update.begin" }) as { token: string };
    expect(lease.token).toBeString();
    await expect(sessions.create({ backend: "unsupported" })).rejects.toThrow("update");
    await expect(sessions.dispatch({ method: "update.begin" })).rejects.toThrow("update");
    await sessions.dispatch({ method: "update.end", params: { token: "wrong" } });
    await expect(sessions.create({ backend: "unsupported" })).rejects.toThrow("update");
    await sessions.dispatch({ method: "update.end", params: { token: lease.token } });
    await expect(sessions.create({ backend: "unsupported" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
