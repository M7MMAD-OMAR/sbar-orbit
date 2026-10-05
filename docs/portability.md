# Portability to another machine

Orbit is intended to resolve the installing user's paths and available software.
It does not require the developer's account name or checkout directory. Support
is still a capability contract, not a promise that all applications run on all
devices. Installation success does not measure session behavior or performance.

## Choose the capability first

| Capability | Required environment | Limit |
|---|---|---|
| Owned browser session | Supported Chrome or Chromium-family browser, Bun, and the platform's resource budget prerequisites | Linux, Windows and macOS have different measured coverage. Firefox is not the CDP browser backend |
| Private desktop application | Linux, compatible native runtime, and the prerequisites reported by the installer | An application's toolkit, dependencies and process behavior can still prevent it from running. Windows and macOS have no supported native display backend |
| Existing application handoff | Exact prepared Hyprland compositor and plugin, explicit owner configuration, and a supported Wayland client | Other compositors, Xwayland applications and independently connected helper clients are unsupported. Universal application support is not measured |
| Profile or account reuse | Supported platform, browser or application adapter, storage and credential prerequisites | A fresh session working does not prove an authenticated profile can be reused. Browser profile cloning is refused on Windows and macOS |

The evidence and limitations are recorded in [support tiers](support-tiers.md),
[existing application handoff](existing-application-handoff.md) and
[personal state](personal-state.md). A new architecture, GPU, distribution or
application needs its own result. No measurement here proves every device works.

The named `launch-app` adapters currently cover VS Code, Codex and Zen. They
copy application-specific state and validate supported installation shapes;
they are not a generic mechanism for every editor or browser. In particular,
Codex integration requires the supported package features or a validated
candidate manifest, and Zen integration requires its supported Linux Flatpak
installation. Generic private application launch takes an absolute executable
path and an explicit toolkit, so a different executable name can be supplied
without pretending its account or preferences have a supported adapter.

The stable official Linux VS Code adapter resolves the installed `code` command
from `PATH`, including a symlink to its `bin/code` launcher, and selects the
application ELF beside that launcher. It also checks the standard
`/usr/share/code/code` installation. For another installation prefix, set
`ORBIT_VSCODE_EXECUTABLE` on the broker to the absolute application ELF path.
Discovery checks executable permissions, ELF magic and the official stable
product identity in `resources/app/product.json`; it never runs the host
launcher to discover the application. VSCodium, Code OSS, Insiders and Flatpak
wrapper launches are not supported by this profile adapter. Discovery fixtures
cover alternate prefixes and paths with spaces. Their passing does not measure
an application window or authenticated service on another machine.

## Check an external installation

Follow [agent installation](agent-install.md). On Linux or macOS, first run
`./install.sh --dry-run --json`; on Windows run `install.cmd --dry-run --json`.
Read missing prerequisites and refusal reasons before running the actual
installer. A native runtime installation is a separate step described by that
contract.

After installation, run `sbar-orbit doctor --report`, or
`sbar-orbit.cmd doctor --report` on Windows. Then test the intended capability
against disposable content on the new host. Use a fresh owned browser first,
then test account reuse, private applications or configured handoff separately.
Record the OS and architecture, application version, startup time, action
result, frame capture, pause/resume and cleanup outcome. An unrun check remains
`not measured`.

The repository's bounded verification command is `bun run verify`. Native
runtime checks additionally use `ORBIT_TEST_NATIVE=1 bun run verify`. Run one
bounded command at a time because they share a resource budget. Fixture tests
for alternate home directories or desktop entries prove those discovery rules;
they do not measure a physical Windows, macOS or other Linux machine.

## Portability regression coverage

The portability audit adds regression coverage for a declared home directory
that differs from the running test account, home and installation paths with
spaces, browser wrapper locations, and user desktop-entry overrides. These are
reproducible input variations rather than assumptions about the developer's
machine. The regression suites are
[shell portability](../tests/shell-portability.test.ts),
[browser discovery](../tests/browser-discovery.test.ts),
[host desktop entries](../tests/host-browsers.test.ts),
[VS Code executable discovery](../tests/native-vscode-discovery.test.ts) and
[workspace storage](../tests/workspace-storage.test.ts).
See the current validation results before claiming a capability is measured on
another host.
