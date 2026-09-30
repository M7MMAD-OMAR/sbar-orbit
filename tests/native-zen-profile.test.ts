import { linuxOnlySuite } from "./platform-support";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotZenProfile } from "../src/native-zen";

const test = linuxOnlySuite("native Flatpak Zen profile snapshots are a Linux private display feature");

function recovery(tabs: number): Buffer {
  const json = Buffer.from(JSON.stringify({ windows: [{ tabs: Array.from({ length: tabs }, () => ({ entries: [] })) }] }));
  const lengths: number[] = [];
  if (json.length >= 15) {
    let remaining = json.length - 15;
    while (remaining >= 255) { lengths.push(255); remaining -= 255; }
    lengths.push(remaining);
  }
  const header = Buffer.alloc(12);
  header.write("mozLz40\0", 0, "ascii");
  header.writeUInt32LE(json.length, 8);
  return Buffer.concat([header, Buffer.from([Math.min(json.length, 15) << 4, ...lengths]), json]);
}

async function fixture() {
  const root = await mkdtemp("/tmp/orbit-zen-fixture-");
  const source = join(root, "source"), privateParent = join(root, "private");
  await mkdir(source, { mode: 0o700 });
  await mkdir(privateParent, { mode: 0o700 });
  await mkdir(join(source, "sessionstore-backups"));
  await writeFile(join(source, "sessionstore-backups", "recovery.jsonlz4"), recovery(2));
  return { root, source, privateParent };
}

test("Zen snapshot preserves committed WAL data and recovery while excluding locks and sockets", async () => {
  const { root, source, privateParent } = await fixture();
  const database = new Database(join(source, "places.sqlite"), { create: true });
  const socket = createServer();
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE saved (label TEXT); INSERT INTO saved VALUES ('fixture');");
    await symlink("/tmp/another-process", join(source, "lock"));
    const socketPath = join(source, "ipc.sock");
    await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(socketPath, resolve));
    const result = await snapshotZenProfile(source, privateParent);
    expect(result.databases).toBe(1);
    expect(result.recoveryFiles).toBe(1);
    expect(result.recoveredTabs).toBe(2);
    expect(result.excluded).toBeGreaterThanOrEqual(2);
    expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(result.directory)).not.toContain("lock");
    expect(await readdir(result.directory)).not.toContain("ipc.sock");
    expect(await readdir(result.directory)).not.toContain("places.sqlite-wal");
    const copied = new Database(join(result.directory, "places.sqlite"), { readonly: true });
    try { expect(copied.query("SELECT label FROM saved").get()).toEqual({ label: "fixture" }); }
    finally { copied.close(); }
  } finally {
    database.close();
    await new Promise<void>(resolve => socket.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Zen snapshot rejects a corrupt SQLite database and removes the clone", async () => {
  const { root, source, privateParent } = await fixture();
  try {
    await writeFile(join(source, "places.sqlite"), "not a database");
    await expect(snapshotZenProfile(source, privateParent)).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    expect(await readdir(privateParent)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Zen snapshot rejects corrupt recovery data and removes the clone", async () => {
  const { root, source, privateParent } = await fixture();
  try {
    await writeFile(join(source, "sessionstore-backups", "recovery.jsonlz4"), Buffer.from("broken"));
    await expect(snapshotZenProfile(source, privateParent)).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    expect(await readdir(privateParent)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
