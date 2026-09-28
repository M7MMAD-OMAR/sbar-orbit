# Codex paginated history with a read-only mount

This disposable component experiment used the official Codex tag
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`, in
`/var/tmp/orbit-codex-source-tag`. It did not open the person's Codex home,
installed application, active tasks, or any other personal application. The
source test is an uncommitted experiment in that disposable checkout. No Orbit
gate or product source was changed.

## Fixture and result

The parent test created a temporary paginated history database and kept its
writer connection open outside `bwrap`. It inserted `marker-one` and waited
for that write to finish. A child test process entered a separate `bwrap`
mount namespace with the temporary database directory bound at `/fixture`
using `--ro-bind`. The child opened a separate SQLx SQLite pool with
`read_only(true)`, `create_if_missing(false)`, and `immutable(false)`, then
queried `thread_turns`. It found `marker-one`.

The writer then committed `marker-two`. A fresh child in the same kind of
read-only mount found `marker-two`. This shows that the reader saw a newly
committed WAL row in this fixture. The writer was quiescent during each
before and after file comparison.

| Quiescent read | File | SHA-256 before and after | Length before and after | Changed byte offsets | Modification time |
| --- | --- | --- | --- | ---: | --- |
| `marker-one` | main | `4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f` | 4096 | 0 | unchanged |
| `marker-one` | WAL | `4acc32511b5d5968d8581bdc99af9508c81ef58eb8e631d64d5d359df326fbc0` | 222512 | 0 | unchanged |
| `marker-one` | SHM | `277174c422b554e493bbd2b68edda866096dd19370eb3aba3e1ac455abdc9522` | 32768 | 0 | unchanged |
| `marker-two` | main | `4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f` | 4096 | 0 | unchanged |
| `marker-two` | WAL | `bfac06f14e8e1949d74ef9d41e312c5621747a4c0856f25e749d826f98181c84` | 238992 | 0 | unchanged |
| `marker-two` | SHM | `8f6c29f2cf047166d4d7e93868e4ff109696846379704abf335e1ce8038ba7bc` | 32768 | 0 | unchanged |

The WAL and SHM values differ between the two rows because the owner committed
`marker-two` between those comparison windows. Both child processes exited
successfully. The bounded command exited 0. Build time was 14.77 seconds;
the parent test ran in 0.09 seconds.

From `/var/tmp/orbit-codex-source-tag/codex-rs`, with the disposable test
source present, the bounded command is reproduced by setting `ORBIT_ROOT` to
the Orbit checkout and running:

```sh
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 180s cargo test --offline -p codex-thread-store --lib bwrap_read_only_mount_sees_commits_without_changing_owner_files -- --nocapture
```

## Limit

This proves only the temporary ThreadStore component fixture, with one writer
commit between two short-lived readers and no concurrent write during either
comparison. It does not prove Orbit gate integration, app-server RPC behavior,
Desktop rendering, long-running pagination, concurrent owner writes during a
query, or behavior against the person's database. The current gate still
denies paginated page methods. The test source has not been exported as a
product patch. The previous unmounted separate read-only SQLite pool changed
one SHM byte during SELECT, as recorded in
`experiments/codex-paginated-readonly-cached-pool-negative.md`.
