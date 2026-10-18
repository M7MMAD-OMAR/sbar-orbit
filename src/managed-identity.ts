import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const RELEASE_IDENTITY = "orbit-release-identity.json";
export type ReleaseIdentity = { schema: 1; version: string; releaseDigest: string; runtime: string; runtimeDigest: string; archiveIntegrity: string | null };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const inputs = ["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"];

/** Hash shipped regular files in deterministic path order, independent of the staging name. */
export async function releaseDigest(directory: string) {
  for (const relative of ["package.json", "bun.lock", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "src/cli.ts", "src/mcp.ts", "scripts/limited.ts"]) {
    const info = await lstat(join(directory, relative));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Incomplete release input: ${relative}`);
  }
  const entries: [string, string][] = [];
  async function visit(relative: string, required = false) {
    const path = join(directory, relative);
    const info = await lstat(path).catch(error => { if (!required && error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Release input must not be a symbolic link: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`, true);
    } else if (info.isFile()) entries.push([relative, digest(await readFile(path))]);
    else throw new Error(`Release input must be regular: ${relative}`);
  }
  for (const name of inputs) await visit(name, ["package.json", "bun.lock", "bin", "src", "scripts"].includes(name));
  return digest(JSON.stringify(entries));
}

export async function sealRelease(directory: string, version: string, runtime = process.env.ORBIT_BUN ?? process.execPath, archiveIntegrity: string | null = null) {
  if (!isAbsolute(runtime) || !(await lstat(runtime)).isFile() || await realpath(runtime) !== runtime)
    throw new Error("Release runtime must be a canonical absolute regular executable");
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "sbar-orbit" || manifest.version !== version) throw new Error("Release manifest identity differs");
  const record: ReleaseIdentity = { schema: 1, version, archiveIntegrity, releaseDigest: await releaseDigest(directory), runtime, runtimeDigest: digest(await readFile(runtime)) };
  await writeFile(join(directory, RELEASE_IDENTITY), JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  return record;
}

/** A launcher alone is never a complete prepared release. Older installs require deliberate migration. */
export async function preparedIdentity(root: string, version: string): Promise<ReleaseIdentity> {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) throw new Error("Invalid release version");
  const versions = join(resolve(root), "versions"), directory = join(versions, version);
  if (await realpath(versions) !== versions || await realpath(directory) !== directory)
    throw new Error("Prepared versions must be canonical directories in the admitted root");
  const path = join(directory, RELEASE_IDENTITY);
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error("Missing regular release identity; migrate deliberately");
  const record: ReleaseIdentity = JSON.parse(await readFile(path, "utf8"));
  if (record.schema !== 1 || record.version !== version || Object.keys(record).sort().join(",") !== "archiveIntegrity,releaseDigest,runtime,runtimeDigest,schema,version" ||
    !(record.archiveIntegrity === null || typeof record.archiveIntegrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.archiveIntegrity)) ||
    !/^[a-f0-9]{64}$/.test(record.releaseDigest) || !/^[a-f0-9]{64}$/.test(record.runtimeDigest) ||
    !isAbsolute(record.runtime) || await realpath(record.runtime) !== record.runtime || !(await lstat(record.runtime)).isFile())
    throw new Error("Malformed release or exact runtime identity");
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "sbar-orbit" || manifest.version !== version || await releaseDigest(directory) !== record.releaseDigest || digest(await readFile(record.runtime)) !== record.runtimeDigest)
    throw new Error("Prepared release or runtime bytes changed; migrate deliberately");
  return record;
}

export async function pointerVersion(root: string, target: string) {
  const versions = join(resolve(root), "versions"), candidate = resolve(target);
  if (!isAbsolute(target) || dirname(candidate) !== versions || candidate !== target || await realpath(candidate) !== candidate)
    throw new Error("Pointer must name one canonical prepared version in its own managed root");
  const version = candidate.slice(versions.length + 1);
  await preparedIdentity(root, version);
  return version;
}

export type BrokerIdentity = ReleaseIdentity & { root: string; directory: string };

/** Snapshot once at broker construction. Doctor must not relabel old loaded code after a file edit. */
export async function brokerIdentity(source = import.meta.dir, runtime = process.execPath): Promise<BrokerIdentity | null> {
  const directory = dirname(resolve(source)), versions = dirname(directory);
  if (versions !== join(dirname(versions), "versions")) return null;
  const root = dirname(versions), version = directory.slice(versions.length + 1);
  const identity = await preparedIdentity(root, version);
  if (runtime !== identity.runtime || await realpath(runtime) !== runtime || digest(await readFile(runtime)) !== identity.runtimeDigest)
    throw new Error("Executing broker runtime differs from the prepared release");
  return { ...identity, root, directory };
}

export function sameBrokerIdentity(actual: unknown, expected: BrokerIdentity) {
  if (!actual || typeof actual !== "object") return false;
  const record = actual as Record<string, unknown>;
  return Object.keys(expected).every(key => record[key] === expected[key as keyof BrokerIdentity]);
}

/** Synchronous counterpart for connector configuration, which must select a verified interpreter. */
export function preparedIdentitySync(root: string, version: string): ReleaseIdentity {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) throw new Error("Invalid release version");
  const versions = join(resolve(root), "versions"), directory = join(versions, version);
  if (realpathSync(versions) !== versions || realpathSync(directory) !== directory) throw new Error("Prepared directory differs from its admitted root");
  const path = join(directory, RELEASE_IDENTITY), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Missing regular release identity");
  const record: ReleaseIdentity = JSON.parse(readFileSync(path, "utf8"));
  if (record.schema !== 1 || record.version !== version || Object.keys(record).sort().join(",") !== "archiveIntegrity,releaseDigest,runtime,runtimeDigest,schema,version" ||
    !(record.archiveIntegrity === null || typeof record.archiveIntegrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.archiveIntegrity)) ||
    !/^[a-f0-9]{64}$/.test(record.releaseDigest) || !/^[a-f0-9]{64}$/.test(record.runtimeDigest) ||
    !isAbsolute(record.runtime) || realpathSync(record.runtime) !== record.runtime || !lstatSync(record.runtime).isFile()) throw new Error("Malformed release identity");
  for (const relative of ["package.json", "bun.lock", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "src/cli.ts", "src/mcp.ts", "scripts/limited.ts"])
    if (!lstatSync(join(directory, relative)).isFile()) throw new Error("Incomplete release inputs");
  const entries: [string, string][] = [];
  function visit(relative: string, required = false) {
    const location = join(directory, relative);
    let item;
    try { item = lstatSync(location); } catch (error) { if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (item.isSymbolicLink()) throw new Error("Release inputs must not be redirected");
    if (item.isDirectory()) for (const name of readdirSync(location).sort()) visit(`${relative}/${name}`, true);
    else if (item.isFile()) entries.push([relative, digest(readFileSync(location))]);
    else throw new Error("Release inputs must be regular");
  }
  for (const name of inputs) visit(name, ["package.json", "bun.lock", "bin", "src", "scripts"].includes(name));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "sbar-orbit" || manifest.version !== version || digest(JSON.stringify(entries)) !== record.releaseDigest || digest(readFileSync(record.runtime)) !== record.runtimeDigest)
    throw new Error("Prepared release or runtime bytes changed");
  return record;
}
