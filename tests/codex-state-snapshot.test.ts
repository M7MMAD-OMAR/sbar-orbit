import { linuxOnlySuite } from "./platform-support";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const test = linuxOnlySuite("native Codex state snapshots require Linux reflinks and Python helpers");

const snapshotScript = resolve(import.meta.dir, "../src/native/codex_state_snapshot.py");

async function fixture(withHistory = true) {
  const root = await mkdtemp(join(process.cwd(), ".orbit-codex-state-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "sessions", "2026", "09", "28"), { recursive: true });
  await mkdir(join(source, "archived_sessions"));
  await mkdir(destination);
  const current = join(source, "sessions", "2026", "09", "28", "current.jsonl");
  const archived = join(source, "archived_sessions", "old.jsonl");
  await writeFile(current, '{"type":"fixture","value":"current"}\n');
  await writeFile(archived, '{"type":"fixture","value":"archived"}\n');
  await writeFile(join(source, ".codex-global-state.json"), '{"local-projects":{"legacy-id":{}},"project-order":["legacy-id"]}\n');
  await writeFile(join(source, "config.toml"), 'model = "fixture"\n');
  const database = new Database(join(source, "state_5.sqlite"), { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL);");
  database.query("INSERT INTO projects (id) VALUES (?)").run("new-id");
  database.query("INSERT INTO threads (id, rollout_path, history_mode) VALUES (?, ?, ?)")
    .run("thread-current", current, "paginated");
  database.query("INSERT INTO threads (id, rollout_path, history_mode) VALUES (?, ?, ?)")
    .run("thread-old", archived, "paginated");
  let historyDatabase: Database | undefined;
  if (withHistory) {
    historyDatabase = new Database(join(source, "thread_history_1.sqlite"), { create: true });
    historyDatabase.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    historyDatabase.exec("CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER)");
    historyDatabase.query("INSERT INTO thread_history_projection_state VALUES (?, ?, ?)")
      .run("thread-current", Buffer.byteLength('{"type":"fixture","value":"current"}\n'), 1);
  }
  return { root, source, destination, database, historyDatabase, current, archived };
}

async function runSnapshot(source: string, destination: string) {
  const process = Bun.spawn(["/usr/bin/python3", snapshotScript, source, destination],
    { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

test("Codex state snapshot keeps WAL rows and creates writable private rollout reflinks", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.current);
    const sourceHash = sha256(original);
    const databaseHash = sha256(await readFile(join(f.source, "state_5.sqlite")));
    const walHash = sha256(await readFile(join(f.source, "state_5.sqlite-wal")));
    const historyHash = sha256(await readFile(join(f.source, "thread_history_1.sqlite")));
    const historyWalHash = sha256(await readFile(join(f.source, "thread_history_1.sqlite-wal")));
    const result = await runSnapshot(f.source, f.destination);
    if (result.exitCode !== 0) {
      expect(result.stderr).toContain("reflink-capable private destination");
      expect(await readdir(f.destination)).toEqual([]);
      return;
    }
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ projects: 1, threads: 2, paginatedThreads: 2, rollouts: 2,
      atomicAcrossStores: false });
    expect(report.historyBytes).toBeGreaterThan(0);
    expect(await readFile(join(f.destination, ".codex-global-state.json"), "utf8"))
      .toContain("legacy-id");
    expect(await readFile(join(f.destination, "config.toml"), "utf8")).toBe('model = "fixture"\n');
    const copy = new Database(join(f.destination, "state_5.sqlite"), { readonly: true });
    try {
      expect(copy.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 2 });
    } finally { copy.close(); }
    const historyCopy = new Database(join(f.destination, "thread_history_1.sqlite"), { readonly: true });
    try {
      expect(historyCopy.query("SELECT count(*) AS count FROM thread_history_projection_state").get())
        .toEqual({ count: 1 });
    } finally { historyCopy.close(); }
    const privateCurrent = join(f.destination, "sessions", "2026", "09", "28", "current.jsonl");
    await writeFile(privateCurrent, '{"type":"private"}\n');
    expect(sha256(await readFile(f.current))).toBe(sourceHash);
    expect(sha256(await readFile(join(f.source, "state_5.sqlite")))).toBe(databaseHash);
    expect(sha256(await readFile(join(f.source, "state_5.sqlite-wal")))).toBe(walHash);
    expect(sha256(await readFile(join(f.source, "thread_history_1.sqlite")))).toBe(historyHash);
    expect(sha256(await readFile(join(f.source, "thread_history_1.sqlite-wal")))).toBe(historyWalHash);
    expect(await readFile(privateCurrent, "utf8")).toBe('{"type":"private"}\n');
  } finally {
    f.database.close();
    f.historyDatabase?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex state snapshot rejects linked source files without changing them", async () => {
  const f = await fixture();
  try {
    await rm(join(f.source, "config.toml"));
    await symlink(f.current, join(f.source, "config.toml"));
    const sourceHash = sha256(await readFile(f.current));
    const result = await runSnapshot(f.source, f.destination);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsafe or oversized Codex source");
    expect(await readdir(f.destination)).toEqual([]);
    expect(sha256(await readFile(f.current))).toBe(sourceHash);
  } finally {
    f.database.close();
    f.historyDatabase?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex state snapshot rejects database paths missing from its private rollout tree", async () => {
  const f = await fixture();
  try {
    f.database.query("INSERT INTO threads (id, rollout_path, history_mode) VALUES (?, ?, ?)")
      .run("missing", join(f.source, "sessions", "missing.jsonl"), "paginated");
    const result = await runSnapshot(f.source, f.destination);
    if (result.stderr.includes("missing rollout")) {
      expect(result.stderr).toContain("missing rollout");
    } else {
      expect(result.stderr).toContain("reflink-capable private destination");
    }
    expect(result.exitCode).not.toBe(0);
    expect(await readdir(f.destination)).toEqual([]);
  } finally {
    f.database.close();
    f.historyDatabase?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex state snapshot retries a transient source change and cleans the failed attempt", async () => {
  const f = await fixture();
  try {
    const code = `import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dir, "../src/native"))})
import codex_state_snapshot as snapshot
original = snapshot.read_stable
calls = 0
def transient(path, limit):
    global calls
    calls += 1
    if calls == 3:
        raise snapshot.SourceChangedError("fixture source change")
    return original(path, limit)
snapshot.read_stable = transient
print(json.dumps(snapshot.snapshot(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))))`;
    const process = Bun.spawn(["/usr/bin/python3", "-c", code, f.source, f.destination],
      { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      expect(stderr).toContain("reflink-capable private destination");
      return;
    }
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ attempts: 2, projects: 1, threads: 2 });
    expect(await readdir(f.destination)).toContain("state_5.sqlite");
  } finally {
    f.database.close();
    f.historyDatabase?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex state snapshot requires a history database for paginated threads", async () => {
  const f = await fixture(false);
  try {
    const result = await runSnapshot(f.source, f.destination);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("paginated threads need their history database");
    expect(await readdir(f.destination)).toEqual([]);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex state snapshot rejects a linked history database", async () => {
  const f = await fixture(false);
  try {
    await symlink(join(f.source, "state_5.sqlite"), join(f.source, "thread_history_1.sqlite"));
    const result = await runSnapshot(f.source, f.destination);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsafe or oversized Codex source: thread_history_1.sqlite");
    expect(await readdir(f.destination)).toEqual([]);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
