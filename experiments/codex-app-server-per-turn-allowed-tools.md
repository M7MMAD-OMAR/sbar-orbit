# Candidate per-turn Codex model tool ceiling

The [candidate patch](codex-app-server-per-turn-allowed-tools.patch) targets
Codex source tag `rust-v0.155.0-alpha.9.2`, commit
`4607249e430dac1c961df4dc615beae88e33cec8`. It adds an experimental
`allowedTools` list to `turn/start`. The field applies only when the request
starts a new turn. An empty list advertises no model tools. If a thread also
has a startup tool ceiling, the turn list can only narrow it. A restricted
request uses Core's idle-only admission so it cannot steer an active owner's
turn while the list is ignored. Input validation permits at most 512 tool
names, with each name and optional namespace between 1 and 256 bytes.

The [fixture](codex-existing-thread-tool-ceiling.py) uses only temporary homes,
accounts, sockets, a project directory, and a local mock model. It starts an
owner thread with an unrestricted turn, stops the disposable authority, resumes
that saved thread through a private client, sends `allowedTools: []` on the
private turn, then sends an unrestricted owner turn in the same thread. It also
starts a separate unrestricted owner control thread. Each model request is
recorded. The fixture asserts the private turn has zero tools and the owner
inventory after the private turn exactly matches its earlier inventory.

## Red and green measurements

| Binary | Owner before | Private existing turn | Owner after, same thread | Separate owner control | Fixture exit |
| --- | --- | --- | --- | --- | --- |
| Earlier exact-tag new-thread candidate, SHA-256 `ed53e302475acec23b8be11d8da1e04f6665b96d31a963381114ea0df2c9e31a` | 8 | 8 | 8 | 8 | 1, expected red assertion |
| Per-turn candidate, SHA-256 `86a5c5084aa728a4e1882cf25ed6e59fd5c5edeb1285f3ea885e6def79d237b1` | 8 | 0 | 8 | 8 | 0 |

The exact eight owner tools in every owner request in both runs were
`create_goal`, `exec_command`, `get_goal`, `multi_agent_v1`,
`request_user_input`, `update_goal`, `view_image`, and `write_stdin`. The red
private request advertised those same eight names. The green private request
advertised an empty list. All four turns completed against the local mock
model in both runs. The failed red assertion was specifically the private
inventory, which proves the fixture detects the unfixed behavior.

## Build and packaging evidence

- `git apply --check` passed against a separate clean worktree at the exact
  source commit.
- The first bounded `cargo check -p codex-cli --bin codex --offline` found an
  explicit `TurnStartParams` initializer in TUI that needed the new optional
  field. After fixing full initializers, the bounded locked offline check
  passed in 23.70 seconds.
- The first bounded `cargo rustc` compiled the crates but failed at final
  linking because the extracted mold executable could not load its local
  `libmimalloc.so.2`. A bounded incremental link with `LD_LIBRARY_PATH` set to
  that extracted library directory passed in 9.05 seconds. Neither linker
  component was installed systemwide.
- The candidate binary is 2,166,829,592 bytes with debug symbols. Its
  SHA-256 is `86a5c5084aa728a4e1882cf25ed6e59fd5c5edeb1285f3ea885e6def79d237b1`.
  The patch SHA-256 is
  `87d0ded4b77f0e79707ea3775cdd95cfd0b3677fc47663adde74f1d0bb3047af`.
  The fixture SHA-256 is
  `4a5ab98062589834d63aa9247265e5f4080977faee83cdd8cd85d17139d8241e`.

This evidence supports a synthetic saved-thread, turn-scoped model tool
ceiling. Direct app-server RPC tool calls and every other application access
path are outside this patch. Real account continuity, personal Desktop
integration, active-turn rejection, and validation limits were not measured
by this fixture. The person's installed Codex application, personal profile,
windows, pointer, and other applications were not changed.
