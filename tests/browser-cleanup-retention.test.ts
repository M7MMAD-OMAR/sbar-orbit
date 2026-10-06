import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserBackend } from "../src/browser";
import { OwnedCleanupError } from "../src/owned-cleanup";
import * as restore from "../src/restore";
const { Sessions } = await import(process.env.ORBIT_SESSION_CLEANUP_SOURCE || "../src/session");

test("failed owned cleanup retains the startup profile and lease until a retry confirms exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-owned-cleanup-"));
  const snapshot = spyOn(restore, "createSubvolume").mockResolvedValue(false);
  let confirmed = false;
  const retry = async () => { if (!confirmed) throw new Error("fixture exit unconfirmed"); };
  const failure = new OwnedCleanupError(new Error("fixture startup failed"), new Error("fixture cleanup uncertain"), retry);
  const launch = spyOn(BrowserBackend, "create").mockRejectedValue(failure);
  const sessions = new Sessions(root);
  try {
    await expect(sessions.create({ backend: "browser", profileKey: "fixture-key" })).rejects.toBe(failure);
    expect((await readdir(root)).filter(name => name.startsWith("profile-"))).toHaveLength(1);
    await expect(sessions.create({ backend: "browser", profileKey: "fixture-key" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    await expect(sessions.close()).rejects.toThrow("exit unconfirmed");
    expect((await readdir(root)).filter(name => name.startsWith("profile-"))).toHaveLength(1);
    confirmed = true;
    await sessions.close();
    expect((await readdir(root)).filter(name => name.startsWith("profile-"))).toHaveLength(0);
  } finally {
    confirmed = true;
    await sessions.close();
    launch.mockRestore(); snapshot.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("an active stop failure cannot skip retained startup cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-cleanup-shutdown-"));
  const sessions = new Sessions(root);
  let retries = 0;
  Object.assign(sessions, { sessions: new Map([["fixture-active", {}]]),
    pendingBrowserCleanup: new Map([["fixture-startup", async () => { retries++; }]]) });
  const stop = spyOn(sessions, "stop").mockRejectedValue(new Error("fixture active stop failed"));
  try {
    await expect(sessions.close()).rejects.toThrow("active stop failed");
    expect(retries).toBe(1);
  } finally {
    stop.mockRestore();
    Object.assign(sessions, { sessions: new Map(), pendingBrowserCleanup: new Map() });
    await sessions.close(); await rm(root, { recursive: true, force: true });
  }
});
