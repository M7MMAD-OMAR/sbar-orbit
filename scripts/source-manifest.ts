import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isPublicSourcePath } from "./public-paths";

type VerifiedFile = { path: string; bytes: Buffer; executable: boolean };
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

/** Validate an extracted release and retain the exact bytes approved for copying. */
export async function readVerifiedSource(root: string): Promise<{ version: string; files: VerifiedFile[] }> {
  const directory = await realpath(root);
  async function regular(path: string, maxBytes: number) {
    const parts = path.split("/");
    let current = directory;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > maxBytes))
        throw new Error("Source manifest input must be a bounded regular file without linked parents");
    }
    const info = await lstat(current), bytes = await readFile(current);
    if (bytes.length > maxBytes) throw new Error("Source manifest input exceeds size limit");
    // Windows has no execute bit: `lstat` reports 0o666 for every file it stores, so this would call
    // every launcher non executable and a release repackaged there would ship one that cannot run on
    // the machine it is installed to. The bit is a property of the RELEASE, not of the filesystem the
    // release happens to be sitting on, so on Windows it is taken from the manifest's own list of
    // executables rather than invented from a mode the kernel never recorded.
    return { bytes, executable: process.platform === "win32" ? null : Boolean(info.mode & 0o111) };
  }
  const value: unknown = JSON.parse((await regular("SOURCE-MANIFEST.json", 1024 * 1024)).bytes.toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source manifest");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.version !== "string" || !versionPattern.test(manifest.version) || !Array.isArray(manifest.files) ||
    !manifest.files.length || manifest.files.length > 5000) throw new Error("Invalid source manifest");
  const paths = new Set<string>();
  const entries: { path: string; sha256: string; executable?: boolean }[] = [];
  // Validate all names before opening any listed source file.
  for (const value of manifest.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source manifest entry");
    const entry = value as Record<string, unknown>;
    if (!isPublicSourcePath(entry.path) || entry.path === "SOURCE-MANIFEST.json" || paths.has(entry.path) ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid source manifest entry");
    // Optional, so an older manifest still reads. When absent the filesystem answers, which is right
    // on POSIX and is why every release published so far verifies unchanged.
    if (entry.executable !== undefined && typeof entry.executable !== "boolean") throw new Error("Invalid source manifest entry");
    paths.add(entry.path); entries.push({ path: entry.path, sha256: entry.sha256, executable: entry.executable });
  }
  if (!["package.json", "LICENSE", "NOTICE", "bin/sbar-orbit"].every(path => paths.has(path)))
    throw new Error("Source manifest is missing required release files");
  const files: VerifiedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const file = await regular(entry.path, 10 * 1024 * 1024);
    total += file.bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error("Source manifest exceeds total size limit");
    if (createHash("sha256").update(file.bytes).digest("hex") !== entry.sha256) throw new Error("Source manifest content mismatch");
    // The manifest wins where it speaks, since it is the release's own record of what is executable.
    // Where it is silent the filesystem answers, and on Windows the filesystem cannot: a release
    // extracted there has no execute bits at all, so a manifest without them is refused rather than
    // repackaged into one that ships a launcher nobody can run.
    const executable = entry.executable ?? file.executable;
    if (executable === null)
      throw new Error(`Source manifest must record executable bits to be read on a filesystem without them: ${entry.path}`);
    files.push({ path: entry.path, bytes: file.bytes, executable });
  }
  const pkg = JSON.parse(files.find(file => file.path === "package.json")?.bytes.toString() ?? "null");
  if (!pkg || pkg.name !== "sbar-orbit" || pkg.version !== manifest.version) throw new Error("Source manifest version mismatch");
  return { version: manifest.version, files };
}
