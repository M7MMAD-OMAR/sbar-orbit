# Disposable Codex WAL stale page guard

## Scope

This experiment wraps the test-only paginated Codex page helper. It uses a
copied fake paginated account with a retained WAL state database, WAL history
database, and fake rollout JSONL. The source fake account is copied into a new
temporary fixture. Its auth file, owner socket, and other profile files are
not copied. The test binary is pinned by SHA256 to the existing exact-tag
helper. No personal account, installed app, or production gate is involved.

The guard fingerprints the fixture before and after one page callback. It
records SHA256, device, inode, mode, size, mtime, and ctime for every allowed
SQLite main, WAL, and SHM file and every rollout JSONL. It also records
directory identity and metadata. An observed drift returns
`StalePaginatedReadError` instead of the page. It opens files with
`O_NOATIME` for hashing and rejects symlinks and unexpected top-level files.
The helper itself still reads from a read-only `bwrap` bind mount.

## Measured results

`bun run scripts/limited.ts bun test experiments/codex-paginated-stale-guard.test.ts`
passed 4 tests. `bun run typecheck` passed. The tests used synthetic SQLite
databases in WAL mode and a fake rollout. A stable callback returned its page
with watched SHA256 and mtime/ctime unchanged. A synthetic owner update during
the callback produced stale rejection. A write followed by a logical revert
also produced stale rejection. A deliberately mismatched but unchanging state
and history generation was accepted, which demonstrates the guard's limit.

The exact-tag helper probe in `codex-paginated-wal-stale-probe.ts` used the
documented binary SHA256
`6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd`.
With the copied fake account's WAL files present, a full turn page returned
the fake user and assistant text. All 7 watched SQLite and rollout files had
the same SHA256, size, mtime, ctime, and inode before and after that read.

The probe then started a fake owner writer during another helper invocation.
It performed 6 updates to `thread_turns.duration_ms`. The guard rejected the
page as stale. Only the history WAL and SHM differed from the stable baseline.
After the writer stopped, the guard's remaining work changed none of the
watched files. The compact result is in
`codex-paginated-wal-stale-output.json`.

An early version of the mismatch test queried a writable SQLite connection
inside the guarded callback. It failed because that query changed SHM. The
corrected test reads its two fake values before the guard starts. This is
consistent with earlier evidence that a read-only SQL request on a writable
mount can mutate SHM, and reinforces why the isolated read-only mount is
needed for the actual page helper.

## Limit

Matching fingerprints before and after a page do not prove a coherent
cross-store snapshot. A writer can leave state and history at different
logical generations before the first fingerprint, or perform transient
changes between observations. There is no shared generation token or owner
barrier across the two SQLite databases and rollout files. The guard also
does not pin a version across cursor pages. Its scan is bounded to 256 MiB
and 1000 files, so larger fixtures fail closed. Directory access times were
not measured. The integrated probe measured one fake writer schedule and
one ascending full turn page, not every item type or writer interleaving.

This is an explicit stale-read failure candidate for observed file drift.
A production coherent reader needs an owner-coordinated snapshot or equivalent
shared generation protocol, then a separate measurement with real app
versions and session behavior before enabling the gate.
