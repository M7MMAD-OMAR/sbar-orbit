# Opt-in cold saved-thread subscription candidate

Status: opt-in candidate measured on a disposable synthetic account. It is not
ready for personal accounts or Desktop activation.

The exact Codex source base is `4607249e430dac1c961df4dc615beae88e33cec8`.
The isolated worktree is `/var/tmp/orbit-codex-cold-attach`. Apply
`experiments/codex-thread-readonly-metadata.patch` first, then
`experiments/codex-cold-read-subscribe.patch` with `git apply --unidiff-zero`.
To build the whole CLI, also
apply `experiments/codex-readonly-metadata-cli-fix.patch`, which adds
`read_only: false` to 12 existing TUI and exec request literals omitted by the
metadata prerequisite patch. The candidate is dormant unless
`CODEX_APP_SERVER_ORBIT_COLD_ATTACH_EXPERIMENT` is set in the disposable app
server. It only registers a subscriber when the client name is exactly
`orbit_private_attached` and `thread/read` succeeds with `readOnly:true` and
`includeTurns:false`.

On a cold saved thread, the proposed path reads persisted metadata and records
the connection under that thread ID in memory. It does not call
`resume_thread_with_history`, open a live `CodexThread`, or create a rollout
writer. An explicit later `thread/resume` remains necessary before a cold
`turn/start` can write. Loaded-thread and ordinary `thread/resume` semantics
remain on their existing paths when the experiment is absent. A cold
`thread/unsubscribe` removes its in-memory subscription.

The fixture `experiments/codex-cold-read-subscribe.py` uses a temporary home,
a local synthetic model, one saved conversation, and two Unix WebSocket
clients. It snapshots every tracked Codex file by SHA-256, byte count, and
nanosecond mtime. Its assertions isolate state, history, rollout and writer
lock files from the full file comparison. It checks cold attach, unsubscribe,
reattach, an explicit owner resume and turn, an unrelated thread, and an
explicit private resume and turn.

The unpatched installed exact-tag CLI exited `1` in the fixture, as expected.
The cold `thread/read` returned metadata, but `thread/unsubscribe` returned
`notLoaded`, and the later owner turn delivered no completion notification to
the private connection. Normal cold `thread/resume` changed the rollout JSONL,
SQLite WAL and SHM files and created a writer lock. Raw output is saved in
`codex-cold-read-subscribe-red.txt`, with the local checkout path replaced by
`$ORBIT_ROOT`.

The patched exact-tag CLI reported version `0.155.0-alpha.9.2`, had SHA-256
`5a5c968643ca1985f21949ac02238f15c9009ebf362228440aac113dc32c691e`,
and ran the same synthetic fixture with exit `0`. Cold attach, unsubscribe and
reattach made no measured change to the tracked state, history, rollout or
writer lock files. A direct cold `turn/start` still returned `thread not found`.
After an explicit owner `thread/resume` and turn, the private subscriber got
one `turn/completed`. An unrelated thread sent it no `turn/completed`, but it
did receive an unrelated `thread/status/changed`. The private client then
explicitly resumed the loaded thread and completed its own turn. The local
model saw four requests overall. Raw output, including the before and after
file hashes, is saved in `codex-cold-read-subscribe-green.txt`.

The full file comparison did change on the patched run: `logs_2.sqlite-wal`
and `logs_2.sqlite-shm` changed during cold attach, unsubscribe and reattach.
The test does not attribute those log changes to a specific event. It only
supports the narrower unchanged claim for state, history, rollout and writer
lock files. Normal owner resume still changed those tracked files and created
the writer lock, as expected.

Run the fixture against a freshly built patched exact-tag CLI:

```sh
bun run scripts/limited.ts timeout 120s env \
  ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-cold-attach \
  ORBIT_CODEX_TEST_BINARY=/path/to/disposable/codex \
  python3 experiments/codex-cold-read-subscribe.py
```

The client name is spoofable. This is a behavior experiment, not an
authorization boundary. A production implementation needs the Orbit gate or
an authenticated connection identity. `turn/completed` used per-thread
subscriber routing in the fixture. The unrelated `thread/status/changed`
notification shows that full notification isolation is still missing. The
separate paginated read-only RPC work remains necessary for general saved
thread history and page access. The cold read does not create a live
`CodexThread`, so a direct cold turn is still unavailable until an explicit
resume.

Build provenance: after the 12 CLI literal fixes, a bounded full CLI build
compiled source but GNU `ld` remained I/O bound for about six minutes. That
bounded process was terminated with exit `143`. A bounded incremental
`cargo rustc --offline -p codex-cli --bin codex` with Clang, locally extracted
mold and its mimalloc library linked in 13.43 seconds, exit `0`. The full
source diff against the exact tag had SHA-256
`07ba022916e754a2154ec42b6484018be6244e94075858b6c9bc9304ea72b22b`.
The successful bounded link used:

Set `ORBIT_ROOT` to the Orbit checkout path before running this command.

```sh
env LD_LIBRARY_PATH=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/lib64 \
  CARGO_TARGET_DIR=/var/tmp/orbit-codex-source-tag/codex-rs/target \
  CARGO_BUILD_JOBS=2 \
  bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 300s \
  cargo rustc --offline -p codex-cli --bin codex -- \
  -C linker=/usr/bin/clang \
  -C link-arg=-fuse-ld=/var/tmp/orbit-codex-linker.PU0aKm/root/usr/bin/mold
```

The shared target's prebuild executable SHA-256 was
`a849370e6df4a9d156950b80b635e6ea43943e1887a86bcd78440a8ef42366c6`;
it was restored and verified to that hash after the fixture. Python syntax
compilation and `git diff --check` passed. `rustfmt` was not on the default
`PATH`.
