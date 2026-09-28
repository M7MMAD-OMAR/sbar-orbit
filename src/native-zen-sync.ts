import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { OrbitError } from "./errors";

const syncPreference = '\nuser_pref("services.sync.username", "");\n';

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Keep a private Zen copy from presenting the source profile's Mozilla Sync device.
 * Website cookies and saved website logins stay in their separate profile files.
 */
export async function quietZenSync(cloneProfile: string, sourceProfile: string): Promise<void> {
  const [cloneEntry, sourceEntry] = await Promise.all([lstat(cloneProfile), lstat(sourceProfile)]);
  if (!cloneEntry.isDirectory() || cloneEntry.isSymbolicLink() ||
      !sourceEntry.isDirectory() || sourceEntry.isSymbolicLink())
    throw new OrbitError("UNSUPPORTED", "Zen Sync isolation needs real profile directories");

  const [clone, source] = await Promise.all([realpath(cloneProfile), realpath(sourceProfile)]);
  if (clone === source || clone.startsWith(source + sep) || source.startsWith(clone + sep) ||
      (cloneEntry.dev === sourceEntry.dev && cloneEntry.ino === sourceEntry.ino))
    throw new OrbitError("INVALID_REQUEST", "Zen Sync isolation must only change a separate private copy");

  const accountPath = join(clone, "signedInUser.json");
  const userPath = join(clone, "user.js");
  const [accountEntry, userEntry, sourceUserEntry] = await Promise.all([
    existingEntry(accountPath), existingEntry(userPath), existingEntry(join(source, "user.js")),
  ]);
  if (accountEntry && (!accountEntry.isFile() || accountEntry.isSymbolicLink()))
    throw new OrbitError("UNSUPPORTED", "Zen account record in the private copy is not a regular file");
  if (userEntry && (!userEntry.isFile() || userEntry.isSymbolicLink() || userEntry.nlink !== 1))
    throw new OrbitError("UNSUPPORTED", "Zen private user.js must be an unshared regular file");

  const handle = await open(userPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 ||
        (sourceUserEntry && opened.dev === sourceUserEntry.dev && opened.ino === sourceUserEntry.ino))
      throw new OrbitError("UNSUPPORTED", "Zen private user.js must be an unshared regular file");

    if (accountEntry) await unlink(accountPath);
    await handle.writeFile(syncPreference, "utf8");
    await handle.chmod(0o600);
    await handle.sync();

    const currentUser = await lstat(userPath);
    if (!currentUser.isFile() || currentUser.dev !== opened.dev || currentUser.ino !== opened.ino ||
        await existingEntry(accountPath))
      throw new OrbitError("BACKEND_FAILED", "Zen private Sync state changed while preparing the copy");
  } finally {
    await handle.close();
  }
}
