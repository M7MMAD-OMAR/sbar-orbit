import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";

test.skipIf(process.platform !== "win32").each([true, false])("owned profile cleanup handles a real Windows lock (release: %s)", async release => {
  const workspace = await createWorkspaceDirectory("profile-lock-proof");
  const profile = await mkdtemp(join(workspace, "profile-"));
  const sessions = new Sessions(workspace);
  // SetCurrentDirectory holds this owned directory open until the child exits.
  const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("ready\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
    { cwd: profile, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const failures: unknown[] = [];
  try {
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
    finally { reader.releaseLock(); }
    // This is the exact ineffective deletion operation from a7673ad, while the lock remains held.
    const baseline = performance.now();
    await expect(rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })).rejects.toMatchObject({ code: "EBUSY" });
    console.error(JSON.stringify({windowsProfileCleanup:"legacy-retry-options-rejected",elapsedMs:Math.round(performance.now()-baseline)}));
    if (release) releaseTimer = setTimeout(() => child.stdin.end(), 250);
    const started = performance.now();
    if (release) {
      await sessions["removeProfile"](profile);
      await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(sessions["removeProfile"](profile)).rejects.toMatchObject({ code: "EBUSY" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(3500);
      expect((await stat(profile)).isDirectory()).toBe(true);
    }
  } catch (error) { failures.push(error); }
  finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    try { child.stdin.end(); } catch (error) { failures.push(error); }
    const awaitExit = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([child.exited, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Owned lock fixture did not exit")), 3000);
        })]);
      } finally { if (timeout) clearTimeout(timeout); }
    };
    try {
      await awaitExit();
    } catch (error) {
      failures.push(error);
      try { child.kill(); await awaitExit(); } catch (error) { failures.push(error); }
    }
    try { await sessions.close(); } catch (error) { failures.push(error); }
    try { await sessions["removeProfile"](workspace); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Windows lock proof or cleanup failed");
}, 15000);
