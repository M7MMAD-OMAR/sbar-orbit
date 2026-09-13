<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/lockup-latin-white.png">
  <img src="brand/logo/lockup-latin-blue.png" alt="Sbar Orbit" width="240">
</picture>

# Sbar Orbit

Local application workspaces for tool-capable AI agents. The mark is two surfaces offset on the diagonal: the screen you keep, and the one Orbit opens beside it. They never touch. [Brand](docs/brand.md).

**Experimental alpha, Apache-2.0.** Orbit gives an agent an owned browser or a private display of its own. You can keep working, open a viewer when needed, pause, take control and resume. It does not attach to your personal browser profile.

```mermaid
flowchart LR
    Agent["Any agent host"] -->|MCP| Broker
    CLI["sbar-orbit CLI"] -->|"local socket"| Broker

    subgraph orbit["Orbit, inside one shared CPU and memory budget"]
        Broker["Broker"]
        Browser["Private browser, one per session"]
        Display["Private display, one per session"]
    end

    Broker --> Browser
    Broker --> Display

    subgraph yours["Your desktop, which none of this touches"]
        Screen["Your windows, pointer and keyboard"]
        Viewer["Viewer, open it when you want it"]
    end

    Viewer -.->|"watch, pause, take over, resume"| Broker
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
git clone https://github.com/M7MMAD-OMAR/sbar-orbit
cd sbar-orbit
./install.sh
```

One command, and it shows every step as it happens. It checks what the machine already has, prepares
dependencies from the frozen lockfile, links the `sbar-orbit` command into `~/.local/bin`, installs and
starts the broker service and the desktop mark, writes the agent connector configuration, then verifies
that the installed broker answers. `./install.sh --dry-run` reports the same steps and changes nothing.

It installs nothing that needs root. Bun, a browser and the capture tools stay your package
manager's job, and the run prints the exact command for each one it finds missing rather than reporting
a success you would discover was false minutes later. It is not a measurement either: it says what was
installed, not what was proven to work.

### Or from a package registry

The package is shaped for `bun add -g sbar-orbit`, then `sbar-orbit install`, and that shape was checked from a locally built tarball. Nothing is published yet, so until a release lands the checkout above is the path that has been run to completion. [Packaging](docs/packaging.md) has the details and the limits.

### Or hand it to an agent

Any agent with a shell can do the whole installation. Give it the Orbit source directory and this:

```text
Install Sbar Orbit on this machine.

1. Clone https://github.com/M7MMAD-OMAR/sbar-orbit into a directory that will stay where it is, and
   work there. If I have already given you the source, use that instead and clone nothing.
2. Read docs/agent-install.md in that directory. It is the contract. This message is only the trigger.
3. Plan before acting: run ./install.sh --dry-run --json and read the JSON. Branch on the fields,
   never on the prose.
4. Run ./install.sh --json. Exit 0 means installed, exit 1 means not installed. Read steps[] to see
   which step stopped it.
5. Run a remedy only when its agentMayRun is true. Everything else is mine: print its command, or its
   message and packages when it carries no command, and stop. Never run it yourself, never add sudo
   to a command that does not have it, and never use sudo for anything.
6. Report back: every step with its state, the capabilities object, and the remedies you did not run.
   Say plainly what is installed and what is not. Do not describe an installation as verified: the
   run reports installation state, not a measurement.
7. Do not open, automate, read or copy my own browser profile at any point, for any reason.
```

The prompt is short on purpose: it points at [the contract](docs/agent-install.md) rather than
restating it, so it cannot drift away from the installer. The contract carries the commands, the JSON
shape, the exit codes, every refusal an agent should expect, and the `agentMayRun` flag that marks the
line between what an agent may run and what it hands back. No model, host or vendor is assumed:
it needs a shell and the ability to read JSON.

The individual steps remain available, which is what to reach for when only one of them is wanted:

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

## Main agent commands

With the Orbit skill selected, type just `off`, `on`, or `status`. For example:
`$sbar-orbit off` or `$orbit-usage off`. The agent resolves the conversation ID.
The default suggestion is `status`, which reads usage state without changing it.
The shell commands below are for direct CLI use.

```sh
export ORBIT_CONVERSATION_ID=unique-task-id  # keep this ID for this conversation
sbar-orbit usage status
sbar-orbit usage off       # reject new Orbit calls in this scope
sbar-orbit usage on        # re-enable only when you ask
sbar-orbit session create
sbar-orbit session observe SESSION_ID --metadata
sbar-orbit session observe SESSION_ID --output /absolute/new-image.jpg
sbar-orbit act SESSION_ID '{"type":"read","selector":"h1"}'
sbar-orbit session stop SESSION_ID
```

MCP has the equivalent `orbit_usage` tool with `mode: "on"`, `"off"` or `"status"`.
Without an explicit conversation ID its switch is connection-local and resets on
reconnect. CLI and MCP share a persistent switch only when launched with the same
ID. A host sharing one MCP process across chats must provide separate scopes.
Off does not close applications, cancel accepted work or remove tool definitions.

The [portable orbit-usage skill](skills/orbit-usage/SKILL.md) makes an explicit
"Do not use Orbit in this conversation" take priority over automatic selection.
It includes setup for CLI/MCP scope and compact observations. Metadata mode avoids
screenshot capture; image mode preserves the title, tabs/windows and dimensions
alongside the image. CLI file output keeps base64 out of the text context.

[Usage, host integration, research and measured limits](docs/agent-interface.md).

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
| [Viewer design](docs/viewer-design.md) | The viewer's palette, elevation and working signals |
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

## Support the work

Orbit is Apache-2.0, runs entirely on your own machine, and sends nothing anywhere: no telemetry, no
account, nothing metered. That is the point of it, and it is also the reason there is nothing behind
it but time.

If it saved you some, you can buy me a coffee:

<a href="https://www.buymeacoffee.com/m7mmadomar"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" width="217" height="60"></a>

A report from a machine this project has never touched is worth as much. Orbit is measured on exactly
one host class, so `sbar-orbit doctor --report` from another distribution, desktop or operating system
is evidence this project cannot produce for itself. [Support tiers](docs/support-tiers.md) says which
report yours is, and [CONTRIBUTING.md](CONTRIBUTING.md) says where it goes.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)
