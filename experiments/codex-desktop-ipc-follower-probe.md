# Disposable Codex Desktop IPC follower probe

Status on 30 September 2026: transport and trust-boundary evidence, not a
personal app attachment. The installed ASAR was read as a source with SHA-256
`8889a6e9aeba678a5d77876bcc9cfce3168ab47cc7bb4ba5856f80a3a32157a8`.
The person's Codex window, profile, and IPC socket were not connected to or
modified. All dynamic requests used a copied Desktop and a fake account under
`/var/tmp/codex-private-smoke-u` on a private Xvnc display.

The installed ASAR contains a Unix IPC router at `$CODEX_HOME/ipc/ipc.sock`.
Its four-byte little-endian framed JSON transport registers clients and
forwards requests by method and `client-discovery-response`. Its inspected
handlers include `thread-owner-discovery`,
`thread-follower-load-complete-history`, and follower methods for starting,
steering, interrupting, and editing turns. This is a built-in route for
coordinating windows, but the inspected router accepts a client-supplied
`clientType` during registration. Socket ownership and mode alone do not
authenticate a follower as an Orbit window or constrain its methods.

The fixture runner has an opt-in `--ipc-probe` mode:

```sh
bun run scripts/limited.ts timeout 100s /usr/bin/python3 \
  experiments/codex-cold-reply-fixture/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-u . \
  --ipc-probe
```

In the first run, the copied owner used a fake ChatGPT account, created one
synthetic saved thread through its disposable app-server, and opened its own
IPC router. After 30 seconds, a registered probe client's
`thread-owner-discovery` returned `no-client-found`. The private owner window
had loaded ChatGPT Work but showed no projects or chats because the fake
account lacked Work access. The synthetic thread was not displayed in this
owner window.

The first private capture is
`/var/tmp/codex-private-smoke-u/ipc-owner-d59c1703.jpg`.

The same router then accepted a second fixture client with an arbitrary
`clientType`. That client advertised ownership of the synthetic thread and
answered the discovery request. A fresh probe received a successful response.
The measured output was:

```json
{"ipcSocketPresent":true,"discoveryResultType":"error","discoveryError":"no-client-found","ownerFound":false,"syntheticOwnerFound":true}
```

This proves that the copied router carries discovery requests and that a
same-user client can claim a fixture thread without a separate router
credential. That fake owner did not provide conversation history.

The follow-up run logged in to the disposable app-server with a fixture-only
API key. The copied Desktop then displayed its synthetic project and saved
conversation on private Xvnc. Its window showed the user text
`Private fixture conversation` and assistant text
`Orbit completed fixture answer`. A separate IPC client discovered this real
Desktop owner. The first history request used version 1 with a `hostId`; the
installed bundle requires version 2 for a follower method carrying `hostId`.
With version 2, the owner handled the request but could not publish a revision
because no client was registered as following the thread. Closing the direct
app-server WebSocket did not change that result.

The fixture probe then sent `thread-stream-following-changed` with
`following: true` to the discovered owner. The owner published a
`thread-stream-state-changed` snapshot to the probe, and
`thread-follower-load-complete-history` completed successfully. The snapshot
contained both fixture turns. The history request returned a revision, not
the turns themselves, so the IPC snapshot is the evidence of shared content.
The private screenshot for this run is
`/var/tmp/codex-private-smoke-u/ipc-owner-86945f84.jpg`.

```json
{"ipcSocketPresent":true,"discoveryResultType":"success","ownerFound":true,"historyResultType":"success","snapshotPresent":true,"snapshotUserTextPresent":true,"snapshotAnswerTextPresent":true,"syntheticOwnerFound":true,"appServerAccountIdPresent":false}
```

The `--dual-window-probe` mode starts a second copied Desktop on another
private Xvnc display. Each window has its own `CODEX_HOME`, home, runtime,
user data, and display. The fixture mounts only the fake owner's IPC
directory into the second window's IPC path and attaches its app-server
connection to the fake owner. The installed app refuses an attach-only
window whose `CODEX_HOME` equals the owner's, so this separate home is
required. The command is:

```sh
bun run scripts/limited.ts timeout 120s /usr/bin/python3 \
  experiments/codex-cold-reply-fixture/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-u . \
  --dual-window-probe
```

The second window displayed the saved fixture conversation. A new turn was
then started through the disposable app-server after both windows were open.
The second window displayed the new user text `Second window live update`
and the model response `Orbit owner preflight answer`. The final private
capture is
`/var/tmp/codex-private-smoke-u/ipc-second-live-e804a361.jpg`.
The latest run returned:

