import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import type { PaginatedPageRequest } from "../src/codex-authority-gate";
import { createDisposablePaginatedReader } from "./codex-paginated-bwrap-bridge";
import { guardDisposablePaginatedRead, StalePaginatedReadError } from "./codex-paginated-stale-guard";

const EXPECTED_HELPER_SHA256 = "6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd";

async function watchedFiles(root: string) {
  const names: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const info = await lstat(path, { bigint: true });
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) names.push(relative(root, path));
      else throw new Error("Disposable fixture contains a special file");
    }
  };
  await walk(root);
  names.sort();
  return Object.fromEntries(await Promise.all(names.map(async name => {
    const path = join(root, name);
    const info = await lstat(path, { bigint: true });
    return [name, { sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs),
      inode: String(info.ino) }] as const;
  })));
}

async function main() {
  const [fakeRoot, binary] = process.argv.slice(2);
  if (!fakeRoot?.startsWith("/var/tmp/codex-private-smoke-w/owner-codex-orbit-") || !binary)
    throw new Error("Pass the retained disposable fake owner and exact helper binary");
  const binaryHash = createHash("sha256").update(await readFile(binary)).digest("hex");
  if (binaryHash !== EXPECTED_HELPER_SHA256)
    throw new Error("Unexpected disposable helper binary");
  const root = await mkdtemp("/tmp/orbit-paginated-wal-stale-");
  const fixture = join(root, "fixture");
  let state: Database | undefined;
  let history: Database | undefined;
  try {
    await mkdir(fixture, { mode: 0o700 });
    await cp(join(fakeRoot, "sessions"), join(fixture, "sessions"), { recursive: true });
    for (const base of ["state_5.sqlite", "thread_history_1.sqlite"])
      for (const suffix of ["", "-wal", "-shm"])
        if (await Bun.file(join(fakeRoot, base + suffix)).exists())
          await cp(join(fakeRoot, base + suffix), join(fixture, base + suffix));
    state = new Database(join(fixture, "state_5.sqlite"));
    history = new Database(join(fixture, "thread_history_1.sqlite"));
    state.exec("PRAGMA wal_autocheckpoint=0");
    history.exec("PRAGMA wal_autocheckpoint=0");
    const row = state.query("SELECT id, rollout_path FROM threads WHERE history_mode = 'paginated' LIMIT 1")
      .get() as { id: string; rollout_path: string } | null;
    if (!row) throw new Error("Fake fixture has no paginated thread");
    const suffix = relative(join(fakeRoot, "sessions"), row.rollout_path);
    if (suffix.startsWith("..") || suffix === "") throw new Error("Fake rollout path escaped sessions");
    state.query("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(join("/fixture/sessions", suffix), row.id);
    const reader = await createDisposablePaginatedReader(binary, fixture);
    const request: PaginatedPageRequest = { method: "thread/turns/list", params: {
      threadId: row.id, readOnly: true, limit: 5, cursor: null,
      sortDirection: "asc", itemsView: "full" } };

    const stableBefore = await watchedFiles(fixture);
    const stablePage = await guardDisposablePaginatedRead(fixture, () => reader(request));
    const stableAfter = await watchedFiles(fixture);
    const pageText = JSON.stringify(stablePage);
    if (JSON.stringify(stableBefore) !== JSON.stringify(stableAfter) ||
        !pageText.includes("Private fixture conversation") ||
        !pageText.includes("Orbit completed fixture answer"))
      throw new Error("Stable fake WAL page failed content or integrity check");

    let writes = 0;
    let writerFailure: unknown;
    let afterWriter: Awaited<ReturnType<typeof watchedFiles>> | undefined;
    let stale = false;
    try {
      await guardDisposablePaginatedRead(fixture, async () => {
        const pending = reader(request);
        const timer = setInterval(() => {
          try {
            history?.query("UPDATE thread_turns SET duration_ms = COALESCE(duration_ms, 0) + 1 WHERE thread_id = ?")
              .run(row.id);
            writes++;
          } catch (error) { writerFailure = error; }
        }, 2);
        try { return await pending; }
        finally { clearInterval(timer); afterWriter = await watchedFiles(fixture); }
      });
    } catch (error) { if (error instanceof StalePaginatedReadError) stale = true; else throw error; }
    if (writerFailure) throw writerFailure;
    if (!stale || writes < 1 || !afterWriter)
      throw new Error("Writer overlap did not produce a measured stale failure");
    const afterRejectedRead = await watchedFiles(fixture);
    if (JSON.stringify(afterWriter) !== JSON.stringify(afterRejectedRead))
      throw new Error("Reader changed fixture after writer stopped");
    const changed = Object.keys(stableAfter).filter(name =>
      JSON.stringify(stableAfter[name]) !== JSON.stringify(afterRejectedRead[name]));
    if (!changed.some(name => name.startsWith("thread_history_1.sqlite")) ||
        changed.some(name => name.startsWith("state_5.sqlite") || name.startsWith("sessions/")))
      throw new Error("Writer overlap changed files outside fake history SQLite");
    console.log(JSON.stringify({ helperSha256: binaryHash, stableFullPage: true,
      stableWatchedFileCount: Object.keys(stableBefore).length, staleRejected: stale,
      ownerWritesDuringPage: writes, writerChangedFiles: changed,
      readerChangedFilesAfterWriterStopped: [], crossStoreAtomic: false }, null, 2));
  } finally {
    history?.close();
    state?.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
