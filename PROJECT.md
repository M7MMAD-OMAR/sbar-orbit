# Orbit project brief

Orbit gives a tool-capable agent its own local application workspace while the user keeps working. The user can optionally watch, pause, take control, resume and stop it.

| Question | Current decision |
|---|---|
| Installation | Local Bun source package and CLI; Fedora/Linux alpha |
| Agent connection | MCP for compatible hosts; CLI/local API for custom tool runtimes |
| Application access | Owned headless browser, or a private Fedora Wayland/Xwayland display |
| Viewing | Optional authenticated loopback Canvas viewer |
| Accounts and files | Explicit account snapshots and cooperative selected-file reservations |
| Other platforms | Planned adapters; macOS and Windows remain unverified |

The broker belongs to the OS user. MCP configuration belongs to each host, so Orbit does not need a separate application-control implementation for each model brand. Closed applications without custom tools are not automatically compatible.

The alpha has browser/native integration tests and a successful scripted 10-minute browser/viewer run. See [validation](docs/validation.md). Display separation is not a security sandbox, and same-user applications retain filesystem permissions.

Next milestones: participant-confirmed takeover, repeatable recovery, wider application/account coverage, local install/uninstall, then actual tests on other operating systems. See the [roadmap](docs/roadmap.md), [architecture](docs/architecture.md) and [acceptance cases](docs/acceptance.md).
