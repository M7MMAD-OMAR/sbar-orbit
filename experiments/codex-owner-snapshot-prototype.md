# Test-only owner snapshot prototype

Status on 30 September 2026: limited source experiment, not a personal or
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
The branch then advanced to
`7f7833f90b821c25ec76827b047bf51232c0d82a`. Archiving an existing
thread now takes the test barrier after its writer locks and before moving the
rollout. The focused test first failed with exit `101` at its 50 ms wait
assertion because the archive completed while the barrier was held. With the
archive barrier, the same test passed with exit `0`, one test passed. The old
captured generation remained pageable and a new active snapshot was rejected.
The seven archive and unarchive tests also passed. This covers one synthetic
archive path, not unarchive or all archive descendants.

The branch then advanced to
`c9889573a4274b8f5d3e2534c7e0e5bfdee96eb4`. Unarchiving the same
synthetic thread now takes the test snapshot barrier after its writer lock and
before moving rollout files. Before the change, the focused test exited `101`:
the unarchive completed while the barrier was held. After the change, it
passed with exit `0`. The previously captured generation remained pageable,
and a new active snapshot opened after unarchive. Three focused unarchive
tests also passed. This covers one synthetic unarchive path, not every
descendant or concurrent process.

The latest [source patch](codex-owner-snapshot-prototype.patch) against the
exact tag at `c9889573a4274b8f5d3e2534c7e0e5bfdee96eb4` has SHA-256
`d60701a1f8e0aaf406d474ef5399d77da4315868512202d023f9f264bac42208`.
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

The focused test passed after each earlier extension and after the archive and
unarchive extensions. It verified that the third append waits
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
API. Metadata changes beyond the tested title and section move, unarchive,
revert, fork, deletion, compression and other writers bypass its barrier.
Archive and unarchive participate only for the tested paths. Cross-process
unpatched writers still bypass it. Crash recovery, restart, cross-process proof and resource
limits are not measured. It cannot justify enabling the public or personal
Codex route.
