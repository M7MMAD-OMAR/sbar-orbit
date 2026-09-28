# Standalone Codex legacy history RPC test

The [test patch](codex-thread-readonly-legacy-rpc-small-target.patch) targets
official Codex tag `rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. Apply
`codex-thread-readonly-metadata.patch` and
`codex-thread-readonly-legacy-history.patch` first. This patch adds one
standalone integration test file. It replaces the unrun aggregate test fixture
in `codex-thread-readonly-legacy-rpc-fixture.patch` for this measurement; do not
apply both fixture patches.

The test creates a disposable legacy rollout with `Saved user message` and
`Saved assistant reply`. It uses the app-server `thread/read` RPC with
`includeTurns: true` before and after `thread/resume`. It removes the thread's
SQLite metadata row before each read. Before and after each RPC, it compares
presence, exact bytes, and modification time of the state database main, WAL,
and SHM files and of the rollout. It takes a new baseline after resume, so
resume writes are outside the loaded read comparison.

`ORBIT_LEGACY_RPC_RED=unloaded` selects an ordinary repairing read for the
unloaded request. `ORBIT_LEGACY_RPC_RED=loaded` selects one for the loaded
request. With the variable unset, both requests use `readOnly: true`.

## Measured results

The test compiled in a separate exact-tag worktree with a standalone target.
The bounded `cargo rustc` command completed in 4 minutes 52 seconds using
Clang and an extracted mold linker. The local linker was not installed into
the system.

| Case | Result | Evidence |
| --- | --- | --- |
| Ordinary unloaded read | Failed as intended, exit 101 | RPC returned both fixture texts, then the file assertion detected a changed SQLite WAL. App-server logged `upsert_needed (slow path)`. |
| Read-only unloaded read | Passed | RPC returned both fixture texts; the main, WAL, SHM, and rollout snapshots were unchanged. |
| Ordinary loaded read | Passed in this fixture | RPC returned both fixture texts, but no snapshot changed. This case did not prove that the loaded-stage assertion catches a write. |
| Read-only loaded read | Passed | RPC returned both fixture texts; the main, WAL, SHM, and rollout snapshots were unchanged. |

The red unloaded case used the patched app-server's ordinary `readOnly: false`
path, not a separately compiled unpatched app-server. It proves the assertion
detects the repair under this fixture. The loaded red case had no sensitivity,
so the green loaded result is evidence for this specific state only. These
checks do not establish safety under concurrent writers, other history modes,
all database files, transient changes that revert before the snapshot, the
Desktop renderer, or a real account.

## Reproduction

From a separate exact-tag source worktree, apply the two prerequisite patches
and then this test patch. Set `ORBIT_ROOT` to the Orbit checkout path. Run from
`codex-rs` using the Orbit resource wrapper:

```sh
env LD_LIBRARY_PATH=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/lib64 \
  CARGO_TARGET_DIR=/var/tmp/orbit-codex-source-tag/codex-rs/target \
  CARGO_BUILD_JOBS=2 \
  bun run "$ORBIT_ROOT/scripts/limited.ts" \
  timeout 720s cargo rustc -p codex-app-server \
  --test legacy_readonly_rpc --offline -- \
  -C linker=/usr/bin/clang \
  -C link-arg=-fuse-ld=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/bin/mold
```

The produced test binary was
`/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/legacy_readonly_rpc-32dcd491ca8f5e80`
for this local build. Run the three invocations separately through
`bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 90s`
with `--exact legacy_readonly_rpc_preserves_state_files --nocapture` appended
to the binary command:

```sh
env ORBIT_LEGACY_RPC_RED=unloaded bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 90s /var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/legacy_readonly_rpc-32dcd491ca8f5e80 --exact legacy_readonly_rpc_preserves_state_files --nocapture
env ORBIT_LEGACY_RPC_RED=loaded bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 90s /var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/legacy_readonly_rpc-32dcd491ca8f5e80 --exact legacy_readonly_rpc_preserves_state_files --nocapture
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 90s /var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/legacy_readonly_rpc-32dcd491ca8f5e80 --exact legacy_readonly_rpc_preserves_state_files --nocapture
```

The Orbit authority gate and installed Codex still do not expose this legacy
history read. No personal Codex or Zen profile, installed app, or user window
was modified for this test.
