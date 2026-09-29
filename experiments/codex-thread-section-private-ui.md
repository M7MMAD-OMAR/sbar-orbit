# Disposable Codex section UI probe

## Fixture and command

This probe used the exact-tag disposable app server and page helper, a copied
Desktop at `/var/tmp/codex-private-smoke-u/app/ChatGPT`, a synthetic account,
and an Orbit private Fedora display. It did not open the installed Desktop or
any personal profile. The public attach route stayed off.

The fake owner created a saved paginated thread, created a custom section named
`Fixture Shared Section`, and moved the thread into it through its own direct
RPC connection. Before launching Desktop, direct owner `threadSection/list`
returned the section and `thread/list` with the section ID returned the saved
thread. The private UI used a second fixture-only gate with an injected section
reader. Its callback returned the synthetic section with extra fixture fields;
the gate projected the response to `id`, `name`, `appearance`, and `nextCursor`.
The private UI could not forward section requests or writes to the owner.

The bounded command exited zero in about 33 seconds:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/codex-app-server \
ORBIT_CODEX_PAGE_HELPER_BINARY=/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab \
ORBIT_CODEX_COPIED_DESKTOP=/var/tmp/codex-private-smoke-u/app/ChatGPT \
bun run scripts/limited.ts timeout 120s /usr/bin/python3 experiments/codex-thread-section-private-ui.py
```

The first two short attempts stopped before Desktop launch because the test
runner omitted one UUID group in its own section ID check. The runner was
fixed before the successful UI run. Their fake owner processes were stopped by
the harness cleanup path.

## Observed UI and RPC shape

The copied Desktop sent two `threadSection/list` requests to the fixture gate.
The section callback recorded the same sanitized request both times:

```json
{"method":"threadSection/list","params":{"cursor":null,"limit":100}}
```

The gate audit recorded both requests as allowed. The exact copied Desktop
main bundle has `listSections` call `adapter.listSections` with
`{cursor:n,limit:100}`, initially with `n=null`, which agrees with the callback
trace. The gate also allowed `thread/list`, `thread/read`, and one
`thread/turns/list`; it denied `config/batchWrite`. It allowed no
`turn/start`, `threadSection/create`, or `thread/section/move` from the private
client.

The screenshot at
`/var/tmp/codex-section-ui-evidence-x00g5v4p/private-ui-first-opened.jpg`
visibly shows the custom section in the sidebar, with `Private fixture
conversation` nested beneath it, and the saved assistant text `Orbit
completed fixture answer` in the main pane. Tesseract read the section title
as `Fixture Shared Sectior`, so the harness's exact OCR boolean was false.
The visual observation resolves that OCR miss for this one screenshot. The
callback trace is at
`/var/tmp/codex-section-ui-evidence-x00g5v4p/private-ui-first-section-request.jsonl`
and the gate audit is beside it.

The private home had no `auth.json`. The seven watched owner files, including
state and history SQLite main, WAL, SHM, and the selected rollout, had identical
identity, size, timestamps, and SHA256 before and after the private UI run.
The copied Desktop process PID `3113602` was gone after the command exited;
the harness waited for fake owner termination and closed the Orbit backend.

## Limit

This is a synthetic section display result for one fake saved thread. It does
not measure a personal account, installed Desktop, large section lists,
pagination after the first section page, or private edits to section order.
The injected callback is fixture-only and is not wired into the active
launcher. Its five-second gate timeout bounds the RPC wait, not the helper
process lifetime. Nothing in this run establishes a safe production section
reader or full Codex parity.
