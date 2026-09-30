import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const folderGroups = new Set(["folders", "multifolders", "folderswithplaceholders"]);
const parts = (value: string): string[] => value.split(/[\\/]/).filter(Boolean);
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface PrivateNextcloudConfig {
  accounts: number;
  removedFolderSettings: number;
  keptAccountSettings: number;
  sourceDigest: string;
  sourceDevice: number;
  sourceInode: number;
}

async function ownedConfig(path: string): Promise<{ bytes: Buffer; device: number; inode: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.uid !== process.getuid?.() || identity.size > 1024 * 1024)
      throw new Error("Nextcloud source must be a bounded regular file owned by this user");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const bytes = buffer.subarray(0, used);
    const after = await handle.stat();
    if (bytes.length > 1024 * 1024 || bytes.length !== identity.size || after.size !== identity.size || after.mtimeMs !== identity.mtimeMs)
      throw new Error("Nextcloud source changed during its read");
    return { bytes, device: identity.dev, inode: identity.ino };
  } finally { await handle.close(); }
}

export async function preparePrivateNextcloudConfig(source: string, destination: string): Promise<PrivateNextcloudConfig> {
  if (resolve(source) === resolve(destination) ||
      !/^\/var\/tmp\/orbit-nextcloud-[^/]+\/nextcloud-config\/nextcloud\.cfg$/.test(destination))
    throw new Error("Nextcloud destination must be a new disposable probe configuration");
  const parent = await lstat(dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077))
    throw new Error("Nextcloud destination directory must be private and owned");
  const original = await ownedConfig(source);
  const text = original.bytes.toString("utf8");
  if (!Buffer.from(text).equals(original.bytes)) throw new Error("Nextcloud source encoding is unsupported");
  const accounts = new Set<string>();
  let section: string[] = [], removedFolderSettings = 0, keptAccountSettings = 0;
  const kept: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) section = parts(trimmed.slice(1, -1));
    const assignment = !trimmed.startsWith(";") && !trimmed.startsWith("#") && trimmed.includes("=");
    const key = assignment ? parts(trimmed.slice(0, trimmed.indexOf("="))) : [];
    const hierarchy = [...section, ...key];
    const isFolder = hierarchy.some(part => folderGroups.has(part.toLowerCase()));
    const accountId = hierarchy[0] === "Accounts" && hierarchy.length > 2 ? hierarchy[1] : undefined;
    if (assignment && accountId) accounts.add(accountId);
    if (isFolder) { if (assignment) removedFolderSettings++; continue; }
    if (assignment && accountId) keptAccountSettings++;
    kept.push(line);
  }
  if (!accounts.size || !keptAccountSettings) throw new Error("Nextcloud source has no retained account settings");
  const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const identity = await target.stat();
    if (identity.dev === original.device && identity.ino === original.inode)
      throw new Error("Nextcloud destination aliases the source");
    await target.writeFile(kept.join("")); await target.sync();
  } finally { await target.close(); }
  return { accounts: accounts.size, removedFolderSettings, keptAccountSettings,
    sourceDigest: digest(original.bytes), sourceDevice: original.device, sourceInode: original.inode };
}

export async function privateNextcloudSourceUnchanged(source: string, snapshot: PrivateNextcloudConfig): Promise<boolean> {
  const current = await ownedConfig(source);
  return current.device === snapshot.sourceDevice && current.inode === snapshot.sourceInode && digest(current.bytes) === snapshot.sourceDigest;
}
