import { open, lstat, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OrbitError } from "./errors";

export type NativePreferenceSnapshot = "copied" | "absent";

/** Copy GSettings preferences into the private session without sharing the user's D-Bus. */
export async function seedNativePreferences(targetConfigHome: string): Promise<NativePreferenceSnapshot> {
  const sourceConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const source = join(sourceConfigHome, "dconf", "user");
  const target = join(targetConfigHome, "dconf", "user");
  for (let attempt = 0; attempt < 3; attempt++) {
    let file;
    try { file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new OrbitError("UNSUPPORTED", "The GSettings database is not a regular file");
      if (before.size > 16 * 1024 * 1024)
        throw new OrbitError("LIMIT_REACHED", "The GSettings database is too large for a native session snapshot");
      const contents = await file.readFile();
      const after = await file.stat();
      const current = await lstat(source);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs) continue;
      await mkdir(join(targetConfigHome, "dconf"), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: 0o600 });
      return "copied";
    } finally { await file.close(); }
  }
  throw new OrbitError("BACKEND_FAILED", "The GSettings database changed during the native session snapshot");
}
