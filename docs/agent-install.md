# Installing Orbit with an agent

This file is the contract an agent follows to install Orbit. It is written for a program, not for a
person, and it is deliberately the only thing the copy and paste prompt has to carry: a prompt that
restates the procedure goes stale the first time the installer changes, while a prompt that points
here does not.

Nothing in it is specific to one model or one agent host. It needs a shell, this source directory and
the ability to read JSON.

It is not written for one operating system either. Every command it names is either Orbit's own or is
built for whichever package manager the machine actually has. What is measured on one system stays
said so: see [support tiers](support-tiers.md), which is about evidence rather than instructions. The
one exception is named in its own row below, the private compositor's bootstrap.

## The prompt

Give an agent this, with the Orbit source directory it should work in:

```text
Install Sbar Orbit on this machine and connect detected agent hosts.

1. Clone https://github.com/M7MMAD-OMAR/sbar-orbit into a directory that will stay where it is, and
   work there. If I have already given you the source, use that instead and clone nothing.
2. Read docs/agent-install.md in that directory. It is the contract. This message is only the trigger.
3. Plan before acting: run ./install.sh --dry-run --connect auto --json, or install.cmd --dry-run --connect auto --json on
   Windows, and read the JSON. Branch on the fields, never on the prose.
4. Run ./install.sh --connect auto --json, or install.cmd --connect auto --json on Windows. Exit 0 means installed, exit 1 means
   not installed. Read steps[] to see which step stopped it.
5. Run a remedy only when its agentMayRun is true. Everything else is mine: print its command, or its
   message and packages when it carries no command, and stop. Never run it yourself, never add sudo
   to a command that does not have it, and never use sudo for anything.
6. Report back: every step with its state, the capabilities object, and the remedies you did not run.
   Say plainly what is installed and what is not. Do not describe an installation as verified: the
   run reports installation state, not a measurement.
7. Do not open, automate, read or copy my own browser profile at any point, for any reason.
```

## Entry points

| Command | Purpose | Output | Exit |
|---|---|---|---|
| `./bin/sbar-orbit preflight` | What this machine has, reads only, starts nothing | Prerequisite report | 0 when browser prerequisites are found, else 1 |
| `./install.sh --dry-run --json` | The plan. Changes nothing | Install report | 0 when nothing would fail, else 1 |
| `./install.sh --json` | The installation itself | Install report | 0 installed, 1 not installed |
| `install.cmd --dry-run --json` | The same plan, on Windows | Install report | 0 when nothing would fail, else 1 |
| `install.cmd --json` | The same installation, on Windows | Install report | 0 installed, 1 not installed |
| `./bin/sbar-orbit doctor --report` | Host class and capabilities, needs no broker | Capability report | 0 |
| `./bin/sbar-orbit status --json` | Sessions, tabs and windows of a running broker | Status | 0 |

On Windows every `./bin/sbar-orbit` row above is `bin\sbar-orbit.cmd`, and `install.cmd` replaces
`./install.sh`. The two installers are doors into the same `scripts/install.ts`, so the report, the
fields and the exit codes below are identical: nothing in this contract branches on which one ran.
The Windows installer checks for Bun and nothing else, because the systemd user session `install.sh`
requires has no analogue there; the shared budget is a named job object the process joins itself.

The Windows service step registers a per-user logon task and starts it immediately.
The verify step must receive a broker response before reporting success; no second
logon is required. A Task Scheduler start request alone is not proof of readiness.
Task names include the account SID, so another account's installation cannot take
the name or require administrative permission to replace it.

**On macOS run `./install.sh`, the same command as Linux.** It is the same script and the same
report, and it skips the systemd user session check there, because the shared budget on macOS is a
registered process group rather than a slice and needs no session manager. Two things in the report
differ from Linux and are stated in it rather than left to be discovered:

- The `service` step installs a **LaunchAgent**, not systemd units, and it starts the broker at
  LOGIN. There is no analogue of `loginctl enable-linger`, so nothing starts before a person logs
  in, and `autostart.status.startsAtBoot` is `false` rather than absent.
- `doctor` reports `limits.enforcement: "advisory"` with every dimension in `unbounded`. An agent
  that branches on the budget must read that field: the numbers are real kernel readings and the
  ceiling is not enforced. See [macos-measured.md](macos-measured.md).

