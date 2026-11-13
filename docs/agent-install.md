# Install Orbit for native applications

The latest official release is [0.4.5](release-0.4.5.md). Extract its versioned
source or installable package, verify the SHA-256 sidecar, then use Bun from that
directory. Keep the extracted directory because the installed launcher points to it.

For development, use Bun and the existing checkout. Install without sudo. Work with original
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

## Windows

Use `install.cmd --json` from the checkout, or `install.cmd --dry-run --json` first.
Windows preflight requires Bun 1.4.2 or newer. The command runs the same
`scripts/install.ts` as `./install.sh`, inside the shared job object budget.
By default, a non-dry-run installation attempts to register and start an
account-specific logon task. It is not a system service and does not start before
logon. `--no-service` skips the task; a dry run only reports what would happen.
Check the resulting step status rather than assuming registration succeeded.

Checkout installation is distinct from the unpublished [0.4.3 Windows desktop
candidate](release-0.4.3.md), which has additional acceptance gates. Native
opening, input and capture on Windows are not implemented in the published
release; see [the Windows plan](windows-compatibility-plan.md).

## Installer reference

Every step the installer reports is one of `prerequisites`, `dependencies`, `native`,
`launcher`, `service`, `connector`, `verify`, `hosts`. Each failure carries a remedy
with `needsElevation` and `agentMayRun`, plus a portable `packages` field; commands
are built for dnf, apt, pacman, zypper and apk. Remedies the prerequisite check
emits: `system-tool-systemctl`, `system-tool-systemd-run`, `system-tool-nice`,
`system-tool-python3`, `no-systemd-user-session`, `dependencies-missing`,
`native-compositor-unavailable`. Remedies only the installer produces:
`prefix-not-on-path`, `no-lingering`, `broker-did-not-start`, `broker-silent`.
A passing check is a prerequisite report, not a measurement of application control.
