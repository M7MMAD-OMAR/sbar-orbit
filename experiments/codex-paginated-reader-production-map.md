# Paginated Codex reader: source map and safe integration boundary

This is a design map, not an enabled route. It follows the exact Codex tag
`rust-v0.155.0-alpha.9.2` and the measured disposable
[RPC probe](codex-paginated-rpc-readonly-pool.md).

## Existing path

The Desktop hydration request is `thread/turns/list` with `threadId`,
`cursor`, `limit: 5`, `sortDirection: "asc"`, and `itemsView: "full"`.
It can also use `thread/items/list` with a per-item cursor. In the exact-tag
source, the app-server dispatch is in
`codex-rs/app-server/src/request_processors/thread_processor.rs:3038-3125`,
`:3183-3288`, and `:3397-3455`. It converts stored items and turns to
the public response at `:5823-5875`. The wire types are in
`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1705-1776`.

The paginated branch calls `LocalThreadStore::list_turns` or `list_items`.
Their state-row validation and page flow are in
`codex-rs/thread-store/src/local/thread_history/read.rs:95-211`.
Lineage resolution, including a current rollout, fork ancestors, and cutoff
ordinals, is in `codex-rs/thread-store/src/local/rollout_lineage.rs:33-180`
and `thread_rollout_resolver.rs:67-160`. Cursor and SQL page selection are in
`thread_history/segment_paging.rs:44-202` and `:202-350`.

The current `LocalThreadStore::thread_history_db` at
`codex-rs/thread-store/src/local/mod.rs:269-290` lazily calls
`codex_state::open_thread_history_db`. That opens a writable pool and runs
migrations at `codex-rs/state/src/sqlite.rs:242-293` and
`state/src/runtime.rs:356-361`. Even an independent SQLx pool with
`read_only(true)` can change the shared SHM on an ordinary writable mount.
The measured red control changed history WAL and SHM during RPC reads.
The state crate already has a noncreating `open_read_only_pool` at
`codex-rs/state/src/sqlite.rs:314-331`, but it does not itself protect
shared files from an SQLite SHM write.

## Smallest production path to test

1. Keep the owner's app-server and its writable pools as they are. Do not set
   the disposable probe's global `ORBIT_PAGINATED_READ_ONLY_EXPERIMENT` flag
   on the owner. It would prevent that process from writing history.
2. Add a short-lived page helper that receives only a validated method,
   thread ID, cursor, bounded limit, sort direction, and item view. It must
   use noncreating read-only pools for both the state and history databases,
   validate the state row and selected rollout, resolve the exact-tag fork and
   revert lineage, then reuse `page_turn_rows` or `page_item_rows`. Return the
   public `ThreadTurnsListResponse` or `ThreadItemsListResponse` shape.
3. Launch each helper inside a private `bwrap` mount namespace. Bind only
   required state and history main, WAL, SHM files and rollout roots read-only.
   Give it no owner socket, account credentials, host tools, or network. The
   host owner keeps its normal writable view. Limit request and response size,
   process lifetime, and concurrent helpers. Reject missing files and
   unsupported schema or history mode without falling back to writable open.
4. Route only the two page methods to this helper at the Orbit gate. Current
   `src/codex-authority-gate.ts:99-160` allows a small read method set, and
   `:325-430` forwards accepted requests to the owner. Extend the allowlist
   only when the helper is present. Reject extra fields and arbitrary paths;
   require a UUID thread ID, a bounded ASCII cursor, a page limit, known sort
   and item-view values. Project the helper response to the documented page
   shape and reject credential fields. Preserve the existing request ID and
   client response routing at `:161-183,357-410`.

The helper approach keeps the read pool separate from the owner writer and
uses the mount to enforce a filesystem boundary. A second pool inside the
owner process lacks that boundary; the earlier ordinary read-only pool test
changed SHM. Forwarding the page RPC to the owner through today's gate also
lacks that boundary. A full second app-server under a read-only Codex home
failed initialization in the measured probe. A partial read-only mount plus
the global opt-in pool worked only for a disposable single process and is
not the two-client design.

## Binary and session precondition

Only attach when the owner Desktop exposes the verified bridge sockets and
the exact owner and helper binaries are pinned to reviewed source and
immutable at execution. Orbit currently checks socket device and inode in
`src/codex-authority-gate.ts:24-35` and staged candidate file hashes in
`src/native-codex-candidate.ts:170-190`. The candidate manifest is pinned by
the broker, but `docs/codex-attached-client.md:98-103` identifies a remaining
same-user change race between verification and launch. Mounting the verified
files from immutable pinned inodes must close that race before this path is
enabled. The current installed personal app has not been proven to meet this
precondition. A matching visual interface or matching version string alone
is insufficient evidence.

## Missing measurements

The helper does not yet exist. Tests must establish red and green behavior
against the unfixed and fixed routes on disposable data, including forked
and reverted lineages, archived threads, loaded and unloaded conversations,
pagination in both directions, missing history files, schema mismatch, and
oversized or malformed requests. They must compare source main, WAL, SHM,
and rollout bytes and metadata, including failures. Concurrent owner writes
and process restarts need separate measurements. State and history are two
stores, so a page may observe different commit points; detect that change
and retry or fail before claiming a coherent view. Desktop body rendering,
real-account behavior, and write actions remain unmeasured by this design.
