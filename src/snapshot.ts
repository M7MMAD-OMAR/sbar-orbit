import { constants } from "node:fs";
import { open, realpath, lstat, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { snapshotArguments, type SnapshotResult, type SnapshotReply } from "./snapshot-ioctl";

type ReferencedWorker = Worker & Pick<Bun.Worker, "ref" | "unref">;
function supportsWorkerLifetime(worker: Worker): worker is ReferencedWorker {
  return "ref" in worker && typeof worker.ref === "function" &&
    "unref" in worker && typeof worker.unref === "function";
}

type Endpoint = { request(sourceFd: number, destinationFd: number, name: string): Promise<SnapshotResult>; unavailable?: string; failed?: string };
let endpoint: Promise<Endpoint> | undefined;
function taskStart(stat: string): string {
  const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("Invalid Linux worker task identity");
  return start;
}
function unavailable(reason: string): Endpoint {
  return { unavailable: reason, request: async () => ({ status: "unavailable", reason }) };
}
function failedWorker(reason: string): Endpoint {
  return { failed: reason, request: async () => ({ status: "failed", phase: "worker", reason }) };
}
function start(): Promise<Endpoint> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    return Promise.resolve(unavailable("Unsupported ioctl ABI"));
  return new Promise(resolve => {
    let candidate: Worker;
    try { candidate = new Worker(new URL("./snapshot-worker.ts", import.meta.url).href, { smol: true, ref: true }); }
    catch (error) { resolve(unavailable(error instanceof Error ? error.message : "Worker unavailable")); return; }
    const acquired = candidate;
    const rejectAcquired = (message: string) => {
      let reason = `${message}; worker termination requested, cleanup not confirmed`;
      try { acquired.terminate(); } // No descriptor or ioctl request has been admitted.
      catch { reason = `${message}; worker termination failed, cleanup not confirmed`; }
      resolve(failedWorker(reason));
    };
    let admitted: ReferencedWorker | undefined;
    try { if (supportsWorkerLifetime(acquired)) admitted = acquired; }
    catch { rejectAcquired("Snapshot worker lifetime controls could not be inspected"); return; }
    if (!admitted) { rejectAcquired("Snapshot worker lifetime controls are unavailable"); return; }
    const worker = admitted;
    let ready = false;
    let broken = false;
    let reason = "Snapshot worker has failed";
    let sequence = 0;
    let task: { path: string; start: string } | undefined;
    const pending = new Map<number, (result: SnapshotResult) => void>();
    const startupTimer = setTimeout(() => fail("Snapshot worker startup timed out before admission"), 3000);
    const settleFailed = () => {
      for (const complete of pending.values()) complete({ status: "failed", phase: "worker", reason });
      pending.clear();
      worker.unref();
    };
    const fail = (message: string) => {
      if (broken) return;
      broken = true; reason = message;
      clearTimeout(startupTimer);
      if (!ready) {
        resolve(unavailable(reason));
        worker.terminate(); // No descriptor or ioctl request has been admitted.
      } else {
        // Do not complete admitted requests on error or terminate an active ioctl.
        // An ordered drain acknowledgment proves all previously sent ioctls returned.
        try { worker.postMessage({ drain: true }); } catch {}
      }
    };
    worker.onerror = event => { event.preventDefault(); fail("Snapshot worker failed"); };
    worker.onmessageerror = () => fail("Snapshot worker reply could not be decoded");
    worker.addEventListener("close", () => {
      fail("Snapshot worker exited");
      if (!pending.size) return;
      // A close callback alone is not a kernel drain witness. Keep FileHandles and session.tail held
      // until the exact Linux task is gone or its start identity has changed. Unknown stays pending.
      void (async () => {
        if (!task) return;
        while (pending.size) {
          try {
            if (taskStart(await readFile(task.path, "utf8")) !== task.start) { settleFailed(); return; }
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
              settleFailed(); return;
            }
          }
          await Bun.sleep(10);
        }
      })();
    });
    worker.onmessage = (event: MessageEvent<SnapshotReply | { ready: boolean; tid?: number; reason?: string } | { drained: true }>) => {
      const reply = event.data;
      if ("ready" in reply) {
        if (!reply.ready) { fail(reply.reason ?? "FFI unavailable"); return; }
        if (broken || ready) return;
        const tid = reply.tid;
        if (!Number.isSafeInteger(tid) || tid === undefined || tid <= 0) { fail("Invalid worker task identity"); return; }
        void (async () => {
          try {
            const path = `/proc/${process.pid}/task/${tid}/stat`;
            const identity = { path, start: taskStart(await readFile(path, "utf8")) };
            if (broken || ready) return;
            task = identity; ready = true; clearTimeout(startupTimer); worker.unref();
            resolve({ request: (sourceFd, destinationFd, name) => {
              if (broken) return Promise.resolve({ status: "failed", phase: "worker", reason });
              const id = ++sequence;
              return new Promise(complete => {
                pending.set(id, complete); worker.ref();
                try { worker.postMessage({ id, sourceFd, destinationFd, name }); }
                catch { fail("Snapshot request delivery failed"); }
              });
            } });
          } catch { fail("Worker task identity could not be bound before admission"); }
        })();
        return;
      }
      if ("drained" in reply) {
        if (!broken) return;
        settleFailed();
        worker.terminate(); // Every admitted ioctl returned before the drain acknowledgment.
        return;
      }
      if (broken) return; // A lost acknowledgment is a failure, not permission to repeat creation.
      pending.get(reply.id)?.(reply.result);
      pending.delete(reply.id);
      if (!pending.size) worker.unref();
    };
  });
}

