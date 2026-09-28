# Candidate dynamic tool owner routing

This [patch](codex-dynamic-tool-owner-optin.patch) targets the exact Codex source tag `rust-v0.155.0-alpha.9.2`, commit `4607249e430dac1c961df4dc615beae88e33cec8`. It was prepared in `/var/tmp/orbit-codex-tool-owner-optin`. Apply this zero-context patch with `git apply --unidiff-zero`. The patch has not been applied to the installed executable, the person's Desktop application, or Orbit's write gate.

The existing [two-client red fixture](codex-two-client-tool-owner-red.md) measured a dynamic tool request reaching both subscribers of one thread. The second client answered first, and the model consumed its result even though the first client initiated the turn.

The patch adds an opt-in experiment controlled by `CODEX_APP_SERVER_DYNAMIC_TOOL_OWNER_EXPERIMENT=1`. When Core reports a newly started turn, the app-server records the initiating connection and turn ID. A dynamic tool call for that turn is sent only to the recorded connection. The pending callback accepts a response or error only from that connection, and the request is excluded from replay to other subscribers. If the owner is missing, no request is sent and the callback closes. Disconnecting the owner resolves its pending callback with an error. With the environment variable absent, the existing request path remains in use.

The [green fixture](codex-two-client-tool-owner-green.py) is a copy of the red fixture with only the opt-in environment variable added to its temporary app-server environment. Its assertions require one owner tool request, zero requests to the other client, and only the owner's result in the mock model follow-up.

## Validation

- `git apply --check --cached --unidiff-zero` passed against the unchanged source index at the exact tag.
- `cargo check -p codex-app-server --offline` passed in 2 minutes 32 seconds through Orbit's shared resource budget. Cargo refreshed the checkout's lock file; that lock file is excluded from the exported patch.
- The green fixture parses as Python. It has **not run** against a newly built executable.
- A bounded `cargo rustc -p codex-cli --bin codex --offline` with Clang and the locally extracted mold linker exited 124 at 360 seconds while compiling `codex-core`. It produced no verified candidate executable. The previous executable in the shared target directory belongs to an earlier experiment and must not be used as evidence for this patch.
- A second bounded build targeted `codex-app-server` directly with the same compiler and linker. It exited 124 at 420 seconds while compiling `codex-core`. No executable from this source patch was produced. Both timed-out build processes were confirmed stopped before another shared-resource test began.
- The new Rust unit test for owner-only delivery, nonowner response rejection, and replay exclusion is included in the patch but has **not compiled or run** because regular `cargo check` does not compile `cfg(test)` code.

This is a source candidate with a passing production-code typecheck, not a demonstrated green two-client result. The opt-in route covers dynamic tool callbacks only. Other interactive server requests remain shared. A second client can still steer a running turn. The owner is registered after `start_or_steer_turn` returns, so an unusually early dynamic tool event could arrive before registration and fail closed. Review, a compiled test target, and a full red/green run are still required before integration. Account continuity, existing-thread write safety, Desktop behavior, and all other applications remain unmeasured by this experiment.

Core provides `start_turn_if_idle`, which can reject an input when a turn is already active. It is a possible starting point for an opt-in steering rule, but it is not part of this patch and has not been tested here.
