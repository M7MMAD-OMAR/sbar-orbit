# Codex read-only legacy history experiment

Apply [`codex-thread-readonly-metadata.patch`](codex-thread-readonly-metadata.patch)
first, then [`codex-thread-readonly-legacy-history.patch`](codex-thread-readonly-legacy-history.patch).
Both target official Codex source tag `rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. The incremental patch passed
`git apply --cached --check` against an index containing the first patch.

The incremental change permits `thread/read` with `readOnly: true` and
`includeTurns: true` for legacy history. An unloaded thread reads its history
through the existing read-only store method. A loaded thread uses that method
for its second name lookup and history, avoiding `loaded_thread.load_history`,
which can fall back to the ordinary repairing store read. Paginated threads
still reject this combination before `persist_thread` or full-history paging.
The ordinary owner path remains unchanged.

## Measured evidence

- Red component test: a disposable legacy rollout was resumed, its writer
  closed, and its SQLite thread row deleted. The test repeated the loaded
  app-server store call sequence, two metadata reads followed by history load.
  On the ordinary path, the SQLite row reappeared. The bounded test exited 101
  after 13.84 seconds, with its final missing-row assertion failing.
- Green component test: the same sequence used the read-only store method for
  metadata and history. The bounded `missing_sqlite_row` filter passed three
  tests in 15.3 seconds: the loaded-sequence component case, the unloaded
  missing-row case, and the ordinary owner repair control. Both read-only
  cases found the fixture user text `Hello from user` in legacy history while
  leaving the row absent. The loaded-sequence test also compared rollout bytes
  before and after. The fixture contains no assistant message, so assistant
  text was not measured.
- `cargo check -p codex-app-server --lib --tests` passed in 28.23 seconds.
  `git diff --check` passed for the incremental source changes.

## Limits

The loaded-sequence test exercises the same ThreadStore calls but does not run
an app-server RPC. A separate bounded attempt to run a disposable loaded
app-server test timed out after 600 seconds during linking, before its
assertion ran. That result is unmeasured and the unrun test is not in this
patch. Desktop rendering, assistant text, concurrent writes, and the
paginated `thread/turns/list` path remain unmeasured. No Orbit gate, installed
app, durable candidate, personal profile, or other application was changed.
