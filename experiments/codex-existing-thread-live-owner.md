# Private turn in an existing conversation with the owner still connected

This fixture tests one narrow condition that the earlier saved-thread tool
ceiling probe did not measure: the owner's connection and loaded conversation
stay live while a second client appends a turn to that same saved conversation.
The private client requests `allowedTools: []` for its turn. The owner sends a
new turn afterward through its original connection. All state, accounts,
projects, model responses, and Unix sockets are temporary and synthetic.

The fixture is [codex-existing-thread-live-owner.py](codex-existing-thread-live-owner.py).
It requires source commit `4607249e430dac1c961df4dc615beae88e33cec8`
and app-server version `0.155.0-alpha.9.2`. Its red run used the installed
stock CLI binary only as a process inside a temporary account. Its green run
used the opt-in combined candidate from
[codex-combined-owner-ceiling.md](codex-combined-owner-ceiling.md), whose
direct app-server binary SHA-256 was
`230e0646b084192ad32ecf1d403ad80007ef48ae2a73dc63a6e020c85a5f182d`.
No personal profile, Desktop app, screen, pointer, or installed binary was
changed.

## Reproduce

Run one command at a time inside the shared Orbit resource slice. The red
command is expected to exit 1 on the tool ceiling assertion after printing
its measurement. The green command is expected to exit 0.

```sh
bun run scripts/limited.ts timeout 120s env \
  ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-combined-owner-ceiling \
  ORBIT_CODEX_TEST_BINARY=/usr/lib/chatgpt/resources/codex \
  /usr/bin/python3 experiments/codex-existing-thread-live-owner.py

bun run scripts/limited.ts timeout 120s env \
  ORBIT_CODEX_SOURCE_ROOT=/var/tmp/orbit-codex-combined-owner-ceiling \
  ORBIT_CODEX_APP_SERVER_BINARY=/var/tmp/orbit-codex-combined-owner-ceiling-app-server \
  ORBIT_COMBINED_EXPERIMENT=1 \
  /usr/bin/python3 experiments/codex-existing-thread-live-owner.py
```

## Result

| Check | Stock red | Combined green |
| --- | --- | --- |
| Three distinct turns in one thread | Yes | Yes |
| Saved thread read contains all three input texts | Yes | Yes |
| Owner connection stays open throughout | Yes | Yes |
| Model tools on owner's first turn | 8 | 8 |
| Model tools on private turn requesting `[]` | 8 | 0 |
| Model tools on owner's next turn | 8 | 8 |
| Owner tool inventory unchanged | Yes | Yes |
| Exit status | 1, expected red assertion | 0 |

The exact JSON measurements were:

```json
{"distinctTurns": true, "historyContainsAllThreeInputs": true, "ownerAfterTools": 8, "ownerCompletionNotifications": 3, "ownerConnectionStayedOpen": true, "ownerFirstTools": 8, "ownerInventoryPreserved": true, "privateCompletionNotifications": 2, "privateExistingTools": 8, "sameThread": true, "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8", "version": "codex-cli 0.155.0-alpha.9.2"}
{"distinctTurns": true, "historyContainsAllThreeInputs": true, "ownerAfterTools": 8, "ownerCompletionNotifications": 3, "ownerConnectionStayedOpen": true, "ownerFirstTools": 8, "ownerInventoryPreserved": true, "privateCompletionNotifications": 2, "privateExistingTools": 0, "sameThread": true, "sourceCommit": "4607249e430dac1c961df4dc615beae88e33cec8", "version": "codex-app-server 0.155.0-alpha.9.2"}
```

The green result supports appending a new turn to a loaded, already saved
conversation while the owner connection stays live and retains its original
tool inventory. The private connection received completion notifications for
its turn and the owner's later turn because both clients were subscribed to
the same thread. This is expected shared-thread behavior, but thread access
control and the full notification surface remain unmeasured.

The `thread/resume` call used to subscribe the private client can change
in-memory client information on the loaded session. This fixture only verifies
the preserved owner connection, turn order, model tool inventory, and saved
history. It does not prove all owner settings are unchanged. It does not test
a private Desktop UI, real account, personal conversation, private executor,
full tool access, or all Codex RPCs. The green zero-tool private turn is a
temporary safety ceiling for this fixture, not the user's full capability
goal.
