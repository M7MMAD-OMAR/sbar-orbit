import { snapshotArguments, snapshotIoctl, type SnapshotRequest, type SnapshotResult } from "./snapshot-ioctl";

const scope = globalThis as unknown as {
  postMessage(value: unknown): void;
  onmessage: ((event: MessageEvent<SnapshotRequest | { drain: true }>) => void) | null;
};
const ffi = await import("bun:ffi");
let execute: ((destinationFd: number, bytes: Uint8Array) => { code: number; errno: number }) | undefined;
let tid = 0;
try {
  const library = ffi.dlopen("libc.so.6", {
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
    gettid: { args: [], returns: "i32" },
  });
  const errnoPointer = library.symbols.__errno_location();
  if (errnoPointer === null || typeof errnoPointer === "bigint") throw new Error("Unsupported errno pointer");
  const errnoView = new DataView(ffi.toArrayBuffer(errnoPointer, 0, 4));
  tid = library.symbols.gettid();
  if (!Number.isSafeInteger(tid) || tid <= 0) throw new Error("Missing Linux worker task identity");
  execute = (fd, bytes) => {
    const code = library.symbols.ioctl(fd, BigInt(snapshotIoctl), ffi.ptr(bytes));
    return { code, errno: code === 0 ? 0 : errnoView.getInt32(0, true) };
  };
} catch (error) {
  scope.postMessage({ ready: false, reason: error instanceof Error ? error.message : "FFI unavailable" });
}

function snapshot(request: SnapshotRequest): SnapshotResult {
  try {
    if (!execute) return { status: "failed", phase: "worker", reason: "Worker unavailable after admission" };
    const bytes = snapshotArguments(request.sourceFd, request.name);
    // The kernel validates the two admitted descriptors belong to the same Btrfs filesystem.
    // Different subvolumes have different anonymous st_dev values even on that filesystem.
    const result = execute(request.destinationFd, bytes);
    if (result.code !== 0) return { status: "failed", phase: "ioctl", errno: result.errno, reason: "Btrfs snapshot ioctl failed" };
    return { status: "created" };
  } catch (error) {
    return { status: "failed", phase: "ioctl", reason: error instanceof Error ? error.message : "Snapshot failed" };
  }
}
if (execute) {
  scope.onmessage = event => {
    const request = event.data;
    if ("drain" in request) {
      // The parent sends this after it stops admission. All preceding synchronous ioctls have returned.
      scope.postMessage({ drained: true });
      return;
    }
    scope.postMessage({ id: request.id, result: snapshot(request) });
  };
  scope.postMessage({ ready: true, tid });
}
