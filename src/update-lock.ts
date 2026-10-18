import { mkdir, open, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Kernel lock: automatically released even when an updater is killed during a download or swap. */
export async function withUpdateLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  if (process.platform !== "linux") {
    await mkdir(root, { recursive: true });
    const lock = join(root, ".update-lock");
    // A crash leaves an explicit barrier. Never infer that an unknown owner stopped.
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Managed update lock is held or needs deliberate recovery");
      throw error;
    }
    try { return await work(); } finally { await rmdir(lock); }
  }
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
