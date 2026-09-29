# Disposable Codex saved turn completion and reopen

Measured on 29 September 2026 with the copied Desktop at
`/var/tmp/codex-private-smoke-write-v/app/ChatGPT`, a fake ChatGPT account,
fake Codex home, fake project, and Orbit private Fedora displays. The installed
Desktop and personal profiles were not used. This is a `Limited` fixture result.

## What changed

The fixture gate accepts one bounded text `turn/start` for one pinned fake
thread. It projects selected owner notifications only while that exact turn is
active. The owner app-server did not send turn or item notifications to the
private socket after `turn/start`: its protocol has no read-only subscribe RPC,
and `turn/start`, `thread/read`, and paginated reads do not attach a listener.
The gate therefore reads the fake owner's saved full turn page for at most
12 seconds and projects the confirmed assistant item and completion to the
private window. This completion is synthetic from saved owner data, not a live
owner notification. The default public gate has this path disabled.

## Tests

`tests/codex-authority-gate.test.ts` failed on the old gate because the new
notification test saw no `turn/started`. A second new test for saved turn
polling also failed on the old gate because no completion arrived. With the
changes, the focused file passed 5 tests and 183 assertions; `bun run typecheck`
passed. Tests cover the same-thread event, other-thread denial, credential
fields, oversized events, owner disconnect, the exact saved turn, and absence
of owner `thread/resume`.

## Private UI measurement

The first two-window attempt stopped after the first window because OCR
misread the user bubble's first word. Its screenshot visually showed the
assistant reply. After the stable suffix assertion was corrected, the bounded
two-window run produced these observations:

| Observation | Result |
|---|---|
| First private window PID | `3423828` |
| Reopened private window PID | `3437622` |
| First window | Submitted `Orbit private saved-thread follow-up`; screenshot shows the user bubble and `Orbit owner preflight answer` |
| Owner persistence | Direct fake owner `thread/read` found the exact user text and assistant reply after the first window |
| Reopened window | Screenshot shows the saved user text and assistant reply from a live fake owner page callback, with no copied page refresh |
| First window gate | 1 allowed `turn/start`, 0 `thread/resume`, 3 allowed `thread/turns/list`, 6 allowed `thread/read` |
| Reopened window gate | 0 `turn/start`, 0 `thread/resume`, 1 allowed `thread/turns/list`, 2 allowed `thread/read` |
| Notification audit | Owner sent `thread/status/changed` but no turn-scoped events; gate projected one `fixture/savedTurn/completed` |
| Account and socket | Fake project present, private auth file absent, owner socket identity unchanged |
| Cleanup | Harness printed `private processes stopped`; no process with the run tag remained |

Screenshots:

- First window after write: `/var/tmp/codex-private-smoke-write-v/orbit-client-after-write-first.jpg`
- Reopened window: `/var/tmp/codex-private-smoke-write-v/orbit-client-opened-reopened.jpg`

The watched fake owner files that changed during the first private write were
the saved rollout JSONL and SQLite WAL or shared-memory files for the owner
state, history, and logs. The second screenshot visibly passed, but the
post-reopen watched-file comparison was not printed because OCR misread the
first word of both saved messages and the harness stopped at that assertion.
That exact post-reopen hash delta is **not measured**. The UI screenshots and
gate audits were retained. The screenshots stay under `/var/tmp` because the
repository publication hook requires separate review before committing binary
images.

The UI run used an earlier fixture projection that passed owner
`thread/status/changed` while the private turn was active. That status event
has a thread ID but no turn ID, so the final gate now denies it. The focused
regression verifies denial. The two-window UI test was not rerun after this
narrowing; a post-change UI measurement is **not measured**. The visible reply
in the earlier run came from the saved-turn completion projection.

This does not establish personal account attachment, a real owner subscription,
tool parity, multiple simultaneous turns, or public Codex support. The fake
private turn still uses `allowedTools: []` while the fake owner's original turn
exposed 12 model tools.
