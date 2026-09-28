# Paginated Codex RPC read-only pool experiment

This is a disposable exact-tag source experiment for Codex
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`.
The [patch](codex-paginated-rpc-readonly-pool.patch) adds an opt-in SQLx pool
for the existing `thread/turns/list` and `thread/items/list` app-server RPCs.
The [probe](codex-paginated-rpc-mount-probe.py) and
[captured result](codex-paginated-rpc-red-green.json) use a copied fake account
with one paginated saved conversation. The installed Codex app, personal Codex
home, browser, pointer, and user windows were not used.

## Experiment

The Python probe copies the fake Codex home twice into private temporary
directories, ignores its socket and temporary symlinks, and rebases the
copied SQLite rollout paths to `/fixture`. Each app-server runs in a separate
`bwrap` namespace with no network and a private `/tmp`. Both initialize, then
the probe snapshots state and history database main, WAL, and SHM files and
the rollout. Each snapshot records SHA-256, byte length, modification time,
and mode. The probe compares snapshots after the RPCs and also checks the
original retained fake fixture before and after both runs.

The red control uses the same patched binary with the opt-in flag absent and
a writable cloned fixture. The green case sets
`ORBIT_PAGINATED_READ_ONLY_EXPERIMENT=1` and binds the history database main,
WAL, SHM, and rollout tree read-only. The opt-in branch opens a separate SQLx
pool with `read_only(true)`, `create_if_missing(false)`, one connection, and
no migration. The state database remains writable so app-server can start;
the after-initialize snapshot checks whether these page reads alter it.

The probe uses the Desktop hydration shape:

```json
{"method":"thread/turns/list","params":{"threadId":"<fixture thread>","limit":5,"sortDirection":"asc","itemsView":"full"}}
```

It confirms that the returned turn contains `Private fixture conversation`
and `Orbit completed fixture answer`. It then calls `thread/items/list`
with `limit: 1`, follows `nextCursor`, and sees `userMessage` then
`agentMessage`. The turn response has `data`, `nextCursor`, and
`backwardsCursor`. Item entries contain `turnId` and `item`.

## Measured result

The bounded exact-tag CLI build completed in 5 minutes 56 seconds. Its local
unstripped debug binary had SHA-256
`a849370e6df4a9d156950b80b635e6ea43943e1887a86bcd78440a8ef42366c6`.
The bounded probe exited 0.

| Case | RPC content | Snapshot change after initialization |
| --- | --- | --- |
| Red, writable history | Full turn contains both fixture texts; two item pages contain user and assistant items | History WAL and SHM changed |
| Green, read-only history | Same content and item pages | No watched state or history main, WAL, SHM, or rollout file changed |

The original retained fake fixture had no watched file changes across the
experiment. The fake conversation has one turn, so turn cursor traversal was
not exercised. Item cursor traversal was exercised across two pages.

A full read-only mount of the cloned Codex home made app-server initialization
fail. With only history files mounted read-only, the unmodified lazy history
pool failed at first page RPC with SQLite code 8 because it attempted a write.
Those failures explain the opt-in read-only connection branch.

## Limit

The opt-in pool is global to one `LocalThreadStore`. It prevents ordinary
history writes in that app-server process when enabled. It is suitable only
for this isolated fixture and cannot be enabled on the person's live Codex
owner or offered as a two-client solution. A production path needs a separate
per-request reader or helper that can coexist with the owner's writer, plus
authorization and routing through the Orbit gate. Concurrent owner writes
during a page request, long-lived cursors across writes, Desktop rendering,
and a real account are not measured. This patch is not activated.

## Reproduction

Apply the patch to a clean detached checkout of the exact tag. Build its CLI
under the shared Orbit resource budget with the local Clang and mold tools.
The retained fake fixture used for this run is under `/var/tmp`; pass its
path and synthetic thread ID to the probe. Set `ORBIT_ROOT` to the Orbit
checkout.

```sh
cd /var/tmp/orbit-codex-paginated-rpc/codex-rs
env LD_LIBRARY_PATH=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/lib64 \
  CARGO_TARGET_DIR=/var/tmp/orbit-codex-source-tag/codex-rs/target \
  CARGO_BUILD_JOBS=2 \
  bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 720s \
  cargo rustc --offline -p codex-cli --bin codex -- \
  -C linker=/usr/bin/clang \
  -C link-arg=-fuse-ld=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/bin/mold

cd "$ORBIT_ROOT"
bun run scripts/limited.ts timeout 90s /usr/bin/python3 \
  experiments/codex-paginated-rpc-mount-probe.py \
  --codex /var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex \
  --fixture-home /var/tmp/codex-private-smoke-w/owner-codex-orbit-27303488 \
  --thread-id 01a0ea1e-6c7d-7b51-bbd1-e40266406dc9
```
