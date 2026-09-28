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

## Conclusion and reproduction

The cached-pool method prevents lazy database creation and migration, but the
measured SHM byte change prevents a claim of pure filesystem read. The Orbit
gate remains closed to both paginated page methods. Desktop behavior, live
owner concurrency, and SQLite sidecar semantics remain unmeasured. The
experimental source changes were not exported or activated.

The source tests were run from `codex-rs` in the disposable checkout with the
shared Orbit budget. The red filter was
`does_not_create_history_db_for_read_only_request`; the cached-pool filter was
`read_only_pages_use_cached_history_without_changing_database_files`. A
reproduction command for the cached-pool case is shown below. Set `ORBIT_ROOT`
to the absolute path of the Orbit checkout first.

```sh
bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 180s cargo test --offline -p codex-thread-store --lib read_only_pages_use_cached_history_without_changing_database_files -- --nocapture
```

No installed app, personal profile, Orbit gate, Zen profile, or other user
application was changed.
