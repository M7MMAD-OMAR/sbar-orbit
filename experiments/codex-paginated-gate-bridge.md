# Disposable Codex paginated gate bridge

## Scope

This experiment connects the dormant `startCodexReadOnlyGate` paginated callback
to the exact-tag, test-only, full-view page helper in a separate `bwrap`
process. It uses a copy of the retained fake Codex account under
`/var/tmp/codex-private-smoke-w/`, not a personal profile. The copy contains
only two SQLite databases and one rollout under `sessions`. The fake account's
`auth.json`, owner socket, runtime and other files are not copied. The fixture
copy is removed after the probe. No installed Desktop bundle or personal app
was changed. The active Orbit launcher still leaves paginated pages denied.

The bridge lives in `codex-paginated-bwrap-bridge.ts`. It accepts only the
validated page request from the gate and supports ascending full turn pages or
ascending item pages. It mounts `/usr`, the temporary fixture at `/fixture`,
and the pinned test binary at `/reader` in a new namespace. It does not mount
the owner socket or a Codex home. Each request gets one framed stdin message
and one bounded stdout frame. The bridge caps input at 4 KiB, output at 4 MiB,
and kills the child process group after 3.5 seconds, independently of the
gate's 5-second Promise deadline. It waits for child close before resolving a
failed request. These constraints are prototype implementation details, not a
reviewed production packaging plan.

The helper is a Rust test binary built from official Codex tag commit
`4607249e430dac1c961df4dc615beae88e33cec8` with two incremental test
patches. The patch SHA256 values are
`cf22178935145d9cfc5878131b7829d0735026912d53cb4218114e43fb543eb9`
and `04582fb7a4009f0c493e39ad1975a24335c66416b7c0d5939ce15338cc16ab02`.
The test binary SHA256 is
`6ce7c9be7f828dcb6cc3dae3c72cdb0194bbfd04f039c38c79d208322ee09ffd`.
The gate option is `allowLegacyThreadRead: true` plus
`allowPaginatedThreadPages: true` with `readPaginatedThreadPage` set to this
disposable process callback. The copied Desktop viewer at external repository
commit `9da0bd7` is still dormant. This probe did not launch it.

## Private Desktop blocker

The current `prepareCodexAttachedLaunch` call in `src/native-codex-attach.ts`
creates the gate without `allowLegacyThreadRead`,
`allowPaginatedThreadPages`, or `readPaginatedThreadPage`. Its Desktop argv
does not set `CODEX_LINUX_ATTACH_PAGINATED_VIEWER_READY=1`. The copied Desktop
patch at commit `9da0bd7` therefore refuses the viewer before hydration.
Even if that UI flag were set alone, the current launch gate would deny
`thread/read` metadata and `thread/turns/list` pages. This is why the real
gate bridge result above does not establish a private Desktop body render.
The required next integration is a reviewed, explicit fixture-only launch
route that supplies the process callback and UI flag together. The public
launcher must continue to deny the route until the read-only owner and
packaged helper are measured together.

## Measured result

The bounded gate probe completed with exit 0. It sent the private viewer's
metadata request, then `thread/turns/list` with `itemsView: "full"` and
`readOnly: true`, then `thread/items/list`. The fake owner returned
`historyMode: "paginated"` metadata. The test helper returned one full turn
containing the fake user and assistant text, plus two item entries. The fake
owner RPC method list was exactly `["thread/read"]`, so neither page request
was forwarded to that socket. A `turn/start` request was denied. The copied
state database, history database, and rollout retained identical SHA256,
sizes and modification times before and after the gate calls. Exact hashes
and method counts are in `codex-paginated-gate-bridge-output.json`.

The bounded failure probe also exited 0. A script in the same namespace saw no
`/fixture/auth.json`, `/run/user`, or fixture owner socket. Invalid frame
length and output above 4 MiB were rejected. A sleeping helper hit the
3.5-second process deadline; the callback waited for close, and no matching
`bwrap` command remained afterward. Its output is in
`codex-paginated-bridge-failure-output.json`. The scripts ran through
`bun run scripts/limited.ts`; both entry points bundled successfully for Bun.

## Limit

The metadata came from a fake owner server. The page helper was a Rust test
binary and is not a deployable Orbit or Codex component. The fixture copy was
checkpointed and changed to SQLite DELETE journal mode before measurement, so
this bridge run did not measure overlap with a live WAL writer. Separate
full-view helper experiments exercised one synthetic writer schedule. This
bridge run did not render a conversation in a copied private Desktop window,
verify the full Desktop request sequence, measure large histories, or prove
read-only behavior for a real owner. It does not enable writing to saved
Codex conversations, model turns, file access, or parity with the person's
Codex application.
