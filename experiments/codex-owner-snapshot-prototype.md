# Test-only owner snapshot prototype

Status on 29 September 2026: limited source experiment, not a personal or
production attachment. The exact Codex base is
`4607249e430dac1c961df4dc615beae88e33cec8`. The isolated source branch
`agents/codex-owner-snapshot-proto` at
`e1443bc9b329a4e75a8a578b22d9a6cb00a9a00f` contains the prototype and
its detailed `codex-rs/thread-store/OWNER_SNAPSHOT_PROTOTYPE.md` evidence.
No installed application or personal profile was used.

The isolated branch later advanced to
`d1ab79c97e658e6bd372f3e939b8421e7c21bc87`. A previously excluded
state-only title update now takes the test snapshot barrier. Before that
change, the extended test failed with exit `101` because the title writer
completed while the barrier was held. After it, the focused test exited `0`:
the old generation retained its title and a new generation showed the new
title. This covers one metadata writer path; other metadata shapes and owner
writers still bypass the prototype.
The isolated branch advanced again to
`eb6b94b764bd4a7d8ebcf471bc8be09e2e53eeef`. Its separate
`move_thread_to_section` state writer now takes the test barrier, and the
snapshot captures section ID, position, and entered time from the pinned state
view. Before the writer change, the focused test failed with exit `101` because
the move completed while the barrier was held. After the change, it exited `0`
with one passing test: the old generation remained outside a section, and a
fresh generation showed the pinned section. Other section writers and
unpatched processes remain outside this guarantee.

The updated [source patch](codex-owner-snapshot-prototype.patch) against the
exact tag has SHA-256
`c996944857f68d16a5c76b0cf488f58791fb86b1dee98cfabf0821e82798fa55`.
Forward application was checked against an archived clean exact tag tree, and
reverse application was checked against the isolated committed source.

The earlier unchanged paginated reader leaked a third owner turn onto page two
after page one had returned a two-turn cursor. See
`experiments/codex-paginated-generation-prototype.md` for that red fixture.
The source prototype adds a test-only barrier across a real
`LocalThreadStore` JSONL append, history projection and state path sync.
Snapshot open takes the same barrier, pins the state and history SQLite reads,
retains one complete verified rollout prefix and materializes bounded turn and
item rows. Cursor pages use the captured generation.

The final focused test passed twice. It verified that the third append waits
while snapshot open holds the barrier, the old generation's second page still
shows only turn two, a new generation includes turn three, a cursor cannot be
used with the wrong generation, and the new rollout prefix extends the old
one. The final run reported 1 passed, 0 failed and 256 filtered out. It used
the shared Orbit resource slice:

```sh
CARGO_TARGET_DIR=/var/tmp/orbit-codex-owner-snapshot-target CARGO_BUILD_JOBS=2 \
bun run scripts/limited.ts /usr/bin/timeout 120s /usr/bin/cargo test \
  --manifest-path /var/tmp/orbit-codex-owner-snapshot-proto/codex-rs/Cargo.toml \
  -p codex-thread-store owner_snapshot_prototype_keeps_cursor_pages_on_one_generation \
  -- --nocapture
```

The first run reached the test and failed because its synthetic thread had no
state row. The fixture was corrected with the existing rollout reconciliation
path before the passing runs. This prototype has no production app-server
API. Metadata changes beyond the tested title and section move, archive,
revert, fork, deletion, compression and other writers bypass its barrier.
Crash recovery, restart, cross-process proof and
resource limits are not measured. It cannot justify enabling the public or
personal Codex route.
