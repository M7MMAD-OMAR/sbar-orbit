import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { OrbitError } from "./errors";

export function managedUpdateRoot() {
  // A prepared broker binds admission to its own release root, including custom
  // account data homes. Caller environment must not redirect its barrier check.
  const source = resolve(import.meta.dir);
  const versions = dirname(dirname(source));
  if (dirname(source).match(/[/\\]versions[/\\]\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/) && versions.endsWith("versions"))
    return dirname(versions);
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sbar-orbit");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "sbar-orbit");
}

/** Every broker consults persistent admission, including a fresh successor. */
export async function requireUpdateAdmission(root = managedUpdateRoot()) {
  try { await lstat(join(root, "activation-recovery.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new OrbitError("PROFILE_BUSY", `Update recovery admission could not be established: ${String(error)}`);
  }
  throw new OrbitError("PROFILE_BUSY", "Update recovery is pending; new sessions and native openings require deliberate recovery");
}
