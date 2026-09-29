# Proposed Codex saved-thread snapshot protocol

Status: design only. No protocol below is implemented or measured. No personal
Codex profile or installed application was used for this design. The source
spans below refer to the disposable Codex checkout at commit
`4607249e430dac1c961df4dc615beae88e33cec8`.

## Scope and required invariant

This design covers one saved paginated conversation viewed through Orbit while
its Codex owner may keep writing. It does not establish account, tool, or write
authority parity for the private client.

For every accepted snapshot token, its thread metadata, selected rollout and
ancestor lineage, turn rows, item rows, and every cursor page must represent
one committed owner generation `G`. A page may contain only the durable prefix
published at `G`. It must never combine metadata from one generation with
history or rollout content from another. If a committed generation cannot be
established, the reader returns an explicit unavailable or stale result. It
must not silently display a mixed or older page as current. Orbit's read path
must not write the person's profile.

The current file fingerprint is a useful drift detector, not evidence of this
invariant. A stable mismatch between state and history passed the disposable
guard in `experiments/codex-paginated-wal-stale-guard.md:21-28,51-65`.

## Why the current paths do not meet it

The owner writes canonical JSONL, then projects it into history SQLite. The
projection can fail after the JSONL write and leave history behind
(`codex-rs/thread-store/src/local/live_writer.rs:317-359`). History rows and
their byte and ordinal checkpoint commit together inside history SQLite
(`codex-rs/thread-store/src/local/thread_history.rs:105-243`). This transaction
does not include state SQLite or the rollout file.

The read path obtains state metadata, resolves rollout lineage, and queries
history in separate steps (`codex-rs/thread-store/src/local/read_thread.rs:44-136`,
`codex-rs/thread-store/src/local/thread_history/read.rs:109-174`). Lineage
segments use separate pool queries
(`codex-rs/thread-store/src/local/thread_history/segment_paging.rs:44-171`).
Full turn hydration makes additional item-page calls
(`codex-rs/app-server/src/request_processors/thread_processor.rs:3228-3335`).
The existing cursor contains position and scope, not a snapshot identity
(`codex-rs/thread-store/src/local/thread_history/read.rs:30-45`).

The in-process writer lock covers live JSONL write and projection, but it is
per thread (`codex-rs/thread-store/src/local/mod.rs:160-215`). Paginated
metadata takes a separate state path
(`codex-rs/thread-store/src/local/update_thread_metadata.rs:38-165`). Archive
moves rollout files before updating state
(`codex-rs/thread-store/src/local/archive_thread.rs:118-149`), while revert
creates a replacement rollout before switching the state pointer
(`codex-rs/thread-store/src/local/revert_thread.rs:110-141`). The existing
cross-process lock protects writer ownership, not reader snapshots
(`codex-rs/rollout/src/writer_lock.rs:33-85`).

## Proposed protocol

1. Add a profile-wide publication barrier shared by every writer that can
   change saved-thread state, history, rollout, project association, title,
   archive state, fork lineage, revert pointer, deletion, migration, or
   compression. The first implementation may serialize these operations
   globally. An in-process lock alone is insufficient. Every process allowed
   to write the same `CODEX_HOME` must participate in one cross-process
   protocol, with a fixed lock order for multi-thread operations. If an
   unpatched writer can bypass it, production attachment remains unsupported.
2. Before each multi-store mutation, durably record a pending generation in a
   small owner journal while holding the barrier. After JSONL, history
   projection, and state changes are durable and verified, publish a committed
   generation with the selected rollout IDs and projection checkpoints. A
   crash with a pending generation blocks new snapshots. On restart, the owner
   reconciles the stores and publishes a new committed generation, or keeps
   reads unavailable. Merely releasing the OS lock after a crash cannot make
   a partially updated profile coherent.
3. On snapshot open, hold the same barrier. In a read-only mounted helper,
   start one read transaction on state SQLite and one on history SQLite.
   Execute a real `SELECT` against each database before releasing the barrier:
   SQLite's deferred `BEGIN` alone does not pin a WAL view. Read thread
   metadata and all lineage pointers from these pinned views. Resolve and
   open each rollout representation, recording the selected file identity and
   a complete-line byte cutoff for each segment. Verify every history
   projection checkpoint and lineage cutoff lies within its captured rollout
   prefix and matches the committed journal generation. Reject lag, missing
   paths, malformed lineage, or an unsupported file shape. The existing
   seekable rollout reader retains an open file or decoded compressed snapshot
   (`codex-rs/rollout/src/seekable_reader.rs:1-5,65-80`). An open plain file
   may still grow, so all later reads must stop at the captured cutoff.
   SQLite documents the deferred read start in its
   [transaction guide](https://sqlite.org/lang_transaction.html) and the
   stable reader end mark in its [WAL guide](https://sqlite.org/wal.html).
4. Release the barrier after both WAL views and rollout handles are pinned.
   Route `thread/read` metadata, every `thread/turns/list` page, and full item
   hydration through that same snapshot. Refactor the history page queries to
   use its pinned connection rather than a fresh pool query. Bind each cursor
   to an opaque snapshot token, thread ID, client connection, and generation.
   Reject a cursor from another token or a changed owner identity.
5. Limit each token's lifetime, total page bytes, open file handles, and
   concurrent snapshots. Close both SQLite transactions and rollout handles
   on completion, expiration, client disconnect, owner restart, or helper
   failure. Pinned WAL readers can delay checkpoints, so expiration must be
   enforced even when a client stops requesting pages. Keep credentials and
   auth files outside the helper mount and response.

The read-only helper and gate are currently disposable-only surfaces
(`experiments/codex-paginated-bwrap-bridge.ts:12-104`,
`src/codex-authority-gate.ts:513-799`). This document does not enable them on
the public launch path.

## Proposed red and green measurements

Run each new test against the unchanged source first and prove it fails for
the intended reason. The existing disposable mismatch test is one red
observation, but it does not validate the new protocol tests.

1. Pause a fake owner after each of these stages: rollout append, history
   commit, state metadata commit, archive move, revert replacement creation,
   and final journal publication. Against the old path, prove a mixed or
   silently stale page is possible. Against the new path, require one `G` or
   explicit rejection. Crash at every stage and verify recovery never accepts
   an unfinished generation.
2. Keep the fake owner writing between first and later cursor pages. Verify
   metadata, turn shells, summary items, and full items all stay on `G`.
   Repeat for long history, forked ancestors, revert, archive, compression,
   changed project association, and owner restart.
3. Run two patched fake writer processes, then try a deliberately unpatched
   writer. Prove patched writers respect the barrier. If bypass is possible,
   the production gate must remain disabled rather than claim coherence.
4. Compare state main, WAL, SHM, history main, WAL, SHM, and rollout bytes and
   metadata before and after a private read while the owner is idle. Attribute
   every change during owner writes to the owner. Verify token expiration,
   client disconnect, helper timeout, and process exit release all resources
   without leaking thread text or credentials.

All green outcomes above are not measured. The protocol is not ready for the
personal Codex attachment gate until these tests pass on disposable profiles
and the exact production candidate is reviewed separately.
