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

The copied owner launched a fake account, created one synthetic saved thread
through its disposable app-server, and opened its own IPC router. After 30
seconds, a registered probe client's read-only
`thread-owner-discovery` returned `no-client-found`. The captured private
owner window had loaded ChatGPT Work but showed no projects or chats and said
the fake account lacked Work access. The synthetic thread had been created
through direct RPC and was not displayed in this owner window. This result
does not establish that a Desktop actively showing a Codex conversation
cannot own or share it.

The private screenshot path is printed by the fixture runner. The measured
capture for this run is
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
credential. The fake owner did not provide conversation history, authenticate
an account, or run a model turn. The copied Desktop did not display the
synthetic Codex conversation in this bounded attempt. A private Orbit client
must not receive the raw personal IPC socket as an unrestricted mount:
follower write methods and client
impersonation need a trusted gate with explicit thread and method scope.
The next functional measurement needs two loaded disposable Desktop windows
on one router, with the owner actively displaying a synthetic conversation,
before any claim about live shared history or edits.
