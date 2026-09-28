# Codex legacy read-only history content and file evidence

This is an incremental test-only patch for official Codex tag
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. Apply
`codex-thread-readonly-metadata.patch`, then
`codex-thread-readonly-legacy-history.patch`, then
`codex-thread-readonly-legacy-content-files.patch`. The last patch changes
only `codex-rs/thread-store/src/local/read_thread.rs` tests. It adds no
product route or installed application change.

## Scope and method

The earlier source patch routes unloaded legacy `thread/read` with
`readOnly: true` and `includeTurns: true` to
`LocalThreadStore::read_thread_read_only`. For a loaded legacy thread, the
app-server path performs metadata and name reads, then obtains legacy history
through the same read-only store method instead of the loaded thread's
ordinary history loader. The loaded component fixture repeats the relevant
store call sequence, two metadata reads followed by one history read. The
unloaded fixture makes one history read. Neither fixture is an app-server
RPC.

Both temporary rollout fixtures contain a user message, `Hello from user`,
and an assistant message, `Hello from assistant`. A SQLite state runtime is
opened, and the target thread row is absent before reading. The loaded case
first resumes and closes its writer, then deletes the row. Each fixture
captures the exact bytes and modification time of the state database main,
WAL, and SHM paths, including file presence. It also captures the rollout
bytes and modification time. The checks run before a final row lookup so
that the final verification query cannot affect the file comparison.

## Red and green evidence

The first red command stopped at a test-only compile error before any
assertion ran. The snapshot type was not printable by `assert_eq!`; the test
was corrected to use a bounded boolean message without printing database
bytes. A second bounded red run called the ordinary repairing store method
in both cases. The user and assistant text assertions passed, then both
tests failed because the state database `-wal` file changed. The ordinary
owner repair control passed. The command exited 101 after a 25.79 second
build and 0.08 second test run. The rollout comparison lay after the failing
state assertion, so the red run did not measure its final state.

The green run restored `read_thread_read_only` in the two fixtures. All
three tests passed after a 12.29 second build and 0.07 second test run.
The loaded and unloaded cases both found the user and assistant messages.
The state main, WAL, and SHM paths retained exactly the same bytes, file
presence, and modification time. The rollout retained exactly the same bytes
and modification time. The target state row remained absent. The ordinary
owner repair control still passed.

The incremental patch passed `git apply --check` after the two earlier
patches in a detached exact-tag worktree. A separate bounded green test in
that worktree passed the same three cases after a 28.70 second build and
0.07 second test run. That worktree also contained an unrelated test-only
paginated helper patch, which the legacy filter did not invoke. The
incremental legacy patch does not depend on that helper patch.

With `ORBIT_ROOT` set to the Orbit checkout, run from a clean exact-tag
checkout:

```sh
git apply "$ORBIT_ROOT/experiments/codex-thread-readonly-metadata.patch"
git apply "$ORBIT_ROOT/experiments/codex-thread-readonly-legacy-history.patch"
git apply "$ORBIT_ROOT/experiments/codex-thread-readonly-legacy-content-files.patch"
cd codex-rs
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 180s cargo test --offline -p codex-thread-store --lib missing_sqlite_row -- --nocapture
```

## Limit

The loaded fixture reproduces the ThreadStore call sequence from the loaded
app-server branch. It does not send `thread/read` through an app-server RPC,
prove the API's projected turn shape, or render the Desktop conversation.
Concurrent owner writes during the read, a missing or old state database,
and compressed rollouts are unmeasured here. This evidence does not open the
Orbit gate or prove personal account behavior. No installed app, personal
profile, Zen profile, or other application was touched.
