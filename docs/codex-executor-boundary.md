# Codex executor boundary

Status on 28 September 2026: research finding, no production executor launch.

Orbit can launch Codex Desktop with a private home and a private Fedora display. The
installed Codex CLI also supports an `exec-server` selected through the app-server's
`environment/add` method. The routing probe in `experiments/codex-exec-routing-probe.py`
measured one model-driven shell command in a disposable executor. It did not run
inside Orbit's display or use the person's account.

The installed CLI accepts `exec-server --listen ws://IP:PORT` or `stdio`. A
WebSocket listener on host loopback is reachable by other processes on the
machine. `experiments/codex_executor_boundary_probe.py` started an exec-server
with a fresh temporary `HOME` and `CODEX_HOME`, passed no host display variables,
verified that the listener belonged to that process, and connected from a
separate process. The handshake returned `HTTP/1.1 101 Switching Protocols`.
The probe did not launch a desktop application or pass the original profile
path. Run it with:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex_executor_boundary_probe.py
```

## Integration boundary

`src/fedora.ts` currently starts applications through `src/native/supervise.py`
and waits for a window in the private compositor. A headless executor needs a
separate supervised lifecycle. It must be owned by one `FedoraBackend`, use its
private runtime and Wayland socket, run with the Codex private home mounted by
`src/native/mount_unix.py`, and be reaped before the session directory or home
is removed. Reuse `sweepOwnedGroup` if its supervisor exits unexpectedly.
Startup must verify the endpoint belongs to the child process, not just that a
port answers.

The transport must also be reachable by the selected app-server without
exposing an unauthenticated WebSocket endpoint to other host processes. The
current `environment/add` contract takes a WebSocket URL. The CLI's `stdio`
transport alone does not provide that URL. A shared host loopback port fails
the boundary measured above. A private network namespace shared by the
executor and its authority, or a protocol-supported authenticated transport,
needs a separate proof before enabling this lifecycle.

Even with that transport, executor selection is evidence for model-driven
shell execution only. Each browser, computer-use, and app tool must be checked
for its own routing. Otherwise a shared Codex authority could still operate
the person's host window or browser. No live attachment to the person's
Codex authority should be enabled from this result.

## Required fixture checks before integration

1. A sibling host process cannot complete a WebSocket handshake with the
   private executor, while the selected app-server can.
2. The executor sees the Orbit Wayland socket and selected project, but cannot
   see host display sockets, the original Codex profile, or sibling home files.
3. A normal close, supervisor crash, and session close each terminate the
   executor and remove its endpoint before deleting its private home.
4. Two simultaneous private sessions cannot attach to each other's executor.
5. A model-driven command executes in the selected executor, and every GUI or
   browser tool either routes to that same private session or is unavailable.
