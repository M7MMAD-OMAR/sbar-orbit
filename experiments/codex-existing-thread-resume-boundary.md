# Saved thread resume boundary in a disposable Codex account

This probe used the installed `codex-cli 0.155.0-alpha.9.2` executable from
exact source commit `4607249e430dac1c961df4dc615beae88e33cec8`. It used a
temporary `CODEX_HOME`, a local mock model, one synthetic conversation, and two
WebSocket clients. It did not open a personal Codex profile or Desktop window.

Run it with:

```sh
bun run scripts/limited.ts timeout 120s env \
  ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-red-turn-isolated \
  ORBIT_CODEX_TEST_BINARY=/usr/lib/chatgpt/resources/codex \
  python3 experiments/codex-existing-thread-resume-boundary.py
```

Two complete runs exited `0`. The final raw output is saved in
`experiments/codex-existing-thread-resume-boundary-green.json`.
Both complete runs recorded the rollout event type.
All file comparisons include SHA-256, size, and nanosecond mtime. The baseline
for the cold checks was taken after the restarted app server opened its socket
and its Codex files stopped changing. This separates startup activity from
the subsequent RPCs.

| State and call | Result | Tracked Codex file changes |
| --- | --- | --- |
| Already loaded, second client `thread/read` with `includeTurns:false` | Returned metadata | None |
| Already loaded, second client `turn/start` without `thread/resume` | Accepted and completed | This is a write turn, so it is excluded from read and resume comparisons |
| Already loaded, second client `thread/resume` with `excludeTurns:true` | Returned model `gpt-5.1`; owner metadata still reported the same model | None between settled pre-call and post-call snapshots |
| After server restart, second client `thread/read` with `includeTurns:false` | Returned saved thread metadata | None |
| After that read, second client `turn/start` without resume | Rejected, JSON-RPC `-32600`, `thread not found` | Not a successful turn |
| Cold `thread/resume` with `excludeTurns:true`, before any new turn | Returned model `gpt-5.1` | Rollout JSONL, SQLite WAL and SHM files, and a new writer lock |
| Second client `turn/start` after cold resume | Accepted and completed | Measured separately from the resume snapshot |

In the final run, cold resume appended one JSONL record to the synthetic
rollout: `event_msg` with payload type `thread_settings_applied`. The rollout
grew from 38,593 to 39,384 bytes. The exact changed paths between the settled
baseline and the resume response were:

- `sessions/2026/09/29/rollout-2026-09-29T03-28-48-01a0ea59-7cee-7b72-b3b7-4b8a80c95153.jsonl`, contents, size, and mtime changed.
- `thread_history_1.sqlite-wal` and `thread_history_1.sqlite-shm`, contents changed.
- `state_5.sqlite-wal` and `state_5.sqlite-shm`, contents changed.
- `queue_1.sqlite-wal` and `queue_1.sqlite-shm`, contents changed.
- `goals_1.sqlite-wal` and `goals_1.sqlite-shm`, contents changed.
- `thread-writer-locks/01a0ea59-7cee-7b72-b3b7-4b8a80c95153.lock`, created as a zero-byte file.

No SQLite main database file changed between those two snapshots. In the
other complete run, only the mtime of `goals_1.sqlite-wal` changed. The
exact auxiliary changes can vary between runs. Both runs changed the rollout,
state WAL, queue WAL, thread history WAL, and lock.

The source explains the boundary. `turn/start` resolves only an already loaded
thread from `thread_manager.get_thread`, while metadata `thread/read` builds a
view from the store without loading a session. A cold `thread/resume` reads
history and configuration, creates a live session and writer, and subscribes
the requesting connection. On paginated history it also calls
`persist_thread`. On a loaded thread, `thread/resume` subscribes the second
connection and calls `set_app_server_client_info` on the shared live session.
That client-info effect is a source finding; this fixture did not expose the
in-memory value. Resume overrides can also replace an idle loaded session
when no clients are subscribed, so this fixture used no overrides.

The loaded `turn/start` success did not grant the second client a completion
notification. Before it resumed or subscribed, the owner connection received
the completion. The final fixture counted two owner completions, including
the earlier owner turn, and zero private completions before resume.

This evidence covers one exact executable, one synthetic paginated saved
thread, and these RPCs. It does not establish a safe read-only attach path for
real accounts, nor a general authorization boundary between clients. A cold
resume is a write operation even when `excludeTurns:true`.
