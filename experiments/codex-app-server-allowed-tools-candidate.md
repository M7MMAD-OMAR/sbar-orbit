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
- A separate copied Desktop fixture used the unchanged installed CLI. Its
  `thread/start` request included `allowedTools: []`, but the local mock model
  received eight tools. The restricted fixture refused the turn and stopped
  both private windows. This measures the old executable's behavior in the
  Desktop path. It does not substitute for a red run of the new source test.

This is source and mock-model evidence only. The installed Codex executable,
the person's running Desktop session, real account data, and model tool
routing in an Orbit session were not changed or tested by this patch.

An executable build was attempted once in the disposable checkout with
`cargo build -p codex-cli --bin codex --locked`, one Cargo job, and the shared
Orbit resource budget. Compilation reached `codex-cli`, but GNU `ld` was still
linking when the 15 minute bound expired. The command exited with code 124.

A second, five minute bounded attempt used Fedora's signed `mold` and
`mimalloc` RPMs extracted under `/var/tmp/orbit-codex-linker.PU0aKm`, without
system installation. `cargo rustc -p codex-cli --bin codex --locked --offline`
passed Clang and mold options only to the final compiler invocation, reusing
the existing Rust libraries. It completed in 22.55 seconds. The resulting
`/var/tmp/orbit-codex-allowedtools-target/debug/codex` reports
`codex-cli 0.155.0-alpha.9.2`, is 2,158,505,344 bytes with debug symbols,
and has SHA-256
`8b623f29d068a7c0cf6492343a23914cb195fc7873e4a8080b8b046a112157ce`.
Its ELF `.comment` section identifies mold 2.40.4 and Clang 22.1.8. The
installed CLI and staged Desktop candidate were not changed. The new binary
has not been placed in the candidate or tested with the person's account.

A separate copy was stripped with `strip --strip-unneeded`, leaving the debug
binary intact. `/var/tmp/orbit-codex-linker.PU0aKm/codex-stripped` is
388,414,840 bytes, below the candidate verifier's 512 MiB ceiling, and has
SHA-256 `ed53e302475acec23b8be11d8da1e04f6665b96d31a963381114ea0df2c9e31a`.
It reports the same CLI version, has no missing dynamic libraries, and retains
the mold identifier in `.comment`. It has not been copied into the Desktop
candidate.
