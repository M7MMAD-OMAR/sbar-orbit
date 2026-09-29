import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { guardDisposablePaginatedRead, StalePaginatedReadError } from "./codex-paginated-stale-guard";

async function fakeWalFixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-stale-guard-"));
  await mkdir(join(root, "sessions"));
  await Bun.write(join(root, "sessions", "fake.jsonl"), '{"type":"fake"}\n');
  const state = new Database(join(root, "state_5.sqlite"));
  const history = new Database(join(root, "thread_history_1.sqlite"));
  for (const db of [state, history]) {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    db.exec("CREATE TABLE fixture (value TEXT NOT NULL)");
    db.query("INSERT INTO fixture (value) VALUES (?)").run("initial");
  }
  return { root, state, history,
    close: async () => { history.close(); state.close(); await rm(root, { recursive: true }); } };
}

async function sourceState(root: string) {
  const result: Record<string, { sha256?: string; modified: string; changed: string; size: number }> = {};
  for (const name of [...await readdir(root), "sessions/fake.jsonl"]) {
    const path = join(root, name);
    const info = await lstat(path, { bigint: true });
    result[name] = { modified: String(info.mtimeNs), changed: String(info.ctimeNs),
      size: Number(info.size), ...(info.isFile() ?
        { sha256: createHash("sha256").update(await readFile(path)).digest("hex") } : {}) };
  }
  return result;
}

test("stable fake WAL page read keeps watched source files unchanged", async () => {
  const fixture = await fakeWalFixture();
  try {
    const before = await sourceState(fixture.root);
    const value = await guardDisposablePaginatedRead(fixture.root, async () => "fake page");
    const after = await sourceState(fixture.root);
    expect(value).toBe("fake page");
    expect(after).toEqual(before);
  } finally { await fixture.close(); }
});

test("fake owner WAL write during page read fails closed", async () => {
  const fixture = await fakeWalFixture();
  try {
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = guardDisposablePaginatedRead(fixture.root, async () => {
      started?.();
      await held;
      return "stale page";
    });
    await entered;
    fixture.history.query("UPDATE fixture SET value = ?").run("owner write");
    const afterOwnerWrite = await sourceState(fixture.root);
    release?.();
    await expect(read).rejects.toBeInstanceOf(StalePaginatedReadError);
    expect(await sourceState(fixture.root)).toEqual(afterOwnerWrite);
  } finally { await fixture.close(); }
});

test("fake owner WAL write and logical revert still fails closed", async () => {
  const fixture = await fakeWalFixture();
  try {
    await expect(guardDisposablePaginatedRead(fixture.root, async () => {
      fixture.history.query("UPDATE fixture SET value = ?").run("temporary");
      fixture.history.query("UPDATE fixture SET value = ?").run("initial");
      return "stale page";
    })).rejects.toBeInstanceOf(StalePaginatedReadError);
  } finally { await fixture.close(); }
});

test("unchanging cross-store mismatch remains undetectable", async () => {
  const fixture = await fakeWalFixture();
  try {
    fixture.state.query("UPDATE fixture SET value = ?").run("new generation");
    const state = fixture.state.query("SELECT value FROM fixture").get() as { value: string };
    const history = fixture.history.query("SELECT value FROM fixture").get() as { value: string };
    const value = await guardDisposablePaginatedRead(fixture.root, async () =>
      ({ state: state.value, history: history.value }));
    expect(value).toEqual({ state: "new generation", history: "initial" });
  } finally { await fixture.close(); }
});
