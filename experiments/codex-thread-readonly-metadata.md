# Codex thread/read metadata-only experiment

This experiment targets official Codex source tag `rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. Apply
[`codex-thread-readonly-metadata.patch`](codex-thread-readonly-metadata.patch) to
that exact source checkout. The patch was checked against the clean index with
`git apply --cached --check`.

The wire request adds an optional `readOnly: true` field to `thread/read`.
The default is false, preserving the owner's current read and repair behavior.
In read-only mode, `includeTurns: true` is rejected before reading the thread.
The app-server uses a separate `ThreadStore::read_thread_read_only` method,
including its second name lookup for loaded threads. Unsupported stores reject
that method. The local store keeps its initial SQLite lookup to respect the
selected rollout, but passes no state DB context to filesystem fallback. This
prevents fallback from calling `read_repair_rollout_path` with a writable handle.
It also verifies a stale SQLite rollout path before returning metadata.

## Evidence from disposable source tests

- Red, before implementation: the new missing-row test called ordinary
  `read_thread`. The bounded `cargo test -p codex-thread-store --lib
  readonly_read_does_not_repair_missing_sqlite_row` run exited 101 after
  5 minutes 19 seconds. Its final assertion failed because `get_thread`
  returned a row after the read. This directly witnesses the prepatch write.
- Green, after implementation: the same test called
  `read_thread_read_only`. A bounded run filtered by `readonly_read_` passed
  three tests: missing SQLite row stays missing, stale rollout path stays
  unchanged while the filesystem rollout is returned, and a store without a
  state runtime reads the rollout without creating a SQLite file.
- A separate bounded `normal_read_repairs_missing_sqlite_row` test passed,
  confirming the ordinary owner path still seeds a missing row.
- Bounded `cargo check -p codex-app-server --lib` and
  `cargo check -p codex-app-server --tests` both passed. The latter includes
  58 mechanical test literal additions of `read_only: false` required by Rust
  after adding the protocol field. These additions do not change test intent.
- `git diff --check` passed in the source checkout. No installed application,
  personal Codex home, running owner, Orbit gate, or other application was
  changed by this experiment.

## Limits

This patch proves a metadata-only `thread/read` path. It has not been wired
into the Orbit gate or built into the durable Codex candidate. No app-server
RPC integration test was run. The user's Desktop opens a conversation with
`thread/resume`, which the gate currently denies. Displaying conversation
content requires a separate attach-only viewer path and safe turn paging.
`thread/turns/list` is not claimed read-only here: it can reach rollout
resolution and the paginated history database. The owner's ordinary startup
may initialize or migrate SQLite before a request; this patch only prevents
the gated read request from triggering repair through the paths above.
