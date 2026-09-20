import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/** Kernel lock: automatically released even when an updater is killed during a download or swap. */
export async function withUpdateLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  // Live update mutations are Linux only; other platforms exercise injected contracts in tests.
  if (process.platform !== "linux") return work();
  await mkdir(root, { recursive: true });
  const file = await open(join(root, ".update.lock"), "a", 0o600);
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const library = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    try {
      if (library.symbols.flock(file.fd, 2 | 4) !== 0) throw new Error("Another Orbit update operation is running; retry after it finishes");
      return await work();
    } finally { library.close(); }
  } finally { await file.close(); }
}
