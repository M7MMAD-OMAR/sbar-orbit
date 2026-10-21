# Install Orbit for native applications

Use Bun and the existing checkout. Do not use sudo, install a browser, copy a
profile, create a private desktop, or bypass the owner input release hold.

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
profile. Preparation initializes protected mode. Approve only the requested
opening action; do not silently enable full control.

Discover the exact applicationId, choose an explicit numbered workspace, then
use `native-open`. Browser and terminal registrations and arbitrary argv are
unavailable. Opening leaves the application open with its normal owner state.
Existing application input and capture retain the compositor crash release hold.
See [CLI](cli.md) and [the contract](desktop-only.md).
