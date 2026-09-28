# Codex private network transport probe

Status on 28 September 2026: disposable transport proof. No production Codex
authority or executor uses this topology.

The installed Codex CLI accepts an app-server Unix socket and an exec-server
WebSocket listener. A host loopback exec-server listener is reachable by another
host process, as measured in `experiments/codex_executor_boundary_probe.py`.
Two new probes instead create a user and network namespace with a private
loopback interface.

`experiments/codex_private_net_route_probe.py` places a disposable app-server,
exec-server, and mock model in that namespace. It checks that the exec-server
owns its listener, a sibling in the host network namespace cannot connect to
the listener, and a model-driven `exec_command` runs in the selected executor.

`experiments/codex_private_unix_client_probe.py` checks the intended client
topology more directly. A separate host process connects to the app-server's
Unix socket. It initializes, registers the private exec-server through
`environment/add`, selects that environment on a new ephemeral thread, and
starts a model turn. The command output contains the executor-only marker.
The mock model's next request contains that marker and no authority marker.
The host process still cannot connect to the executor's TCP loopback port.

Both probes passed under the shared Orbit resource budget:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex_private_net_route_probe.py
bun run scripts/limited.ts /usr/bin/python3 experiments/codex_private_unix_client_probe.py
```

Each probe uses temporary homes and a local mock model. Neither starts Codex
Desktop, reads the person's original Codex profile, uses an account, or opens
the person's display. The second probe shares its temporary file paths across
the host and private network namespace. It proves network transport and
selected shell execution, not filesystem isolation.

This topology requires the app-server authority itself to run in the private
network namespace. The person's currently running Desktop app-server remains
in the host network namespace. Moving or replacing that authority, attaching
the original Desktop client to its Unix socket, granting model network access,
isolating files and GUI tools, and proving two simultaneous Desktop clients are
separate work. The Unix socket's private directory restricts access by other
users, but a host process with the same user identity and path can connect.
Session ownership needs an additional enforced boundary before this can be
used with the person's live account and apps.
