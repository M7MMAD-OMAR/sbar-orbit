# Second client can steer an active Codex turn

The [red fixture](codex-two-client-active-steer-red.py) used the installed
exact-tag Codex CLI only as a disposable app-server. It created a temporary
Codex home, local model endpoint, Unix socket, and project directory. It did
not attach to the person's Desktop, account, files, pointer, or windows.

The first client started a thread and completed a warm-up turn so the second
client could resume it. The first client then started another turn. The local
model held its response while the second client sent `turn/start` with a
distinct marker to that same thread. The safe contract required the second
request to be rejected without changing the first client's active turn.

The bounded run printed `otherRejected: false` and the same `turn.id` for
both clients. Its assertion failed with exit 1. At that point the model had
received the first client's second request and had not released its response.
This proves the second RPC was accepted as steering of the active turn. It
does not prove that the model later consumed the second client's text or that
any host action ran. The fixture released the blocked response and stopped its
temporary app-server in cleanup.

Run from the Orbit repository root:

```sh
ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-source-tag \
  bun run scripts/limited.ts timeout 90s /usr/bin/python3 \
  experiments/codex-two-client-active-steer-red.py
```

The source root's `HEAD` and the installed CLI identify Codex
`rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. The fixture requires both
identities before starting. Its result is a red control for any future
per-client turn admission patch. The current Orbit gate still denies
`turn/start` through the attached private Desktop.
