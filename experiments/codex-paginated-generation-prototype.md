# Disposable saved-thread generation prototype

Status: fixture-only experiment. The public Orbit path remains disabled. No
personal Codex profile, installed application, or credentials were accessed.
The fake owner binary and read-only page helper came from the exact source tag
`4607249e430dac1c961df4dc615beae88e33cec8`, checked with the known SHA256
values in `codex-paginated-live-owner-read.py`. The shared tagged checkout was
not edited for this experiment.

## Red result on the unchanged read path

The fake owner completed two turns. The helper returned page one with a cursor
and the first turn. The owner then completed a third turn. A second helper call
with the prior cursor returned two turns and included the new third turn.
`newTurnLeakedIntoSecondPage` was `true`. This demonstrates that the existing
cursor does not pin the first page's owner generation. It does not claim a
natural crash or an active write race was observed.

## Fixture-only green result

`codex-paginated-generation-prototype.py` wraps the fake owner's turn RPC in
one `asyncio.Lock`. Under that same lock, snapshot opening starts read
transactions and runs a `SELECT` on both state and history SQLite, reads the
selected complete JSONL prefix, verifies the history checkpoint, and copies
the six SQLite files plus that prefix into a private generation directory.
The existing read-only helper reads the captured directory. An opaque token
binds helper cursors to the generation. Both pages use the same captured
files even after the fake owner completes a third turn. A fresh generation
sees the third turn. The prototype checks source drift while opening and
checks the captured files around each page read.

The bounded green run showed page one with turn one, the owner writing turn
three, page two with only turn two, a fresh generation with three turns, and a
rejected cross-generation cursor. Exact measured output is in
`codex-paginated-generation-output.json`. The final run compared file
fingerprints before and after the owner write and both captured page reads.
The captured seven files did not change. The owner changed its rollout and
SQLite WAL and SHM files while adding turn three. All fake child processes
exited after each bounded run.

## Strict limits

This coordinator is outside the owner binary. Only fake turn RPC calls made
through it take its lock. It has no cross-process barrier, crash journal, or
way to prove that an unpatched writer did not bypass it. A direct writer can
still modify the source. Fingerprinting can detect some overlap but cannot
establish atomicity across both SQLite stores and rollout. The test therefore
does not establish owner-coherent snapshots and must not enable the personal
attachment path.

The code rejects an archived thread, missing checkpoint, path outside the
fixture, symlinked rollout, compressed file, nonmatching standalone JSONL
name, fork base, ordinal gap, or projection lag when opening this simple
thread. Those rejection branches were not independently exercised here.
Revert, fork, archive, compression, metadata updates, background writes,
multiple owners, recovery, token expiration, and unpatched writer admission
still need owner-side protocol work and red/green measurements.

Run one mode at a time inside the shared resource slice:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-paginated-generation-probe.py red
```

Replace `red` with `green` for the fixture coordinator run.