The `panel`, `settings` and `config` subcommands are GTK and **refuse on macOS** with exit 64. That
is deliberate rather than missing: reaching them would spawn `/usr/bin/python3`, which on a Mac
without the Command Line Tools raises an installer window on the person's screen.

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
  "remedies": [{ "id": "no-browser", "message": "...", "packages": ["chromium"],
                 "command": "sudo dnf install -y chromium", "needsElevation": true, "agentMayRun": false }],
  "verified": "Installation steps only. ..."
}
```

- `steps[].id` is one of `prerequisites`, `dependencies`, `native`, `launcher`, `service`,
  `connector`, `verify`, `hosts`, always in that order, and a run that fails early simply carries fewer of them.
  `native` is skipped unless `--native` was passed: it downloads pinned Fedora packages and compiles
  the pointer helper, and browser sessions do not need it. When the build tools are missing it fails
  with the `dnf` line that installs them, which needs elevation and is yours to hand back.
- `steps[].state` is `done`, `skipped` or `failed`. `skipped` is never a failure: a dry run skips
  everything that writes, and `--no-service` skips the two steps that need a broker.
- A skipped step is not a failure, so a run whose steps are mostly `skipped` still exits 0. `installed`
  is the field that answers the question, and the exit code follows it.
- `capabilities` says what this machine can run, not what was proven to work.
- `launcher` is where the command is, or in a dry run where it would be. It follows `--prefix`.
- `verified` is the sentence that says what the run did not check. Repeat it rather than dropping it.

The `connector` step is the one part that does not follow `--prefix`. One machine has one registered
connector, whichever source was installed last, so the step reports `creates`, `unchanged` or
`replaces an earlier configuration`, and a dry run carries the exact content it would write in
`steps[].data.configuration`. Read that before installing a second source on a machine that already
has one.

What that configuration names is a contract of its own, and it changed on 16 September 2026. It is
the launcher and one argument:

```json
{ "command": "~/.local/bin/sbar-orbit", "args": ["mcp"],
  "env": { "ORBIT_SOCKET": "$XDG_RUNTIME_DIR/sbar-orbit/broker.sock" } }
