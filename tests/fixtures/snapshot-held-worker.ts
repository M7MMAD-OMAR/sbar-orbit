import { dlopen, ptr } from "bun:ffi";
import { snapshotArguments, snapshotIoctl, type SnapshotRequest } from "../../src/snapshot-ioctl";
const scope = globalThis as unknown as {
  postMessage(value: unknown): void;
  onmessage: ((event: MessageEvent<SnapshotRequest | { drain: true } | { gate: SharedArrayBuffer }>) => void) | null;
};
const library = dlopen("libc.so.6", {
  ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" }, gettid: { args: [], returns: "i32" },
});
let gate: Int32Array | undefined;
scope.onmessage = event => {
  const request = event.data;
  if ("gate" in request) { gate = new Int32Array(request.gate); return; }
  if ("drain" in request) { scope.postMessage({ drained: true }); return; }
  if (!gate) throw new Error("Missing held creation gate");
  // The callback is synchronously held. A queued drain cannot overtake the actual ioctl below.
  Atomics.wait(gate, 0, 0, 5000);
  const code = library.symbols.ioctl(request.destinationFd, BigInt(snapshotIoctl), ptr(snapshotArguments(request.sourceFd, request.name)));
  if (code !== 0) throw new Error("Controlled real Btrfs snapshot failed");
  scope.postMessage({ id: request.id, result: { status: "created" } });
};
scope.postMessage({ ready: true, tid: library.symbols.gettid() });
