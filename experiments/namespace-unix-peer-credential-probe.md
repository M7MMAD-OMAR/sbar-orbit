# Direct UNIX socket identity in a private mount

Status on 30 September 2026: synthetic proof for one masked host directory.
It did not start or modify a personal app, account, browser, profile, window,
or session.

Run the [fixture](namespace-unix-peer-credential-probe.py) inside the shared
Orbit resource limit:

```sh
bun run scripts/limited.ts timeout 20s /usr/bin/python3 \
  experiments/namespace-unix-peer-credential-probe.py
```

The fixture creates selected and blocked UNIX stream sockets in one disposable
host directory. An outer Bubblewrap mount exposes the selected socket at a
private `/tmp` path through a pinned `O_PATH` descriptor, then covers the host
directory with a private tmpfs. It also creates a private PID namespace and
mounts a new `/proc`. The child connects to the selected socket itself. A
nested Bubblewrap child repeats the connection.

The first version of the probe did not unshare PID. A check for the blocked
socket through `/proc/<host-pid>/root` returned `EACCES` on this machine. That
denial depended on access to the host process, so the fixture now hides host
PIDs instead. Its measured result was:

```json
{"direct":{"selected":"connected","blocked":{"errno":2},"hostRoot":{"errno":2}},"nested":{"selected":"connected","blocked":{"errno":2},"hostRoot":{"errno":2}},"nestedExit":0,"selectedPeerNamespacePids":[2,4],"selectedPeerPidsMatchClients":true,"blockedAccepts":0}
```

The accepting server read `SO_PEERCRED` while both clients were alive. Its
host PID values mapped through `/proc/<pid>/status` to the two client PIDs in
the private namespace. This differs from the
[seccomp connection broker](seccomp-unix-connect-broker-probe.md), where the
server observed the broker's PID. The direct path therefore preserved client
process identity in this fixture while keeping one blocked directory hidden
through a nested mount.

This does not establish complete socket isolation. The outer mount still
binds most of `/`, so other host socket paths remain visible. A shared project
or device mount can also expose a socket created later. Abstract UNIX sockets,
inherited connected descriptors, descriptor transfer, every nested mount
layout, and real application compatibility were not measured. The fixture
does not establish access to any existing account, chat, file permission, or
device. A production design needs a complete inventory and admission policy
for every host path exposed to the private app, while keeping direct client
connections for services that depend on peer credentials.
