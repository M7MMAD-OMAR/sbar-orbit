import { expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { createSubvolume, clearRestorePoints, removeRestorePoint } from "../src/restore";
import { createReadOnlySnapshot } from "../src/snapshot";

// Run this file alone in a fresh bounded test process. The driver singleton must be uninitialized.
test.if(process.env.ORBIT_TEST_SNAPSHOT_IOCTL === "1")("failed delivery waits for held real creation drain and parent fd closure before cleanup", async () => {
  const root = await createWorkspaceDirectory("snapshot-drain-test");
  const profile = join(root, "profile");
  const store = join(root, "points");
  const OriginalWorker = globalThis.Worker;
  const gate = new SharedArrayBuffer(4);
  const gateView = new Int32Array(gate);
  let requestSent: (() => void) | undefined;
  const admitted = new Promise<void>(resolve => { requestSent = resolve; });
  let descriptors: number[] = [];
  let heldWorker: Worker | undefined;
  let settled = false;
  let pendingWork: Promise<boolean> | undefined;
  try {
    await mkdir(profile, { mode: 0o700 });
    await mkdir(store, { mode: 0o700 });
    expect(await createSubvolume(profile)).toBe(true);
    await writeFile(join(profile, "Preferences"), "before");
    globalThis.Worker = (function (_url: string, options: WorkerOptions) {
      const worker = new OriginalWorker(new URL("./fixtures/snapshot-held-worker.ts", import.meta.url).href, options);
      heldWorker = worker;
      const post = worker.postMessage.bind(worker);
      post({ gate });
      worker.postMessage = (message: unknown) => {
        post(message);
        if (message && typeof message === "object" && "sourceFd" in message && "destinationFd" in message) {
          descriptors = [Number(message.sourceFd), Number(message.destinationFd)];
          requestSent?.();
          worker.dispatchEvent(new MessageEvent("messageerror"));
        }
      };
      return worker;
    }) as unknown as typeof Worker;
    const work = createReadOnlySnapshot(profile, store, "000001-read", async () => { throw new Error("Admitted failure must not use CLI fallback"); });
    pendingWork = work;
    const observed = work.then(result => { settled = true; return result; });
    await admitted;
    await Bun.sleep(30);
    expect(settled).toBe(false);
    expect(descriptors.length).toBe(2);
    for (const fd of descriptors) expect(fstatSync(fd).isDirectory()).toBe(true);
    await expect(lstat(join(store, "000001-read"))).rejects.toMatchObject({ code: "ENOENT" });
    Atomics.store(gateView, 0, 1); Atomics.notify(gateView, 0);
    expect(await observed).toBe(false);
    expect(await readFile(join(store, "000001-read", "Preferences"), "utf8")).toBe("before");
    await expect(writeFile(join(store, "000001-read", "Preferences"), "forbidden")).rejects.toMatchObject({ code: "EROFS" });
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow();
    expect((await clearRestorePoints(store)).left).toEqual([]);
    await Bun.sleep(30);
    await expect(lstat(store)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    globalThis.Worker = OriginalWorker;
    Atomics.store(gateView, 0, 1); Atomics.notify(gateView, 0);
    await pendingWork?.catch(() => false);
    heldWorker?.terminate();
    expect((await clearRestorePoints(store)).left).toEqual([]);
    expect(await removeRestorePoint(profile)).toBe(true);
    expect(await removeRestorePoint(root)).toBe(true);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 15000);
