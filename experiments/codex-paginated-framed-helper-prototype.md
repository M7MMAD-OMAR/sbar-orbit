# Codex paginated framed helper prototype

This experiment is a test-only patch against official Codex tag
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. The patch is
`experiments/codex-paginated-framed-helper-prototype.patch`. It adds a test
dependency and a disposable ThreadStore test. It does not change a product
binary, Orbit gate, installed app, personal Codex home, or other application.

## What the test does

The parent test creates a temporary paginated history database with two turns
and two items. It keeps a writer connection open, then calls a fresh child
process for each page. The child runs inside `bwrap` with an isolated mount
namespace. The temporary database directory is bound at `/fixture` with
`--ro-bind`. The child sees no owner home, application socket, or host tool
route. It reads a length-prefixed JSON request from stdin and emits one
length-prefixed JSON response frame on stdout.

The child opens SQLite through a separate SQLx pool with
`read_only(true)` and `create_if_missing(false)`. It leaves SQLite's
`immutable` option at its false default. It
calls the exact-tag `page_turn_rows` or `page_item_rows` function and decodes
the stored item JSON. The parent requests two one-turn pages and two one-item
pages with the returned cursors. It checks the text of a user item and an
assistant item, then compares the main database, WAL, and SHM bytes, SHA-256,
length, and modification time before and after the four read calls.

## Evidence and clean reproduction

The first bounded run used an exploratory exact-tag checkout with other
uncommitted read-only experiments. It passed: `turn-1` and `turn-2` were
returned on consecutive turn pages; `user-1` and `agent-2` were returned on
consecutive item pages. The user content was `user-1` and assistant content
was `agent-2 item`. The main, WAL, and SHM files each had zero changed byte
offsets, the same SHA-256, the same length, and the same modification time
before and after all four calls. Their SHA-256 values were respectively
`4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f`,
`fca712ca9c489a8abbe98926dd80d8516556676f1db6872334c63f015746c53e`,
and `32384ac983c20eae8604f6b2eea1cb9e2169335690e2a34c956a5d74dc7aff6a`.
The bounded command exited 0 after a 14.18 second build and a 0.11 second
test.

The exported patch removes the exploratory dependency by creating the SQLx
read-only pool directly inside the child and including its own file snapshot
helpers. `git apply --check` passed against a clean detached worktree at the
exact commit. The bounded test of that clean patched worktree also passed.
Its two turn pages and two item pages returned the expected cursors, item IDs,
and user and assistant content. Main, WAL, and SHM again had zero changed
byte offsets and unchanged SHA-256, length, and modification time across all
four child calls. The clean test's SHA-256 values were respectively
`4eeb710c739848e62f0d53d04057e17375b4af741c9b441f2a546f6ed860c79f`,
`42bf7d970f2026c5ee142ec527ac8b15bc2d8856891a914ce2ceb89efc1bdb71`,
and `88a504af1180a0aed5d550e54ffc504144476a2fa9104120edaf99cda8f22d98`.
The command exited 0 after a 1 minute 2 second build and a 0.12 second test.

With `ORBIT_ROOT` set to the Orbit checkout, the clean reproduction is:

```sh
cd /var/tmp/orbit-codex-helper-clean-run
git apply --check "$ORBIT_ROOT/experiments/codex-paginated-framed-helper-prototype.patch"
git apply "$ORBIT_ROOT/experiments/codex-paginated-framed-helper-prototype.patch"
cd codex-rs
CARGO_TARGET_DIR=/var/tmp/orbit-codex-source-tag/codex-rs/target bun run "$ORBIT_ROOT/scripts/limited.ts" timeout 300s cargo test --offline -p codex-thread-store --lib bwrap_paginated_page_helper_returns_cursor_and_content -- --nocapture
```

If the patch is already applied in that worktree, skip the two `git apply`
commands. The test binary is built in a disposable checkout and runs only
against temporary fixture data.

## Limit

The fixture uses one synthetic rollout segment and does not validate a thread
against the owner state database. It does not implement the app-server
projection, an RPC, the Orbit gate, or Desktop rendering. There is no red
baseline for this exact framed helper. Earlier separate controls showed that
ordinary paginated reads can create a missing history database and an
unmounted SQLite read-only SELECT can change SHM. Those controls explain why
the read-only mount matters, but they do not test this helper's routing.
Concurrent owner writes during a page call and a long-lived helper are also
unmeasured. The helper is not approved for personal data.
