# Codex paginated read promotion gap

## What the disposable run established

The corrected copied Desktop showed a fake project, a saved conversation,
the user's fake message, and the assistant's fake answer on a private display.
The owner and private client used distinct homes. The client had no `auth.json`.
The gate forwarded metadata `thread/read` to the fake owner and sent a full
turn page to a disposable exact-tag helper, not to the owner RPC socket.
The evidence and earlier failed attempts are in
`codex-paginated-private-ui-probe.md`. This is a limited synthetic read display,
not a real-account or installed-app measurement.

## New gate safeguards

The fixture page route now asks the owner for `thread/read` only with
`includeTurns:false` and `readOnly:true`. The separate legacy experiment can
still opt into `includeTurns:true`; the active launcher selects neither mode.
The gate also limits page callbacks to four concurrent tasks across all its
clients. A timed-out callback retains its slot until its actual work settles.
The disposable process bridge has a separate 3.5-second process group kill.
The gate timeout alone does not kill an arbitrary callback. Four callbacks
that never settle therefore stop further pages rather than spawning more work.

The focused test failed on the old gate because metadata was denied. After
adding metadata access alone, it failed because a fifth pending page callback
received no capacity error. With both safeguards it passed 2 tests and 114
assertions. The test also held four callbacks beyond the gate timeout,
confirmed a fifth remained denied, then settled one callback and confirmed
capacity returned. The attach launcher tests passed 4 tests and 21 assertions, and
`bun run typecheck` passed. These are synthetic callback tests. They do not
measure the helper process with concurrent Desktop clients.

## Blockers before a real attached read

1. The public launcher still has no paginated callback or viewer flag. The
   person's installed Desktop still uses its original app-server path. Its
   profile and application must remain untouched while the candidate is
   prepared and measured separately.
2. The reader is a test-only Rust binary and an experiment script. It must be
   packaged from reviewed, exact source and launched from pinned immutable
   files. The current candidate validation has a same-user change race between
   hash verification and process launch.
3. The bridge used a checkpointed fake SQLite copy in DELETE journal mode.
   A live owner commonly uses WAL and can write between state validation,
   lineage selection, and page reads. A production reader needs a coherent
   snapshot or explicit stale-read failure, plus tests for concurrent writes,
   missing files, schema changes, forks, reverts, archives, cursor traversal,
   large histories, owner restart, and reader timeout cleanup. Every test must
   compare main, WAL, SHM, and rollout bytes and metadata after the read.
4. The owner's metadata `thread/read` response currently passes through the
   gate after a credential-field scan. A reviewed owner implementation must
   prove that `includeTurns:false` and `readOnly:true` do not mutate local
   state, and the response needs a bounded metadata projection before it is
   exposed to a private client. A stock owner may ignore the extra read-only
   field. No such claim is made from the fake owner used here.
5. The fake entitlement check used local fixture responses and a synthetic
   account id. A copied client without credentials has not been shown to pass
   the real account's service checks or to hydrate real projects and saved
   conversations. Any account routing must preserve the owner's session
   without copying credentials into the private home or exposing them at the
   gate.
6. The copied Desktop patch and exact bundled CLI must be verified together
   against the installed version and the real request sequence. The synthetic
   UI run showed one saved turn and one page. It did not establish live updates,
   multiple pages, complete item types, app restart, or parity with the
   person's current conversation view.

These blockers concern reading saved text. Sending a message in an existing
conversation and using the person's other applications require separate
capability and isolation measurements. The public gate still denies writes.