async function directSnapshot(profile: string, store: string, name: string): Promise<SnapshotResult> {
  endpoint ??= start();
  const driver = await endpoint;
  if (driver.unavailable) return { status: "unavailable", reason: driver.unavailable };
  if (driver.failed) return { status: "failed", phase: "worker", reason: driver.failed };
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let phase: "validation" | "open" = "validation";
  try {
    snapshotArguments(0, name);
    const canonicalProfile = await realpath(profile);
    const canonicalStore = await realpath(store);
    phase = "open";
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
    source = await open(canonicalProfile, flags);
    destination = await open(canonicalStore, flags);
    phase = "validation";
    const sourceInfo = await source.stat();
    const destinationInfo = await destination.stat();
    const sourcePath = await lstat(profile);
    const destinationPath = await lstat(store);
    const uid = process.getuid?.();
    if (uid === undefined || sourceInfo.uid !== uid || destinationInfo.uid !== uid ||
        !sourceInfo.isDirectory() || !destinationInfo.isDirectory() ||
        !sourcePath.isDirectory() || !destinationPath.isDirectory() ||
        sourcePath.isSymbolicLink() || destinationPath.isSymbolicLink() || sourceInfo.ino !== 256 ||
        (sourceInfo.mode & 0o077) !== 0 || (destinationInfo.mode & 0o077) !== 0 ||
        sourceInfo.ino !== sourcePath.ino || sourceInfo.dev !== sourcePath.dev ||
        destinationInfo.ino !== destinationPath.ino || destinationInfo.dev !== destinationPath.dev)
      throw new Error("Snapshot directory ownership or identity refused");
    try {
      await lstat(join(store, name));
      return { status: "failed", phase, errno: 17, reason: "Snapshot target already exists" };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Each descriptor is checked against its own path. Cross-descriptor st_dev equality is invalid
    // for Btrfs subvolumes. SNAP_CREATE_V2 rejects different actual filesystems in the kernel.
    return await driver.request(source.fd, destination.fd, name);
  } catch (error) {
    return { status: "failed", phase, reason: error instanceof Error ? error.message : "Snapshot failed" };
  } finally {
    const handles = [source, destination].filter((held): held is FileHandle => held !== undefined);
    await Promise.all(handles.map(handle => handle.close()));
  }
}

/** Compatibility fallback is allowed only when no ioctl request was admitted. */
export async function createReadOnlySnapshot(profile: string, store: string, name: string,
  fallback: () => Promise<boolean>, direct: () => Promise<SnapshotResult> = () => directSnapshot(profile, store, name),
): Promise<boolean> {
  const result = await direct();
  if (result.status === "unavailable") return fallback();
  return result.status === "created";
}
