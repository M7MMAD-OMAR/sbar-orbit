# Orbit project brief

Orbit gives a tool-capable agent its own local application workspace while the user keeps working. The user can optionally watch, pause, take control, resume and stop it.

| Question | Current decision |
|---|---|
| Installation | One command, from the npm registry or a source checkout; Bun and a Chromium browser |
| Agent connection | MCP for compatible hosts; CLI/local API for custom tool runtimes |
| Application access | Owned headless browser, or a private Fedora Wayland/Xwayland display |
| Viewing | Optional authenticated loopback Canvas viewer |
| Accounts and files | Explicit account snapshots and cooperative selected-file reservations |
| Other platforms | Windows and macOS measured at tier `Limited` on a guest and a runner; other Linux families reasoned or container measured |

**Platform state, 20 September 2026.** Fedora 44 with wlroots and cgroup delegation is the one host
class with native rows that are not reasoning. Windows 11 and macOS 26 are `Limited`: the suite, the
install, a broker and a browser session ran on a guest and on a GitHub runner, with no person at
either machine. The private display, the systemd units, D-Bus, the keyring and btrfs snapshots are
Linux capabilities and are not ported. Managed installation and the opt-in update path (adopt, stage,
activate, rollback, timer) exist on Linux only; macOS and Windows refuse managed activation and
scheduling rather than reporting success. See [support tiers](docs/support-tiers.md),
[what Windows measured](docs/windows-measured.md) and [what macOS measured](docs/macos-measured.md).

The broker belongs to the OS user. MCP configuration belongs to each host, so Orbit does not need a separate application-control implementation for each model brand. Closed applications without custom tools are not automatically compatible.

Installation is one command, `./install.sh`, which shows each step as it runs and prints a remedy for every prerequisite only a package manager can supply. It reports installation state, not a measurement.

Orbit has browser/native integration tests and a successful scripted 10-minute browser/viewer run. The suite reads 458 pass, 0 fail, 27 skip across 485 tests in 97 files on this host, 20 September 2026. See [validation](docs/validation.md). Display separation is not a security sandbox, and same-user applications retain filesystem permissions.

Closed milestones since this brief was first written: account coverage against a real service, fresh-machine verification on a container with systemd as PID 1, the native runtime built from tracked source, repeatable recovery including a supervisor killed rather than asked, the first real tests on other operating systems (Windows guest, macOS runner), and managed installation with an opt-in Linux update path, all at their stated tiers.

Still open: a participant-read viewer cost figure closing the resource gate, participant-confirmed takeover, Windows or macOS on a machine with a person at it, managed updates on those two platforms, and two intermittent failures whose cause is not identified. See the [roadmap](docs/roadmap.md), which lists what remains, and [architecture](docs/architecture.md) and [acceptance cases](docs/acceptance.md).
