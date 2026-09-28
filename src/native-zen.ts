import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { OrbitError } from "./errors";

export type ZenProfileSnapshot = {
  directory: string;
  files: number;
  bytes: number;
  databases: number;
  excluded: number;
  recoveryFiles: number;
  recoveredTabs: number | null;
};

const recoveryNames = [
  "sessionstore-backups/recovery.jsonlz4",
  "sessionstore-backups/recovery.baklz4",
  "sessionstore.jsonlz4",
];
const maximumRecoveryBytes = 64 * 1024 * 1024;

function decodeRecovery(input: Buffer): { windows: { tabs?: unknown[] }[] } {
  if (input.length < 12 || input.subarray(0, 8).toString("ascii") !== "mozLz40\0")
    throw new Error("Invalid Zen recovery header");
  const expected = input.readUInt32LE(8);
  if (expected > maximumRecoveryBytes) throw new Error("Zen recovery exceeds its size limit");
  const output = Buffer.alloc(expected);
  let read = 12, written = 0;
  const length = (initial: number) => {
    let value = initial;
    if (value === 15) {
      let part: number;
      do {
        if (read >= input.length) throw new Error("Truncated Zen recovery length");
        part = input[read++] ?? 0;
        value += part;
      } while (part === 255);
    }
    return value;
  };
  while (read < input.length) {
    const token = input[read++] ?? 0;
    const literal = length(token >>> 4);
    if (read + literal > input.length || written + literal > output.length)
      throw new Error("Invalid Zen recovery literal");
    input.copy(output, written, read, read + literal);
    read += literal;
    written += literal;
    if (read === input.length) break;
    if (read + 2 > input.length) throw new Error("Truncated Zen recovery offset");
    const offset = input.readUInt16LE(read);
    read += 2;
    if (offset === 0 || offset > written) throw new Error("Invalid Zen recovery offset");
    const match = length(token & 15) + 4;
    if (written + match > output.length) throw new Error("Invalid Zen recovery match");
    for (let index = 0; index < match; index++) {
      const value = output[written - offset];
      if (value === undefined) throw new Error("Invalid Zen recovery reference");
      output[written++] = value;
    }
  }
  if (written !== expected) throw new Error("Zen recovery length mismatch");
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
  if (!parsed || typeof parsed !== "object" || !("windows" in parsed) ||
      !Array.isArray(parsed.windows) || !parsed.windows.every(window => window && typeof window === "object"))
    throw new Error("Invalid Zen recovery JSON");
  return parsed as { windows: { tabs?: unknown[] }[] };
}

async function validateRecovery(directory: string): Promise<{ recoveryFiles: number; recoveredTabs: number | null }> {
  let recoveryFiles = 0;
  let recoveredTabs: number | null = null;
  for (const name of recoveryNames) {
    let input: Buffer;
    try { input = await readFile(join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (input.length > maximumRecoveryBytes) throw new Error("Zen recovery file exceeds its size limit");
    const recovery = decodeRecovery(input);
    recoveryFiles++;
    if (recoveredTabs === null)
      recoveredTabs = recovery.windows.reduce((sum, window) => sum + (Array.isArray(window.tabs) ? window.tabs.length : 0), 0);
  }
  return { recoveryFiles, recoveredTabs };
}

/** Copy a profile into a disposable private directory without opening the source with Zen. */
export async function snapshotZenProfile(sourceProfile: string, privateParent: string): Promise<ZenProfileSnapshot> {
  const source = resolve(sourceProfile);
  const parent = resolve(privateParent);
  const sourceEntry = await lstat(source);
  const parentEntry = await lstat(parent);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink() || !parentEntry.isDirectory() || parentEntry.isSymbolicLink())
    throw new OrbitError("UNSUPPORTED", "Zen snapshot needs real source and destination directories");
  const sourceReal = await realpath(source);
  const parentReal = await realpath(parent);
  if (parentReal === sourceReal || parentReal.startsWith(sourceReal + sep))
    throw new OrbitError("INVALID_REQUEST", "Zen snapshot destination cannot be inside its source");

  const directory = await mkdtemp(join(parent, "zen-profile-"));
  try {
    const helper = resolve(import.meta.dir, "native/zen_snapshot.py");
    const child = Bun.spawn(["/usr/bin/python3", helper, source, directory], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 300_000);
    let output: string;
    let exit: number;
    try {
      output = await new Response(child.stdout).text();
      exit = await child.exited;
    } finally { clearTimeout(timer); }
    if (exit !== 0) throw new OrbitError("BACKEND_FAILED", "Zen profile copy or SQLite validation failed");
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" ||
        !["files", "bytes", "databases", "excluded"].every(key => key in parsed &&
          typeof (parsed as Record<string, unknown>)[key] === "number"))
      throw new Error("Zen snapshot helper returned an invalid result");
    const counts = parsed as Pick<ZenProfileSnapshot, "files" | "bytes" | "databases" | "excluded">;
    return { directory, ...counts, ...await validateRecovery(directory) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof OrbitError) throw error;
    throw new OrbitError("BACKEND_FAILED", "Zen profile recovery validation failed");
  }
}
