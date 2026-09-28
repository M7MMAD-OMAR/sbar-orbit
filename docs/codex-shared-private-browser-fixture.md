# Two Codex clients with one private Orbit browser

Run the disposable integration probe:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-shared-real-orbit-mcp-probe.py
```

The probe creates a temporary Codex home and starts one Codex app-server on a
Unix socket. Two protocol clients connect to that authority. The first starts a
thread with `orbit_private` bound to one real Orbit browser session. A local
mock Responses model calls `orbit_act` to click a button on a local fixture page.
The page's displayed count changes from `0` to `1`, and the fixture receives
exactly one POST.

While the authority is still running, the second client receives the thread
start and idle status notifications. It reads the completed turn through
`thread/turns/list` and confirms the same thread identifier. The second client
then disconnects, reconnects to the same authority, and reads that completed
turn again. This proves client reconnect continuity for this disposable thread.

The installed Codex build does not support `thread/read` with `includeTurns`
for this setup, so the probe uses `thread/turns/list` for the completed turn.
The second client does not receive the detailed `turn/completed` notification;
the completed turn is verified by reading it after the first client's
completion event.

This is a local fixture result. It does not attach to the person's running
Codex Desktop authority, use the person's real accounts or projects, test
authority restart persistence, enforce a positive allowlist of every host tool,
or prove that a real model can use all installed applications. The broker,
browser profile, model, app-server home, and page are disposable. No personal
application profile is opened or changed.
