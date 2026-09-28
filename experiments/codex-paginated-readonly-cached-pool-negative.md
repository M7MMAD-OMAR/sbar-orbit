# Codex paginated cached-pool read experiment

This experiment used the disposable source checkout at
`/var/tmp/orbit-codex-source-tag`, based on official Codex tag
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. It did not use the person's
Codex home, application, or active tasks. The checkout also contains the
earlier metadata and legacy read-only experiments. The paginated source edits
remain uncommitted and are not an approved patch.

## Baseline and component result

Two disposable paginated fixtures began with a valid state row and rollout,
but without `thread_history_1.sqlite`. Each test called the ordinary
`LocalThreadStore::list_turns` or `list_items` and asserted that the history
database stayed absent. The first bounded attempt timed out after 180 seconds
during dependency compilation, before assertions. A second bounded run reached
both assertions. It exited 101: the turn test failed at
`thread-store/src/local/thread_history/read_tests.rs:49`, and the item test
failed at line 68. Both ordinary list calls created the history database.

The experimental component change added separate `list_turns_read_only` and
`list_items_read_only` methods. These use an already cached history pool and
return `Unsupported` when it is absent. The two missing-database tests then
passed, and no history database was created in those fixtures.

A third fixture initialized a history pool, inserted two turns and two items,
then used the experimental methods to read two one-turn pages and two one-item
pages. It returned turn IDs `turn-1` and `turn-2`, and item IDs `user-1` and
`agent-2`. This verifies page selection and cursors in the component fixture.
It does not verify message text or an app-server RPC.

The same test captured SHA-256, length, and modification time for the main
history database and existing `-wal` and `-shm` files before and after the
page reads. The main file kept SHA-256 prefix `4eeb710c` and length 4096.
The WAL kept SHA-256 prefix `bed20aa8` and length 288432. Their modification
times did not change. The SHM kept length 32768 and its reported modification
time, but its SHA-256 changed from prefix `43c154ce` to `33818b86`. The
test therefore exited 101 with one failed assertion and two passing
missing-database tests. The disposable fixture was removed after the test;
the changed byte offsets and whether they were transient reader marks were
not measured.

## Separate SQLite read-only pool

A second disposable fixture held the owner writer connection open. It wrote
`marker-one`, waited for the write to finish, captured the main, WAL, and SHM
files, then opened a separate pool with SQLx `read_only(true)`,
`create_if_missing(false)`, and `immutable(false)`. The pool read
`marker-one`. The writer then committed `marker-two`. Both the same reader
pool and a newly opened reader pool saw `marker-two`, so this fixture measured
fresh committed WAL visibility.

With the writer quiescent during each comparison, merely opening either
reader changed zero bytes in all three files. The first SELECT left the main
file and WAL unchanged, but changed one byte in SHM: its SHA-256 changed from
`a32f776ef87beab62893f9bf5a14d9e87c1c11032b8c2e606edd78fb93767e55`
to `459022bb4d64c450b5bb8fc4633a9bc64c353dfcfa642abe9bc55e92b22833b1`.
After the second writer commit, a new quiescent baseline was captured. The
same reader's SELECT of `marker-two` again changed one SHM byte, from
`33aeb594273cc6a26c099ddd55a36d919b02f4338ff839b285f8d9fdf041ea4c`
to `e4d1aed8a64eb6b386c1fc5c62cca79356a4e6394efd3f53c7fcecd7a70a1d83`.
Opening and querying the second reader changed zero further bytes. Closing
both readers changed zero bytes; SHM did not return to the second baseline.
SHM length remained 32768 and its reported modification time stayed the same
throughout. The main file stayed 4096 bytes. WAL was 222512 bytes before the
second writer commit and 234872 bytes afterward, with no WAL byte or metadata
change during either quiescent reader window.

This bounded test reached its assertions, then exited 101 because SHM changed.
The test ran in 0.11 seconds after a 17.22 second build. It printed hashes,
lengths, modification times, and changed-byte counts, without raw database
bytes. The fixture did not retain byte snapshots after exit, so the exact
offset and meaning of the changed byte remain unmeasured. Its source test is
an uncommitted disposable change under `/var/tmp/orbit-codex-source-tag`.

## Conclusion and reproduction

The cached-pool method prevents lazy database creation and migration. A
separate SQLite read-only pool sees fresh committed WAL rows. Both methods
changed SHM during SELECT, so neither supports a claim of pure filesystem
read. The Orbit gate remains closed to both paginated page methods. Desktop
behavior, concurrent owner writes during a reader query, and the exact SHM
byte meaning remain unmeasured. The experimental source changes were not
exported or activated.

The source tests were run from `codex-rs` in the disposable checkout with the
shared Orbit budget. The red filter was
`does_not_create_history_db_for_read_only_request`; the cached-pool filter was
`read_only_pages_use_cached_history_without_changing_database_files`. A
reproduction command for the cached-pool case is shown below. Set `ORBIT_ROOT`
to the absolute path of the Orbit checkout first.

```sh
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 180s cargo test --offline -p codex-thread-store --lib read_only_pages_use_cached_history_without_changing_database_files -- --nocapture
```

The separate-pool command, from the same checkout directory, is:

```sh
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 180s cargo test --offline -p codex-thread-store --lib separate_read_only_pool_sees_commits_without_changing_owner_files -- --nocapture
```

No installed app, personal profile, Orbit gate, Zen profile, or other user
application was changed.
