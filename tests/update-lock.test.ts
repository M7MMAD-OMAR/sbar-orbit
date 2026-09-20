import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withUpdateLock } from "../src/update-lock";

test.skipIf(process.platform !== "linux")("update mutations exclude concurrent callers and release the kernel lock after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-update-lock-"));
  try {
    await withUpdateLock(root, async () => {
      await expect(withUpdateLock(root, async () => 1)).rejects.toThrow("Another Orbit update");
    });
    await expect(withUpdateLock(root, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
    expect(await withUpdateLock(root, async () => 2)).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