```json
{"ownerFound":true,"historyResultType":"success","snapshotPresent":true,"secondUserTextPresent":true,"secondAnswerTextPresent":true,"secondLiveUserTextPresent":true,"secondLiveAnswerTextPresent":true,"appServerAccountIdPresent":false}
```

This establishes a functional read and live update path for a synthetic
conversation in two separate copied Desktop windows. It does not establish
access to the person's account, current conversations, or other apps. The
second window had no visible composer in the captured state, so the run does
not demonstrate sending a turn from that window. It also does not authorize
mounting the personal IPC socket in an Orbit session. The router accepts
arbitrary same-user clients, and its follower API includes write methods.
A trusted gate needs an explicit account, thread, and method scope before
any personal IPC route is used.

The fixture's `--ipc-gate-probe` mode tests a narrow application-level gate.
The trusted test process pins one synthetic thread and owns the fake owner
IPC connection. It serves only `thread.snapshot` for that thread. A separate
Bubblewrap child has the owner IPC directory and app-server socket hidden by
private mounts. It can reach the gate socket, read the selected snapshot, and
receives `denied` for a follower write method and a different thread. Run:

```sh
bun run scripts/limited.ts timeout 100s /usr/bin/python3 \
  experiments/codex-cold-reply-fixture/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-u . \
  --ipc-gate-probe
```

```json
{"ownerSocketHidden":true,"appSocketHidden":true,"readAllowed":true,"userTextPresent":true,"answerTextPresent":true,"writeDenied":true,"otherThreadDenied":true}
```

This gate is a small read-only protocol probe, not a replacement IPC router
for a full Desktop window. Its mount test hides two known fake socket paths;
it does not prove that every other local IPC path, descriptor transfer, or
network route is blocked. The [separate seccomp experiment](seccomp-unix-connect-broker-probe.md) documents other
UNIX socket bypasses and compatibility limits. A production gate also needs
session-bound access, socket identity checks, bounded lifetime, and failure
handling before connecting to any personal authority.

The `--dual-window-router-relay-probe` mode adds a framed IPC relay for a
full second Desktop window. The second window has its own `CODEX_HOME`. Its
IPC path points to the relay, and the fake owner's IPC directory is hidden
inside that window's mount namespace. The relay pins one thread and host
`local`. It accepts registration and following state for that thread, and
forwards only matching owner snapshots and following state. It discards
unneeded cache and client status broadcasts. Owner discovery challenges are
answered with `canHandle: false`, so the follower cannot claim ownership.
Run the bounded fixture:

```sh
bun run scripts/limited.ts timeout 120s /usr/bin/python3 \
  experiments/codex-cold-reply-fixture/run-orbit-switch-codex.py \
  /var/tmp/codex-private-smoke-u . \
  --dual-window-router-relay-probe
```

The second window displayed the saved conversation and the later live user
turn and model answer through the scoped relay. Its final private capture is
`/var/tmp/codex-private-smoke-u/ipc-second-live-7c477638.jpg`.
The same run launched another isolated client against the relay. The fake
owner IPC path and direct app-server socket were hidden from that client.
The relay rejected a follower write request, discovery for another thread,
a following broadcast with a forged client ID, and a following broadcast for
another thread. Measured policy result:

```json
{"clientRegistered":true,"ownerSocketHidden":true,"appSocketHidden":true,"writeDenied":true,"otherThreadDenied":true}
```

The relay's own counters recorded one rejected `thread-follower-start-turn`
request, one rejected `thread-owner-discovery` request, and two rejected
following broadcasts. It also blocked owner discovery directed at the
follower, while the second Desktop still received 13 owner state broadcasts
for the pinned thread. This is a disposable compatibility and policy proof.
It is not yet wired into Orbit's attached Desktop launcher. The attached
window still needs the existing app-server authority gate, and the broader
UNIX socket and descriptor isolation gaps remain open before any personal
profile can use this route.

An additional run of the existing fixture without `--ipc-probe` passed owner
account inspection and cold thread activation, then failed while waiting for
a second model answer through its attached UI. Its captured private window
showed the saved thread but had no composer. The fixture's fake ChatGPT
account had previously lacked Work access. This result leaves that older UI
write path unverified in the current run; it does not weaken the separate
read-only IPC snapshot measurement above. The failed capture is
`/var/tmp/codex-private-smoke-u/orbit-client-after-write-first.jpg`.
