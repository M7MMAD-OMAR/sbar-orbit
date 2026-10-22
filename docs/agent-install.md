# Install Orbit for native applications

Use Bun and the existing checkout. Install without sudo. Work with original
installed applications and their normal owner state. No profile copy or hidden
substitute desktop is needed.

```sh
./install.sh --dry-run --json
./install.sh --json
./bin/sbar-orbit preflight
./bin/sbar-orbit doctor --report
```

Inspect each command's JSON and exit code. A prerequisite report is metadata,
not application acceptance. `--native` cannot build a private display runtime;
that runtime and its bootstrap were removed.

Host registration requires an explicit `--connect auto` or selected host list.
Without it, preserve existing host settings. Reload the host to load changed
MCP schemas. Preserve unrelated work and never restart a shared broker with
active work. Activation and publication are separate facts.

Original Linux opening requires owner compositor metadata prepared by
`native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY`, and the explicit native
plan and control directory configured for the broker. The preparation directory
contains owner-only transport files, never a separate application HOME or
profile. Preparation initializes protected mode. The owner can select full control in
native-settings or keep protected mode with exact action approval. An existing
explicit request for full control is standing authorization; do not ask again for
each local action.

Discover the exact applicationId, choose an explicit numbered workspace, then
use `native-open`. Original browser and terminal registrations are accepted;
caller-supplied arbitrary argv is outside the registration API. Opening leaves the application open with its normal owner state.
Input and capture require an explicit native handoff and the matching prepared
plugin. The historical incident record is not a permanent policy switch.
See [CLI](cli.md) and [the contract](desktop-only.md).
