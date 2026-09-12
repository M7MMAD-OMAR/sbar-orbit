<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/lockup-latin-white.png">
  <img src="brand/logo/lockup-latin-blue.png" alt="Sbar Orbit" width="240">
</picture>

# Sbar Orbit

Local application workspaces for tool-capable AI agents. The mark is two surfaces offset on the diagonal: the screen you keep, and the one Orbit opens beside it. They never touch. [Brand](docs/brand.md).

**Experimental alpha, Apache-2.0.** Orbit gives an agent an owned browser or private Fedora display. You can keep working, open a viewer when needed, pause, take control and resume. It does not attach to your personal browser profile.

```mermaid
flowchart LR
    Host[Agent host] -->|MCP or local API| Broker[Orbit broker]
    CLI[CLI] --> Broker
    Broker --> Browser[Owned browser]
    Broker --> Native[Private Fedora display]
    Broker --> Viewer[Optional viewer]
```

## What is actually supported

Orbit is measured on exactly one host class: Fedora 44, wlroots, cgroup delegation. There is no macOS,
Windows or non Fedora Linux machine in this project's reach, so every statement about those platforms is
reasoning about vendor documentation and not a test. `sbar-orbit doctor --report` prints which row of the
[support tiers](docs/support-tiers.md) applies to your machine; it needs no broker, and it is safe to
paste into an issue.

`Reasoned` means installing here produces a test report, not a bug report. `Refused` means a primary
source says it cannot work, so Orbit throws `UNSUPPORTED` rather than degrading quietly, and the tracker
does not accept a bug for it. `Failed` means it ran here and did not pass, and the result is kept rather
than retried into silence.

**No telemetry.** No counters, no ping, no crash upload, no opt in prompt. The only thing that ever
leaves the machine is a report you generated, read and pasted yourself.

## Start

Requires Linux user cgroup delegation, Bun and Chrome/Chromium. The native backend needs the separate [Fedora bootstrap](docs/fedora-results.md).

```sh
bun install --frozen-lockfile --ignore-scripts
./bin/sbar-orbit service install
```

That installs the broker and the desktop mark and starts both with your desktop, which is the default: a
thing meant to be waiting for your agents should be running. `./bin/sbar-orbit service install
--no-autostart` writes the units and enables nothing. To run it in the foreground instead, use
`./bin/sbar-orbit serve`, which prints a socket path to set as `ORBIT_SOCKET` in another terminal.

Then `./bin/sbar-orbit session create`, or generate MCP configuration with
`./bin/sbar-orbit connector-config`. A right click on the mark opens the settings, which are searchable,
and `./bin/sbar-orbit config search WORD` is the same settings from a terminal. [CLI guide](docs/cli.md).

## Scope

The alpha includes browser/native lifecycle tests and a successful scripted 10-minute viewer run. See [validation](docs/validation.md). Human participation, wider account/application compatibility, clean-machine installation, macOS and Windows remain separate gates.

Display separation is not a security sandbox. Applications retain the OS user's permissions. Closed agent applications without custom tools are not automatically supported.

| Guide | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | Components and control flow |
| [Stories and acceptance](docs/acceptance.md) | User outcomes and checks |
| [Roadmap](docs/roadmap.md) | Remaining milestones |
| [Connectors](docs/connectors.md) | MCP host setup |
| [Resource limits](docs/resources.md) | Aggregate CPU/RAM limits |
| [Preview](docs/preview.md) | Viewing, takeover, tabs and surface size |
| [Theming](docs/theming.md) | Matching the desktop colour scheme |
| [Accounts](docs/accounts.md), [files](docs/files.md) | Explicit shared state |
| [Packaging](docs/packaging.md) | Versioned source artifacts |
| [Research](docs/research.md) | Primary technical sources |
| [Separate workspace review](docs/separate-workspace-review.md) | Whether this is the best approach, what was refuted, and what a real session costs |
| [Porting](docs/porting.md) | How the approach ports to other Linux desktops, to Windows and to macOS, by capability tier |
| [Support tiers](docs/support-tiers.md) | What is known to work, on which host class, on what evidence, and which report to file |
| [Autonomy](docs/autonomy.md) | Running without a human checkpoint: the policy, the prior art it borrows from, and what bounds it |
| [Desktop presence](docs/desktop-presence.md) | Status source, edge panel and working indicator, what remains proposed |
| [Appearance](docs/appearance.md) | Applications in a private display look like the desktop |
| [Brand](docs/brand.md) | The mark, the name, the palette and where each asset is used |

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)
