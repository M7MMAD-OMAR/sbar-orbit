# Codex legacy read-only RPC fixture, not yet measured

This test-only fixture targets official Codex tag
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. Apply the prior
`codex-thread-readonly-metadata.patch` and
`codex-thread-readonly-legacy-history.patch` before
`codex-thread-readonly-legacy-rpc-fixture.patch`. The separate
`codex-thread-readonly-legacy-content-files.patch` is useful component
evidence but is not required by this app-server test file. The new patch
changes only `codex-rs/app-server/tests/suite/v2/thread_read.rs` and passed
`git apply --check` after the prior patches in a disposable exact-tag
worktree.

## Intended RPC check

The fixture creates a temporary legacy rollout with `Saved user message`
and `Saved assistant reply`, then starts a fake in-process app-server. It
sends `thread/read` with `includeTurns: true` and `readOnly: true` while the
thread is unloaded. It checks both returned texts and compares exact bytes,
file presence, and modification times for the state database main, WAL, and
SHM paths and the rollout.

The fixture then sends `thread/resume` to load the same thread. It takes a
fresh file baseline after the resume response, so resume writes are outside
the second comparison. It sends the same read-only `thread/read` request
again, checks both texts, and compares all files against that fresh baseline.
The `ORBIT_LEGACY_RPC_RED` test variable selects an ordinary repairing read
for either the `unloaded` or `loaded` stage. It leaves the other stage
read-only so both red routes can be checked independently. With the variable
unset, both stages use read-only requests.

## Attempted run and limit

One bounded command ran while both request flags still selected the ordinary
read path. It used the `thread_read_read_only_legacy_rpc_unchanged_files`
filter with a 300 second timeout. Cargo compiled dependencies, then printed
that it was compiling `codex-app-server` and `app_test_support`. The command
exited 124 without printing a test start or an assertion. The red baseline
therefore did not run, and no RPC behavior was measured. The source was then
changed to the stage-specific environment switch described above. That
exported version passed `git apply --check` but has not been compiled or
executed. It has no green result.

From a disposable exact-tag checkout with the prior patches applied and
`ORBIT_ROOT` set to the Orbit checkout, the bounded commands for a later
run are:

```sh
git apply "$ORBIT_ROOT/experiments/codex-thread-readonly-legacy-rpc-fixture.patch"
cd codex-rs
ORBIT_LEGACY_RPC_RED=unloaded bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 300s cargo test --offline -p codex-app-server --test all thread_read_read_only_legacy_rpc_unchanged_files -- --nocapture
ORBIT_LEGACY_RPC_RED=loaded bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 300s cargo test --offline -p codex-app-server --test all thread_read_read_only_legacy_rpc_unchanged_files -- --nocapture
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 300s cargo test --offline -p codex-app-server --test all thread_read_read_only_legacy_rpc_unchanged_files -- --nocapture
```

Each command requires its own shared Orbit budget window. A faster focused
test binary or linker may be needed before assertions can run within that
bound. The earlier ThreadStore content and file checks passed, but they do
not upgrade this RPC result. The Orbit gate remains closed to this read, and
no installed app, personal profile, personal database, Zen profile, or other
application was touched.
