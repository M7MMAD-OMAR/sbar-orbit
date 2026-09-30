import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preparePrivateNextcloudConfig, privateNextcloudSourceUnchanged } from "./nextcloud-private-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(bytes: string) {
  const root = await mkdtemp("/var/tmp/orbit-nextcloud-config-controls-"); roots.push(root);
  const source = join(root, "source.cfg"), directory = join(root, "nextcloud-config"), destination = join(directory, "nextcloud.cfg");
  await mkdir(directory, { mode: 0o700 }); await writeFile(source, bytes, { mode: 0o600 });
  return { root, source, destination };
}

test("private copy retains opaque account values and removes all three flat folder groups", async () => {
  const bytes = "[General]\nclientVersion=34.0.3\n[Accounts]\nversion=13\n0\\url=https://fixture.invalid\n0\\opaque=@ByteArray(A\\nB)\n0\\Folders\\one\\localPath=/fixture/one\n0\\Multifolders\\two\\localPath=/fixture/two\n0\\FoldersWithPlaceholders\\three\\localPath=/fixture/three\n";
  const paths = await fixture(bytes);
  const result = await preparePrivateNextcloudConfig(paths.source, paths.destination);
  expect(result.accounts).toBe(1); expect(result.removedFolderSettings).toBe(3); expect(result.keptAccountSettings).toBe(2);
  const copy = await readFile(paths.destination, "utf8");
  expect(copy).toContain("0\\opaque=@ByteArray(A\\nB)\n");
  expect(copy).toContain("0\\url=https://fixture.invalid\n"); expect(copy).not.toContain("/fixture/");
  expect(await readFile(paths.source, "utf8")).toBe(bytes);
  expect(await privateNextcloudSourceUnchanged(paths.source, result)).toBe(true);
  await writeFile(paths.source, bytes + "changed=true\n");
  expect(await privateNextcloudSourceUnchanged(paths.source, result)).toBe(false);
});

test("grouped folder sections are removed without moving later values into the wrong section", async () => {
  const paths = await fixture("[Accounts/opaque-id]\nurl=https://fixture.invalid\n[Accounts/opaque-id/Folders/one]\nlocalPath=/fixture/one\n[Accounts/opaque-id/General]\nCaCertificates=@ByteArray(public-fixture)\n[Accounts/opaque-id/Multifolders/two]\nlocalPath=/fixture/two\n[Accounts/opaque-id/FoldersWithPlaceholders/three]\nlocalPath=/fixture/three\n[General]\nlaunchOnSystemStartup=false\n");
  const result = await preparePrivateNextcloudConfig(paths.source, paths.destination);
  expect(result.removedFolderSettings).toBe(3); expect(result.accounts).toBe(1);
  const copy = await readFile(paths.destination, "utf8");
  expect(copy).not.toContain("localPath"); expect(copy).not.toContain("/Folders/");
  expect(copy).toContain("[Accounts/opaque-id/General]\nCaCertificates=@ByteArray(public-fixture)\n");
  expect(copy).toContain("[General]\nlaunchOnSystemStartup=false\n");
});

test("source symlinks and overwriting a prepared destination are rejected", async () => {
  const paths = await fixture("[Accounts]\n0\\url=https://fixture.invalid\n");
  const linked = join(paths.root, "linked.cfg"); await symlink(paths.source, linked);
  await expect(preparePrivateNextcloudConfig(linked, paths.destination)).rejects.toThrow();
  await preparePrivateNextcloudConfig(paths.source, paths.destination);
  const before = await readFile(paths.destination);
  await expect(preparePrivateNextcloudConfig(paths.source, paths.destination)).rejects.toThrow();
  expect(await readFile(paths.destination)).toEqual(before);
});
