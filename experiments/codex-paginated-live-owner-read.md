# Disposable live owner paginated read

## Scope

This test starts a fresh fake Codex app server with a local mock model. The
owner runs in a disposable `bwrap` mount with `CODEX_HOME=/fixture`, so its
selected rollout path points to `/fixture/sessions` naturally. The owner
connection stays open through both completed turns and both page reads. The
test uses a separate exact-tag paginated page helper with only the six live
SQLite main, WAL, and SHM files plus `sessions` mounted read-only. It copies
no account profile, auth file, database page, or rollout after the owner
starts. No installed app or personal account is involved.

The owner binary is pinned to SHA256
`c1214554e7ea7412cd9072e8f57f710539226b394260422c8170b5c1e46c4042`.
The test-only page helper is pinned to SHA256
`6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd`.
The source worktree reports commit `4607249e430dac1c961df4dc615beae88e33cec8`.
These binary hashes identify the local experimental builds, not released
artifacts.

## Red and green measurement

The command below ran successfully inside Orbit's shared resource slice:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-paginated-live-owner-read.py
```

The first page contained one completed owner turn and did not contain the
second turn label. The owner then completed a second turn in the same live
thread. The old page fingerprint was rejected as stale. A fresh read of the
same live files returned two turns, including the second label. The test did
not refresh a copied snapshot or restart the owner. Two requests reached the
local mock model.

The owner changed the state WAL and SHM, history WAL and SHM, and selected
rollout between reads. The reader changed none of the seven watched files
during either stable read. The recorded baseline and after-read SHA256,
device, inode, mode, size, mtime, and ctime for each file are in
`codex-paginated-live-owner-read-output.json`. Its first and second
before/after sets match exactly. The helper mount was read-only and the
fingerprinter opened files with `O_NOATIME` and `O_NOFOLLOW`.

## Limits

The freshness token is a test-only argument, not a gate or Desktop protocol.
The stale check rejects observed changes between fingerprints or a supplied
older page version. It cannot prove a coherent snapshot across state SQLite,
history SQLite, and rollout JSONL. Changes between scans could be missed,
and a writer can leave a logically mixed generation before the first scan.
The owner finished each turn before the corresponding successful read. This
run does not measure a writer changing data during the helper call, although
the earlier `codex-paginated-wal-stale-guard.md` probe measured one such
synthetic overlap and a stale rejection.

The owner used a private mount path chosen for the fixture, so this does not
solve selected-path mapping for a real owner. It does not verify cursor chains,
reverts, forks, larger histories, app restart, account entitlement, UI updates,
or editing an existing conversation through Orbit. The public route remains
disabled.
