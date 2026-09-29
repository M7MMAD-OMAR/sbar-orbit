# Disposable Codex cross-store stale page, red result

## Scope

This is a deterministic fake account experiment against the existing exact-tag
Codex owner and read-only paginated page helper. It does not use the personal
profile or installed Desktop, and does not change Codex production source or
Orbit's public gate. The owner binary and helper are pinned by SHA256 in
`codex-paginated-cross-store-red.py`.

The experiment makes one fake conversation with two completed owner turns. It
first reads the owner after turn 1, then after turn 2. It constructs a separate
disposable directory with history SQLite main, WAL, and SHM from turn 1, and
state SQLite plus rollout JSONL from turn 2. Both source generations are copied
only after their owner turn completed. Before and after copies, the script
fingerprints the fake owner source. It then calls the unchanged page helper on
the stable mixed directory through the read-only bubblewrap mounts and the
existing before and after fingerprint guard. The fake owner connection remains
open, but the owner is not writing during the mixed read.

## Measured result

The following command exited 0 inside Orbit's shared resource slice:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-paginated-cross-store-red.py
```

The normal first owner page contained 1 turn. The normal second owner page
contained 2 turns, including the second fake user text. The mixed directory
retained history WAL SHA256 from the first generation and state WAL SHA256 and
rollout from the second. The helper accepted its page with 1 turn and omitted
the second user text. `acceptedStalePage` was `true`, with no read error. None
of the watched files changed during any of the three reads. The measured
fields and representative hashes are in
`codex-paginated-cross-store-red-output.json`.

The script confirms exact source commit and binary hashes before launch, checks
that the owner produced distinct state and history generations, verifies all
mixed files match their selected source generation by SHA256, and checks that
the read-only helper changed none of the mixed files. All test children exited.

## Interpretation and limit

This is a red result for the current fingerprint guard: a stable cross-store
mismatch can produce a silently stale saved-thread page. It is a constructed
mixed directory, not a measured crash window or a write that happened during
the helper call. It does not prove that the normal owner reaches exactly this
state on its own, or that every mismatch will be accepted. The source writes
canonical JSONL before projecting history SQLite and tolerates projection
failure (`codex-rs/thread-store/src/local/live_writer.rs:317-359`), so the
scenario is relevant to a real failure boundary.

The proposed owner-coordinated solution is described in
`docs/codex-coherent-snapshot-design.md`. It has not been implemented or
measured. Until a coherent generation protocol passes a green test, this
disposable result cannot justify enabling personal paginated reads.
