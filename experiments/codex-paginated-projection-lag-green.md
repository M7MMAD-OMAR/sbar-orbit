# Disposable Codex projection lag guard, green result

## Scope

`codex-paginated-projection-lag-green.py` is a fixture-only wrapper around the
unchanged red harness in `codex-paginated-cross-store-red.py`. Its child probe
runs in a separate read-only bubblewrap mount containing only the fake state
SQLite main, WAL, and SHM, the fake history SQLite main, WAL, and SHM, one
sessions tree, and the probe script. It does not mount auth files or reach the
personal profile. Orbit's public Codex gate and the tagged owner and helper
binaries are unchanged.

The probe accepts only the disposable standalone paginated rollout shape used
by this test. It reads the selected rollout path from state SQLite, the
`next_rollout_byte_offset` and `next_rollout_ordinal` checkpoint from history
SQLite, and the selected JSONL's complete lines. It rejects the page with an
explicit `UNAVAILABLE` error when history's checkpoint is behind that rollout.
It also rejects missing, malformed, oversized, compressed, forked, or reverted
shapes outside this fixture scope. The wrapper keeps the existing before and
after source fingerprints around both the probe and page helper.

## Red baseline and green measurement

The unchanged red harness was measured first in
`codex-paginated-cross-store-red.md`: with history from the first fake turn and
state plus rollout from the second, the existing helper accepted a stale page
containing only the first turn.

After adding this wrapper, the following command exited 0 inside Orbit's
shared resource slice:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-paginated-projection-lag-green.py
```

The normal first page contained 1 completed fake owner turn. The normal
second page contained both completed turns. The stable mixed-generation
fixture returned no page: `acceptedStalePage` was `false`, `mixedPageTurns`
was `null`, and its error named the lagging history projection. No watched
file changed during any of the three reads. The fake owner client remained
connected, and all test children exited. The selected output is in
`codex-paginated-projection-lag-green-output.json`.

## Limit

This guard detects this selected-rollout history lag in a simple fake
standalone thread. It does not establish a coherent snapshot across state
SQLite, history SQLite, and JSONL. Equal offsets can accompany a stale state
row, a changed title or project, an unrelated writer, or a different lineage.
The fingerprint scans can miss a transient writer between observations, and
the guard does not pin a version across cursor pages. Unsupported histories
fail closed in this wrapper; full support is unmeasured. The owner-coordinated
design in `docs/codex-coherent-snapshot-design.md` remains proposed and is
required before personal attachment can claim consistency.
