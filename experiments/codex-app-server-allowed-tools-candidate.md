# Candidate Codex app-server startup tool ceiling

This [patch](codex-app-server-allowed-tools-new-thread.patch) targets the
official Codex source tag
[`rust-v0.155.0-alpha.9.2`](https://github.com/openai/codex/tree/rust-v0.155.0-alpha.9.2),
commit `4607249e430dac1c961df4dc615beae88e33cec8`. That version matches the
installed `codex-cli 0.155.0-alpha.9.2`. The patch was prepared in a disposable
source clone. It has not been applied to the installed binary or the maintained
Desktop source tree.

The patch adds an experimental `allowedTools` field to `thread/start`. Each
entry has a tool `name` and optional `namespace`. When the client supplies the
field, the app-server passes it into the core session's startup `AllowedTools`
ceiling. An omitted field keeps existing behavior. An explicit empty list
permits no model tools. The included app-server test starts two disposable
threads and checks their mock model tool inventories for a single allowed tool
and an empty list.

This candidate covers new threads only. The matching source does not provide
the same field for `thread/resume` or `thread/fork`, and a live thread cannot
have its captured startup ceiling changed through this patch. Direct
app-server RPC tool calls are outside this model tool inventory gate.

Validation status in a disposable checkout at the exact tag:

- `git apply --check` passed against a clean checkout.
- `cargo check -p codex-app-server -p codex-app-server-protocol --locked --offline`
  passed after Cargo refreshed the upstream lock file in the disposable
  checkout. The tag's original lock file records several workspace crates at
  `0.0.0`, so the first `--locked` invocation refused to update it. The patch
  does not include that generated lock file change.
- The focused standalone integration test compiled and passed: 1 test, 0
  failures. It inspected two mock model requests. One advertised
  `exec_command` and excluded `view_image`; the other advertised no tools.
  Run it with `cargo test -p codex-app-server --test allowed_tools
  thread_start_allowed_tools_limits_model_inventory` after resolving the lock.
- A baseline run with the production patch removed did not reach an assertion.
  GNU `ld` timed out twice while linking, after 3 and 5 minutes. Test
  sensitivity against the unpatched source is therefore not measured. A first
  attempt to run this assertion inside the aggregate `tests/all.rs` binary
  also timed out while linking after 10 minutes, which is why the patch now
  carries a standalone test binary.

This is source and mock-model evidence only. The installed Codex executable,
the person's running Desktop session, real account data, and model tool
routing in an Orbit session were not changed or tested by this patch.
