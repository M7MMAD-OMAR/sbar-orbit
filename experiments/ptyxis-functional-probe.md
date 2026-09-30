# Installed Ptyxis functional probe

Measured on 30 September 2026 with Fedora's `ptyxis-50.1-2.fc44.x86_64`.

## Failure before the fix

The generic Fedora launch mapped a window, but never executed the requested
`bash --noprofile --norc` command. Its title was `/usr/bin/bash (Failed)` and
its terminal printed:

```
Failed to connect to user scope bus via local transport: No such file or directory
```

The generated marker remained `pending`. The initial failing report and frame
are retained as `before.json` and `before.jpg` under
`output/ptyxis-functional-2026-09-30/`. This reproduces the distinction between
mapping a terminal window and running a shell.

## Cause and change

[Ptyxis 50.1 source](https://gitlab.gnome.org/GNOME/ptyxis/-/blob/50.1/agent/ptyxis-run-context.c)
checks `systemd-run --version`, then prefixes every session command with
`systemd-run --user --scope`. It does not check whether the private environment
can contact a user manager. Orbit intentionally provides its own session bus
and runtime, and the requested scope cannot start there.

For the exact generic launcher `/usr/bin/ptyxis`, `FedoraBackend.act` now
prepends a private directory to PATH. Its `systemd-run` shim rejects only the
single `--version` discovery argument. Every other invocation executes
`/usr/bin/systemd-run` unchanged. Ptyxis therefore uses its ordinary direct
spawn path, inheriting Orbit's supervisor and cgroup instead of requesting a
separate host scope. The original bus and socket restrictions remain in place.
No host installation, configuration, service or original terminal is changed.

This is a compatibility adjustment, not a new security boundary. The shim is
inherited by terminal commands, so `systemd-run --version` through PATH also
returns failure there. `/usr/bin/systemd-run --version` remains available.
Other executable paths, terminal packages and future Ptyxis detection schemes
have not been measured.

## Functional evidence after the fix

`experiments/ptyxis-functional-probe.ts` launches the installed application
through the actual `FedoraBackend.act` generic route, within the shared budget.
It uses generated files only and closes the owned display in `finally`.

All six checks passed:

- Shell writes the exact expected marker.
- Orbit's private keyboard input changes the marker to a second exact value.
- Closing and reopening Ptyxis reads the previous marker and writes a third value.
- Shell cgroup exactly matches the probe's cgroup inside `sbarorbit.slice`.
- Shell has a Wayland display name in the owned backend environment.
- Shell session bus points into the private `orbit-native` runtime.

The final title was `/usr/bin/bash`, without the failure suffix. Evidence is
`output/ptyxis-functional-2026-09-30/report.json` and `frame.jpg`.
The script exits nonzero when any check fails. An intermediate harness run
failed because it used `ENTER` instead of the API's `Enter`; this was corrected
before the final successful run.

Run:

```sh
bun run scripts/limited.ts bun run experiments/ptyxis-functional-probe.ts
```

The initial command execution check ran against unfixed code and failed. The
keyboard, reopen and cgroup checks were added after that reproduction; their
regression sensitivity has not been measured against unfixed code.

## Limits

This proves basic command execution, private keyboard input, generated-file
continuity across two windows, and inherited resource membership for this
installed version. It does not prove restoration of the user's existing tabs,
history, shell configuration, terminal profiles, containers, SSH sessions,
account state, arbitrary file permissions or devices. The test deliberately
uses Bash without personal startup files. It does not establish complete
application parity or complete socket isolation.

## Verification

- `bun run typecheck`: passed.
- `bun run verify`: 571 passed, 45 skipped, 0 failed, 3700 assertions across
  616 tests in 129 files. Native suite gates remain skipped in this command;
  the separate installed-Ptyxis probe above supplied this change's native evidence.
- `git diff --check`: passed.
