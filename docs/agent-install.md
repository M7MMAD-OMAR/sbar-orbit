# Installing Orbit with an agent

This file is the contract an agent follows to install Orbit. It is written for a program, not for a
person, and it is deliberately the only thing the copy and paste prompt has to carry: a prompt that
restates the procedure goes stale the first time the installer changes, while a prompt that points
here does not.

Nothing in it is specific to one model or one agent host. It needs a shell, this source directory and
the ability to read JSON.

## The prompt

Give an agent this, with the Orbit source directory it should work in:

```text
Install Sbar Orbit in the source directory I have given you.

1. Read docs/agent-install.md in that directory. It is the contract. This message is only the trigger.
2. Plan before acting: run ./install.sh --dry-run --json and read the JSON. Branch on the fields,
   never on the prose.
3. Run ./install.sh --json. Exit 0 means installed, exit 1 means not installed. Read steps[] to see
   which step stopped it.
4. Act only on remedies whose needsElevation is false. Every remedy with needsElevation true is mine
   to run: print its command and stop, never run it yourself, and never use sudo for anything.
5. Report back: every step with its state, the capabilities object, and the remedies you did not run.
   Say plainly what is installed and what is not. Do not describe an installation as verified: the
   run reports installation state, not a measurement.
6. Do not open, automate, read or copy my own browser profile at any point, for any reason.
```

## Entry points

| Command | Purpose | Output | Exit |
|---|---|---|---|
| `./bin/sbar-orbit preflight` | What this machine has, reads only, starts nothing | Prerequisite report | 0 when browser prerequisites are found, else 1 |
| `./install.sh --dry-run --json` | The plan. Changes nothing | Install report | 0 when every step would run, else 1 |
| `./install.sh --json` | The installation itself | Install report | 0 installed, 1 not installed |
| `./bin/sbar-orbit doctor --report` | Host class and capabilities, needs no broker | Capability report | 0 |
| `./bin/sbar-orbit status --json` | Sessions, tabs and windows of a running broker | Status | 0 |

`--json` prints the report and nothing else, so it can be parsed directly. Without it the same run
prints a step display for a person. `--plain` is the middle option: one line per step, no repainting.

Other flags: `--prefix PATH` for where the command is linked, `--no-service` to keep systemd out of
it, `--reinstall-deps` to force a dependency install.

## The install report

```json
{
  "installed": true,
  "source": "/absolute/path/to/source",
  "prefix": "~/.local",
  "launcher": "~/.local/bin/sbar-orbit",
  "dryRun": false,
  "steps": [{ "id": "prerequisites", "title": "...", "state": "done", "detail": "...", "elapsedMs": 12 }],
  "capabilities": { "browserSessions": true, "nativeSessions": true },
  "remedies": [{ "id": "no-browser", "message": "...", "command": "sudo dnf install -y chromium", "needsElevation": true }],
  "verified": "Installation steps only. ..."
}
```

- `steps[].id` is one of `prerequisites`, `dependencies`, `launcher`, `service`, `connector`,
  `verify`, always in that order, and a run that fails early simply carries fewer of them.
- `steps[].state` is `done`, `skipped` or `failed`. `skipped` is never a failure: a dry run skips
  everything that writes, and `--no-service` skips the two steps that need a broker.
- `capabilities` says what this machine can run, not what was proven to work.
- `verified` is the sentence that says what the run did not check. Repeat it rather than dropping it.

## Remedies, and the line an agent does not cross

A remedy is the shape to branch on. `needsElevation: true` means a package manager and a person: print
the command, hand it over, and do not run it. `needsElevation: false` with a `command` can be run in
the source directory. `message` is for the person reading your report.

Package commands name Fedora's packages, because Fedora 44 is the only host class this project
measures. On another distribution the names are the person's to translate.

| `id` | Cause | Elevation |
|---|---|---|
| `unsupported-platform` | Not Linux. The macOS and Windows adapters are unverified | No, and nothing can fix it here |
| `system-tool-systemctl`, `system-tool-systemd-run`, `system-tool-nice`, `system-tool-python3` | A base system tool is missing | Yes |
| `no-systemd-user-session` | No user manager is running for this account, so there is no slice to install into | No, and it is a login or a host problem, not a package |
| `incomplete-source` | This source tree is missing files a release carries | No |
| `dependencies-missing` | Project dependencies are not installed | No, the installer does it |
| `no-browser` | No Chrome or Chromium at a supported launcher location | Yes |
| `no-native-runtime` | The private compositor and pointer helper are not in a source release | Yes, and read the bootstrap's pinned versions first |
| `no-capture-tools` | grim or wl-clipboard missing, native sessions only | Yes |
| `no-xwayland` | Xwayland missing, X11 applications on the private display only | Yes |
| `prefix-not-on-path` | The command is linked where the shell will not find it by name | No, and it is the person's shell configuration, which Orbit never edits |
| `no-lingering` | Orbit starts with the desktop but will not survive a full logout | Yes |
| `broker-did-not-start`, `broker-silent` | The service was installed and did not come up, or nothing answered its socket | No, read the status or journal command it carries |

## Refusals an agent should expect, and not work around

- **No systemd user session.** `./install.sh` stops before any step, with a message naming a container
  and a bare ssh session as the expected cases. This is correct. Do not create cgroup state, do not
  install as a system service, and do not remove the guard.
- **`RESOURCE_LIMIT_REQUIRED`.** Every Orbit entry point runs inside a shared CPU and memory budget.
  A command that refuses with this was run outside it. Run it through `./install.sh` or
  `bun run scripts/limited.ts`, never around it.
- **A prefix collision.** The launcher link refuses to replace a file it does not recognise. Inspect
  it, and report; do not delete it.
- **An installation lock.** `PREFIX/bin/.sbar-orbit-install-lock` means another install may be
  running. No lock is ever automatically declared stale. Report it.

## Registering Orbit with an agent host

The install writes `~/.config/sbar-orbit/mcp.json`, which is Orbit's own directory and never a host's
configuration. The run prints the exact one line command to register it. Registering is the person's
decision, so print the command rather than editing their host settings. [Connectors](connectors.md)
covers the tools themselves.

## What an installing agent must never do

- Run anything with `sudo`, or any command a remedy marked `needsElevation: true`.
- Open, automate, read or copy the person's own browser profile, for any reason. Orbit exists so that
  an agent does not have to.
- Report an installation as verified, tested or measured. It is installation state. The gates that
  measure anything are in [validation](validation.md), and none of them is closed by installing.
- Edit the person's shell configuration, host MCP settings, or any systemd unit Orbit did not write.
