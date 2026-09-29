# Disposable full-view paginated page helper

## Provenance and scope

This incremental source patch applies after `codex-paginated-state-history-bwrap-helper.patch` on exact Codex tag commit `4607249e430dac1c961df4dc615beae88e33cec8`. It changes only the isolated `codex-thread-store` test helper. The incremental patch SHA256 is `04582fb7a4009f0c493e39ad1975a24335c66416b7c0d5939ce15338cc16ab02`. The final test binary SHA256 is `6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd`. Compilation used the shared bounded Orbit resource slice and finished in 11.7 seconds for the final writer-probe edit.

No Orbit gate or installed Codex app was changed. All tests generated temporary synthetic SQLite and rollout files in the independent source worktree. The fixture has two turns and three items; the first turn has two items so a full response cannot pass by returning its one-item summary.

## Response shape exercised

The test-only framed helper accepts `thread/turns/list` with `itemsView: "full"` and `thread/items/list` with ascending order, a cursor, and a bounded limit. It reads the selected rollout path through a separate read-only state pool, resolves the exact-tag rollout lineage, and reads pages through a separate read-only history pool. The fixture is mounted read-only in `bwrap` for green runs. The response is serialized from Codex's own `ThreadTurnsListResponse`, `Turn`, `ThreadItemsListResponse`, `ThreadItemEntry`, and `ThreadItem` types. Full turn items are loaded through exact-tag `page_item_rows` in bounded pages, matching the app server's compatibility behavior in the measured ascending case.

The test asserts two turn pages, three cross-thread item pages, a filtered item page for the second turn, both cursor chains, `itemsView: "full"`, completed status, and the expected synthetic user and assistant content. `thread/turns/list` and `thread/items/list` outputs use the protocol field names `data`, `nextCursor`, and `backwardsCursor`. The item entries contain `turnId` and `item`; turn entries contain `id`, `items`, `itemsView`, status, error, and timing fields through the protocol serializer.

## Red and green files

The six rerun modes and their exact file SHA256 comparisons are in `codex-paginated-full-view-writer-helper-output.json`. The selected test output lines are in `codex-paginated-full-view-writer-helper-output.txt`. All six modes passed.

| Synthetic mode | Writable fixture mount control | Read-only fixture mount |
| --- | --- | --- |
| Default selected rollout | State SHM changed at 15 byte offsets; history SHM at 12. | No watched state or history main, WAL, or SHM file changed. |
| Alternate selected rollout | State SHM changed at 13 offsets; history SHM at 12. | No watched state or history main, WAL, or SHM file changed. |
| Fork lineage | State SHM changed at 15 offsets; history SHM at 12. | No watched state or history main, WAL, or SHM file changed. |

All watched rollout bytes and mtimes were unchanged in every mode. The writable control still uses read-only SQLx pools; it changes only the fixture mount. The alternate selection resembles a revert target but does not execute the full revert workflow. Fork lineage uses synthetic `history_base` metadata.

## Writer overlap probe

A separate opt-in green run kept a writer pool open and updated the first turn's `duration_ms` 21 times, including 20 updates while the first helper invocation was in progress. The helper returned the full first turn, and later pages returned the expected content and cursors. State main, WAL, and SHM were unchanged during the overlap. History WAL and SHM changed while the legitimate writer ran. Those history changes cannot be attributed between the writer and reader from a byte comparison during overlap. After the writer joined, a new baseline was taken; the remaining read-only helper requests changed none of the six watched SQLite files or rollout files.

This shows coexistence for one synthetic writer schedule. It does not prove a stable snapshot across page requests or every possible write interleaving. The helper still lacks Desktop activation, gate routing, production binary packaging, authorization checks, broader sort and view options, large-history performance measurement, and a live user interface test. It does not give Orbit the ability to edit a saved Codex task.
