<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/lockup-latin-white.png">
  <img src="brand/logo/lockup-latin-blue.png" alt="Sbar Orbit" width="240">
</picture>

# Sbar Orbit

**Give an AI agent its own browser and desktop, so it stops using yours.**

Orbit opens a private browser or a private display for each agent session, on your own machine.
You keep working while it works. Open a viewer when you want to watch, pause it, take over,
hand it back. Nothing leaves the machine: no telemetry, no account, no ping.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/sbar-orbit)](https://www.npmjs.com/package/sbar-orbit)

<img src="docs/images/viewer-window.jpg" alt="The Orbit viewer in a window of its own: a session rail on the left, the watched page in the middle, take over and hand back above it" width="720">

## Install

Requires [Bun](https://bun.sh) and Chrome, Chromium or Edge.

```sh
bun add -g sbar-orbit
sbar-orbit install --connect auto
```

Or from source:

```sh
git clone https://github.com/M7MMAD-OMAR/sbar-orbit
cd sbar-orbit
./install.sh --connect auto      # Windows: install.cmd --connect auto
```

One command. It checks what the machine has, links the `sbar-orbit` command, starts the broker,
writes the MCP configuration for detected Claude Code, Codex and Hermes hosts, and verifies that
the installed broker answers. Restart those hosts to load Orbit's tools. Nothing needs root, and
`--dry-run` reports every step without changing anything.

Current version: **0.1.0** ([release notes](docs/release-0.1.0.md) ·
[changelog](CHANGELOG.md)).

## Use it

From an agent, through MCP: `orbit_create`, `orbit_act`, `orbit_observe`, `orbit_stop`.
From a terminal:

```sh
sbar-orbit session create                                  # returns a session id
sbar-orbit act SESSION_ID '{"type":"navigate","url":"https://example.com"}'
sbar-orbit act SESSION_ID '{"type":"read","selector":"h1"}'
sbar-orbit preview                                         # the viewer link, to watch or take over
sbar-orbit session stop SESSION_ID
```

To work as **you**, signed in to your own accounts, a session can start from a copy of your real
browser profile. The copy is deleted when the session stops, so nothing the agent does reaches your
own browser:

```sh
sbar-orbit profiles                 # which profiles can be used, and why not when they cannot
```

An agent does the same with `orbit_profiles`, then passes `cloneOf` to `orbit_create` with the
origins the session may reach. See [accounts](docs/accounts.md).

Turn Orbit off for one conversation with `sbar-orbit usage off`, on again only when you ask.

## Supported systems

| System | State | What that means |
|---|---|---|
| Fedora 44, wlroots | **Measured** | Everything: private browser, private display, real-profile sessions, kernel-enforced budget. 458 pass / 0 fail across 485 tests |
| Other Linux | **Reasoned** | The browser backend is expected to work; no host of that class has run the suite here. A report from yours is welcome |
| Windows 11 | **Limited** | Browser sessions and MCP work. No private display, no keyring sessions. Needs Bun 1.4.2+ |
| macOS | **Limited** | Browser sessions and install work. The resource budget is advisory, not a kernel ceiling. Real-profile sessions are refused by design |

`sbar-orbit doctor --report` prints which row applies to your machine. It needs no broker and is
safe to paste into an issue. [Support tiers](docs/support-tiers.md) has the evidence behind each row.

**The honest half of those two rows.** On Windows the suite runs on an 11 guest at 270 pass and 0
fail with 113 skipped, and 113 skips is the honest half of that figure: the private display, the
systemd units, D-Bus, the keyring and btrfs snapshots are Linux capabilities and are not ported.
[What Windows measured](docs/windows-measured.md). On macOS the resource budget is **advisory**, not
a kernel ceiling, because the platform has no cgroup and no job object; Orbit refuses work that would
not fit instead of stopping work already over. Containment itself was measured there: a supervisor
SIGKILLed left 0 of 9 Chrome processes alive after 60 ms, on every run.
[What macOS measured](docs/macos-measured.md).

Display separation is **not** a security sandbox: applications keep the OS user's permissions.

## Documentation

| Guide | Purpose |
|---|---|
| [CLI](docs/cli.md) | Every command, the socket API and the action set |
| [Connectors](docs/connectors.md) | MCP host setup |
| [Agent interface](docs/agent-interface.md) | What an agent should do, and what each call costs it |
| [Accounts](docs/accounts.md) | Real logins, saved state and profile clones |
| [Architecture](docs/architecture.md) | Components and control flow |
| [Preview](docs/preview.md) | Watching, takeover, tabs and surface size |
| [Resource limits](docs/resources.md) | The shared CPU and memory budget |
| [Support tiers](docs/support-tiers.md) | What is known to work, where, on what evidence |
| [All documentation](docs/) | Research, validation, porting and platform measurements |

## Support the work

Orbit is Apache-2.0, runs entirely on your machine and sends nothing anywhere. There is nothing
behind it but time. If it saved you some:

<a href="https://www.buymeacoffee.com/m7mmadomar"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" width="217" height="60"></a>

A report from a machine this project has never touched is worth as much. Orbit is measured on one
host class, so `sbar-orbit doctor --report` from another system is evidence it cannot produce for
itself.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md) · [Apache-2.0](LICENSE)
