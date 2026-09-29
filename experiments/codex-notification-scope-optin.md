# Opt-in Codex status notification scope candidate

Status: a disposable, measured source candidate. It is not enabled for a
personal account or installed Desktop app.

The exact Codex source base is `4607249e430dac1c961df4dc615beae88e33cec8`.
The isolated candidate worktree is `/var/tmp/orbit-codex-notification-scope`.
Apply these Orbit patches to the exact tag in order:

1. `experiments/codex-thread-readonly-metadata.patch`
2. `experiments/codex-cold-read-subscribe.patch`
3. `experiments/codex-readonly-metadata-cli-fix.patch`
4. `experiments/codex-notification-scope-optin.patch`, using
   `git apply --unidiff-zero`

The fourth patch is dormant unless
`CODEX_APP_SERVER_ORBIT_STATUS_SCOPE_EXPERIMENT=1`. When enabled, an initialized
client named exactly `orbit_private_attached` receives
`thread/status/changed` only for thread IDs in its in-memory subscription list.
All other initialized clients continue receiving status updates for every
thread. The status sender uses an explicit recipient list and drops an update
when that list is empty. It does not pass an empty list to the existing
broadcast API, where empty means broadcast to everyone. The subscription list
comes from `ThreadStateManager` and is cleaned up on connection close.

The client name is spoofable. This is a routing behavior experiment, not an
authorization boundary. A production version needs a gate-authenticated client
identity rather than a self-reported name. Only `thread/status/changed` routing
changes in this patch. The fixture also checks `turn/completed` on the
subscribed thread, which already uses subscriber routing. It does not measure
every notification method, disconnect races, a third client, a personal
account, or the Desktop interface.

`experiments/codex-notification-scope-two-thread.py` creates a temporary home,
two Unix WebSocket clients and a local synthetic model. The owner saves thread
A, the private client subscribes by resuming A, the owner starts another turn
on A, then creates and turns thread B. The same fixture asserts that the
private client receives A status and completion, the owner receives B status,
and the private client receives no B status. Three local model requests were
observed in each run.

The unpatched exact-tag executable, with SHA-256
`a849370e6df4a9d156950b80b635e6ea43943e1887a86bcd78440a8ef42366c6`,
failed the assertion as expected with exit `1`:

```json
{"experiment":"","modelRequestCount":3,"subscribedCompletionAtPrivate":1,"subscribedThreadStatusAtPrivate":4,"unrelatedThreadStatusAtOwner":2,"unrelatedThreadStatusAtPrivate":2}
```

The patched executable built successfully in 4 minutes 21 seconds using one
bounded `cargo rustc --offline -p codex-cli --bin codex` command with Clang and
mold. With the opt-in flag set to `1`, the same fixture exited `0`:

```json
{"experiment":"1","modelRequestCount":3,"subscribedCompletionAtPrivate":1,"subscribedThreadStatusAtPrivate":2,"unrelatedThreadStatusAtOwner":2,"unrelatedThreadStatusAtPrivate":0}
```

Both fixture outputs also reported CLI version `0.155.0-alpha.9.2` and source
commit `4607249e430dac1c961df4dc615beae88e33cec8`. Python syntax compilation,
source `git diff --check`, and `git apply --check --unidiff-zero` of the fourth patch over its
three prerequisites passed. After the green run, the shared build executable
was restored to the unpatched SHA-256 above and verified. No installed app,
personal profile, window or session was changed.
