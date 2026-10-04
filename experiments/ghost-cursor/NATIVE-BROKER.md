# Experimental public native broker backend

Reviewed 4 October 2026. This is a component measurement on the private lab
display, not owner-session acceptance or a production support-tier increase.

## Contract

The broker snapshots owner configuration at startup: absolute
`ORBIT_NATIVE_PLAN` and `ORBIT_NATIVE_CONTROL` paths. Both are required if either
is supplied. The prepared plan binds the compositor process, socket and plugin
ABI. Agent RPC cannot choose these paths, change owner protected/full mode or
substitute an active desktop window. With no configuration, native creation
refuses. `system` remains an alias for the private `fedora` backend.

`session.create` accepts `backend: native`, labels, action policy and a profile
lease label. Browser profiles, accounts and viewports are refused. Native network
origin enforcement is not implemented, so bounded origins and native origin
narrowing are refused explicitly. Action-class narrowing remains available.

`launch` accepts absolute executable argv and optional staged appearance files.
It returns a generated application ID. `windows` returns that application's
generated window IDs. Cursor, move, click, scroll, text, key, state and hide-cursor
require both IDs. `close-application` accepts the owned application ID.
Observation accepts both IDs, or the last explicitly acknowledged target.
Presence is cached acknowledged metadata, not a new desktop sample. Target
coordinates are logical window coordinates; presence scales them to frame pixels.
No capture or input request falls back to a whole display or owner active window.

One persistent Python worker serializes each session's exchanges. Requests are
limited to 64 KiB, replies to 24 MiB, pending exchanges to 128 and request wait
to 20 seconds. Fatal framing or deadline errors begin mandatory cleanup without
a later stop RPC. Worker EOF normally owns cleanup. Recovery after 15 seconds
uses CONT/TERM and then KILL with bounded waits, retaining the failure.
Normal stop copies private worker/application/capture logs into the owner control
directory's `broker-logs` before removing the owned short disk workspace. Failed
cleanup retains that workspace for diagnosis. Unexpected worker exit closes the
parent log descriptor. The native lifecycle is still a cooperative same-user
boundary, not containment against malicious arbitrary code.

## Reproduction and evidence

Use one bounded command at a time. With a prepared private lab and loaded pinned
plugin, run the probe using an absolute repository path:

```sh
bun run typecheck
bun run scripts/limited.ts bun test tests/native-worker.test.ts
bun run scripts/limited.ts /usr/bin/python3 experiments/ghost-cursor/lab.py run LAB -- /usr/bin/python3 ABSOLUTE_REPO/experiments/ghost-cursor/native_broker_probe.py
bun run verify
```

The private proof exercises two public broker sessions, protected launch denial,
owner fixture mode admission, explicit target input readback, foreign-ID refusal,
host-path and mode-change refusal, target-only capture, request replay, pause,
read-policy narrowing, unsupported origin limits, sibling preservation and owned
root/detached-child reaping. A supplied frame is then rendered in GTK, including
normal source EOF and immediate final-frame EOF. It does not activate the owner
display. Raw logs and images are private and excluded from publication.

Earlier attempts are retained as failures: the lab cache was tmpfs and the
workspace storage gate refused it; the old application fixture required a lab
runtime rather than an owned disk runtime; the broker test passed extra session
metadata to strict observation. The final probe uses a private disk cache, a
fixture that verifies both the private lab socket and its owned lease, and exact
session identifiers. Log retention was extended to preserve diagnostics on failed
proofs. These are diagnosed changes, not hidden retries.

The lifecycle negative control removes automatic fatal cleanup and unexpected
exit log release. Both corresponding tests fail. Restoring the fixes makes both
pass, including a real SIGSTOP worker that is reaped without an explicit stop.

## Limits

The managed broker was not restarted or enabled. Public GTK viewer launch,
owner controls UI, owner theme acceptance, accessibility routing, child-client
enrollment, complete clipboard/toolkit/current invariant matrix and concurrent
input remain incomplete. The worker's 10,000-request and 16 MiB reply-cache
limits still bound long sessions; this is not an unlimited streaming view.
The plugin is the O0 prototype. Comparative CPU, memory and latency are
`not measured`, and neither faster operation nor zero overhead is claimed.

## Source binding

Final private probe exited zero. Transport checks: 7 passed, zero failed,
22 assertions. Lifecycle negative control: 2 failed as expected.
Full suite and publication validation are recorded in COMPLIANCE.md.

- `src/session.ts`: `11adea00523cac1f665f5261044ea9ea008ab637676333e15071c2aa659cad05`
- `src/ipc.ts`: `f3008d3f63e2a7567a52753860e42a27cb225b5314f64b2675d472f9fa34f20d`
- `src/hyprland.ts`: `d63513a8d1a2c0eeaeda72ed1d2a7d68247aad3a6dc341208d61f7834ef7a302`
- `src/native-worker.ts`: `9a568a6aa13466f940d024e497d5c5442e3edc0b5c7eb96c08d2b91978ffa376`
- `src/native/session_worker.py`: `713832f95b15718cbcaa4e53f77749536fb50741a4051ef3963d03ba5f92f52d`
- `src/mcp.ts`: `559501a68766027d51f2309a833c6181ea4ddcab5c4adc60f3689f6df50069a5`
- `src/policy.ts`: `654ff21f47d3421fbb3b4a8072a4f082fbd5915041818c8520f64463ac02cc28`
- `src/session-mcp.ts`: `003a3a32e48e9d39f6c726ee5cafbc5d59b187ec8ee8848d9a2d5c870ced43a8`
- `tests/native-worker.test.ts`: `388b92e26507b1114fbf47e1f376cefbbe5d9d3c6f159f6b564de569b62dead7`
- `experiments/ghost-cursor/native_broker_fixture.ts`: `a1d31b4f6a3d85190f56b8eba6104aba43cfd4ab626aa9bc4c4e02e375e433e3`
- `experiments/ghost-cursor/native_broker_probe.py`: `8c8c401aab087c0468a62c4195ddc3a8c4eacac184b9b1c0a7d60cef149587b6`
- `experiments/ghost-cursor/native_broker_application.py`: `c371b2ff6ced0e8972b96ff38ca72962e5783faa5f929cd6ca82581b3ae90c58`
- `experiments/ghost-cursor/native_worker_fixture.py`: `3799de142cae800e47e775e02b7da593a49348d9c8160b3110463236c958b8ef`