```

It used to be the Bun that ran the installer plus an absolute path into the source checkout, which is
three separate ways to be wrong on a machine that is not the one it was generated on. The launcher
link is the path `local-install.ts` switches atomically between versions, so configuration written
against it survives an upgrade and a rollback; the launcher also resolves Bun by location rather than
from the caller's PATH, which is the fix a systemd user service needed on an Ubuntu runner. Windows
has no launcher, because `bin/sbar-orbit` is a shell script, so there the interpreter and
`src/mcp.ts` are named directly. `src/connector-entry.ts` is the only place that decides this, and
`tests/connector-entry.test.ts` holds it.

## Remedies, and the line an agent does not cross

A remedy is the shape to branch on, and it carries two separate facts because one boolean cannot hold
both. `needsElevation` describes the command: true means a package manager and a person.
`agentMayRun` is the permission: whether an agent may run it without asking.

**Branch on `agentMayRun`.** They are not the same field. Putting a directory on PATH needs no
elevation at all and is still not an agent's to do, because it lives in the person's shell
configuration and Orbit does not edit that. `message` is for the person reading your report.

A remedy for missing software carries `packages`, the software itself, and usually `command`, built
for whichever package manager is actually on this machine: dnf, apt, pacman, zypper or apk. On a system
with none of those the names are still there and the command is not, because a wrong command is worse
than none. `packages` is the portable field. Package names are not identical everywhere, so the command
already carries the name this system uses.

Package commands name Fedora's packages, because Fedora 44 is the only host class this project
measures. On another distribution the names are the person's to translate.

| `id` | Cause | `needsElevation` | `agentMayRun` |
|---|---|---|---|
| `unsupported-platform` | Not Linux, Windows or macOS. Those three have adapters; anything else has none | No | No, and nothing can fix it here |
| `unsupported-bun-version` | Windows needs Bun 1.4.2 or newer, the minimum verified with concurrent MCP adapters | No | No, upgrade the existing Bun installation through its original installation method |
| `macos-base-system-missing` | A tool that ships with macOS (`/bin/launchctl`, `/bin/cp`, `/usr/sbin/sysctl`) is absent | No | No, a system missing these is not one Orbit can repair |
| `no-taskpolicy` | `/usr/sbin/taskpolicy` is absent, so sessions cannot be placed in the background scheduling class. **Not fatal**: the budget's accounting half still works and sessions still run | No | No |
| `system-tool-systemctl`, `system-tool-systemd-run`, `system-tool-nice`, `system-tool-python3` | A base system tool is missing | Yes | No |
| `no-systemd-user-session` | No user manager is running for this account, so there is no slice to install into | No | No, it is a login or a host problem, not a package |
| `incomplete-source` | This source tree is missing files a release carries | No | No, report it |
| `dependencies-missing` | Project dependencies are not installed | No | Yes |
| `no-browser` | No Chrome or Chromium at a supported launcher location | Yes | No |
| `no-native-runtime` | The private compositor and pointer helper are not in a source release. This one is genuinely tied to a system: the bootstrap pins Fedora packages and has been run nowhere else | Yes | No, and the person reads the bootstrap before running it |
| `no-capture-tools` | grim or wl-clipboard missing, native sessions only | Yes | No |
| `no-xwayland` | Xwayland missing, X11 applications on the private display only | Yes | No |
| `prefix-not-on-path` | The command is linked where the shell will not find it by name | No | No, it is the person's shell configuration |
| `no-lingering` | Orbit starts with the desktop but will not survive a full logout | Yes | No |
| `broker-did-not-start`, `broker-silent` | The service was installed and did not come up, or nothing answered its socket | No | Yes, the command only reads a status or a journal |

### Reporting a remedy you did not run

`command` is optional. A remedy without one has nothing to hand over, so print its `message`, and its
`packages` when it has them: the cause is the useful part. `no-systemd-user-session` and
`unsupported-platform` carry no command because no command fixes them, and a system whose package
manager Orbit does not know carries the package names instead. Where there is a command, print it
exactly as given. Do not add `sudo` to a command that does not carry it, and do not remove it from one
that does.

## Two trials, and what they changed

The contract was tried twice on this workstation on 12 September 2026, by an agent given the prompt
above, this file, and nothing else. Both installed into a throwaway prefix with `--no-service`.

The first trial installed correctly and found three real defects. One boolean was carrying two
different facts, so `prefix-not-on-path` said `needsElevation: false` while the document said an agent
must never edit shell configuration, and the agent had to resolve the contradiction itself:
`agentMayRun` exists because of that. A dry run left the top level `launcher` naming the source rather
than the prospective link. And the `connector` step does not follow `--prefix`, which the document did
not say, so an agent had to read the source to find out whether installing a second source would
overwrite a live registration; the step now reports `creates`, `unchanged` or
`replaces an earlier configuration`, and a dry run carries the content it would write.

The second trial, after those changes, reported that it was never unsure which remedies it was allowed
to run and that the dry run told it everything it needed before acting. It found the smaller gap this
section's predecessor now covers: `command` is optional, and the instruction to print one read as a
promise that one always exists.

Two runs by one model on one host is not a claim that every agent can follow this. It is the evidence
there is, and it is why the fields exist in the shape they do.

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

Use `./install.sh --connect auto` on Linux or macOS, or `install.cmd --connect auto`
on Windows, to install and register detected Claude Code, Codex and Hermes hosts.
`--connect claude,codex,hermes` selects hosts explicitly. The flag authorizes the
`hosts` step to add Orbit to their configuration after installation succeeds.
Without it, the installer only writes Orbit's own `mcp.json` and prints a manual command.

Existing settings are preserved, changed files receive private backups, and an
existing different `orbit` entry is refused rather than overwritten. Repeating
the same registration changes nothing. `--dry-run --connect auto --json` previews
the selected paths and states without writing. Hermes uses its active profile, or
`HERMES_HOME` when explicitly set; on Windows its default home is `%LOCALAPPDATA%\hermes`. A running host needs a restart to
load its new tools; registration does not claim the host has already loaded them.

`hosts.data.registration` lists `configured`, `unchanged`, `planned`, `not-found`
or `failed` per host. `auto` detects a host by its CLI or existing configuration.
On Windows host entries invoke Bun directly because Node-based hosts cannot
execute a `.cmd` file directly. Other MCP hosts can import Orbit's generated
configuration manually. [Connectors](connectors.md) covers the tools themselves.

## What an installing agent must never do

- Run anything with `sudo`, or any command a remedy marked `agentMayRun: false`.
- Open, automate, read or copy the person's own browser profile, for any reason. Orbit exists so that
  an agent does not have to.
- Report an installation as verified, tested or measured. It is installation state. The gates that
  measure anything are in [validation](validation.md), and none of them is closed by installing.
- Edit the person's shell configuration or any systemd unit Orbit did not write.
  Host MCP settings may be changed only through an explicitly requested `--connect` step.
