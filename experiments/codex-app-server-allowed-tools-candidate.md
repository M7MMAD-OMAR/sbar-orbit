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

Validation status: `git diff --check` passed in the disposable clone. A bounded
Cargo check stopped while downloading upstream dependencies, before
compilation. The focused app-server test has not run. Passing behavior is
therefore not measured. Apply the patch to a clean checkout at the exact tag,
compile both changed crates, and run
`thread_start_allowed_tools_limits_model_inventory` before considering it for
a user-owned Codex build.
