# Disposable paginated page helper with read-only state and history

## Scope and provenance

This is an opt-in test-only prototype against the exact Codex source tag at commit `4607249e430dac1c961df4dc615beae88e33cec8`. It is stored as `codex-paginated-state-history-bwrap-helper.patch` and was compiled in the independent disposable worktree `/var/tmp/orbit-codex-paginated-helper`. The test binary SHA256 was `88c5da07a9f1a51a5916df9ea0dd130f2c5c4bc7d5819485bb1f3b643f769f6e`. The exported source patch SHA256 was `cf22178935145d9cfc5878131b7829d0735026912d53cb4218114e43fb543eb9`.

The patch changes only `codex-rs/thread-store` test code, a test-only selected-rollout lineage entry point, and its test dependency. It does not activate an Orbit gate, modify an installed Codex app, or read a personal account. The fixture is generated in a temporary directory from synthetic state, projected history, and rollout data. The source worktree is separate from the owner's source or profile.

## Helper shape

The parent sends a length-prefixed JSON request with `threadId`, `kind` (`turns` or `items`), optional `cursor`, and `limit` from 1 through 100. The child emits a length-marked JSON response with `data`, `nextCursor`, and `backwardsCursor`. The test harness uses a tagged output line because it executes the Rust test binary as the child. This output framing is a test prototype, not a deployed protocol.

Each child invocation runs under `bwrap --unshare-all` with the fixture mounted at `/fixture`, normally by `--ro-bind`. It has a read-only `/usr`, temporary `/tmp`, and cleared environment. It opens the state DB through exact-tag `open_read_only_pool`, reads `history_mode` and the selected rollout path from the thread row, and checks the path is canonical and under `/fixture/sessions`. It opens the separate thread-history DB with SQLx `read_only(true)` and `create_if_missing(false)`. The new test-only lineage method starts exact-tag lineage traversal at this selected rollout. The helper then calls exact-tag `page_turn_rows` or `page_item_rows` and returns cursor pages. No shared global reader pool is changed.

## Synthetic modes and measured result

The fixture has two turns and two items. Four child requests read one turn per page and one item per page, checking both cursors and the synthetic user and assistant content. Each run records byte arrays, SHA256, lengths, mtimes, and read-only permission flags for both SQLite main, WAL, and SHM files. It separately compares the selected rollout bytes and mtime; alternate and fork modes also watch the original or root rollout. The exact file comparison and test result lines from all six runs are in `codex-paginated-state-history-bwrap-red-green.txt`; parsed SHA256 and byte-offset counts are in `codex-paginated-state-history-bwrap-red-green.json`.

| Mode | Writable fixture mount control | Read-only fixture mount |
| --- | --- | --- |
| Default selected rollout | State SHM changed at 13 byte offsets; history SHM at 12. Both main and WAL files and watched rollout were unchanged. | All six SQLite files and watched rollout unchanged. |
| Alternate selected rollout | State SHM changed at 13 offsets; history SHM at 12. Both main and WAL files and watched rollouts were unchanged. | All six SQLite files and watched rollouts unchanged. |
| Synthetic fork lineage | State SHM changed at 13 offsets; history SHM at 12. Both main and WAL files and watched rollouts were unchanged. | All six SQLite files and watched rollouts unchanged. |

All six bounded test runs passed. The writable control uses the same read-only SQLx pools but changes the fixture mount to `--bind`; it shows that the read-only mount is necessary to avoid the observed SHM mutations. The selected alternate is a revert-like state selection, not execution of the full `thread/revert` workflow. The fork mode uses a synthetic `history_base` and checks pagination across its two lineage segments. Neither mode exercises a live concurrent writer. Holding a writer connection in the parent establishes WAL and SHM files, but it does not perform writes during child reads.

## Limits before product use

The helper currently returns a small summary shape for turn pages. Codex Desktop hydration requests `itemsView: full`; that full response shape, app-server routing, saved-thread authorization, and selected-path race handling remain unimplemented. The test does not establish that every Codex task, profile, revert, fork, or concurrent write is supported. Integrating a production helper requires an immutable pinned owner binary, gate validation of the requested operation and file mount set, a stable selected rollout snapshot per request, and tests with a writer active during reads. This prototype does not make Orbit able to edit an existing Codex task.
