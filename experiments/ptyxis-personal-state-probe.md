# Ptyxis personal settings and shell startup

Measured on 30 September 2026, after the generic Ptyxis shell fix in `39b9115`.
This is read-only personal-state evidence, not live application parity.

## What was exercised

The probe starts the installed Ptyxis in its normal local default profile on
an owned FedoraBackend display. It supplies no shell command or replacement
shell startup files. The original profile must select a local session and have
custom commands disabled; otherwise the probe refuses before launching it.

The host oracle reads six GSettings values before creating the display:

- Default profile identifier.
- Font name and use-system-font.
- The default profile's login-shell, palette and opacity values.

The private application then starts its default shell. Orbit's private keyboard
enters a generated Python script which reads the same six values from inside
that shell. The script also receives boolean results from shell checks for the
user's existing `__set_title` function, `ll` alias and `EDITOR=nvim` setting.
These checks match the current workstation's Bash configuration. No personal
settings or profile identifiers appear in the retained report.

The experiment sets `HISTFILE=/dev/null` in the private backend environment
before the launch. It verifies that value inside the shell and checks the
original `.bash_history` identity, size and modification time before and after.
It hashes the original dconf database, `.bashrc`, `.bash_profile` and eight
`.bashrc.d` files before and after. Hashes are compared in memory, never saved.
Generated scripts and raw setting values are removed after the display closes.
No screenshots or terminal content are retained.

## Results

Normal run:

- Six of six selected settings matched the current host values.
- Actual default shell loaded the three selected Bash startup settings.
- History remained disabled inside this shell.
- Original configuration file contents and history metadata remained unchanged.
- The owned display closed and generated probe files were removed.

Negative control:

- Remove only the copied database in the owned private runtime before launch.
- Five of six selected values matched, because those settings currently equal
  defaults. The profile identifier differed.
- The comparison rejected this fresh-profile fallback with exit status 1.
- Normal shell startup still succeeded, and original files remained unchanged.

The control proves that the comparison distinguishes this user's copied profile
from a fresh Ptyxis profile. It does not establish that every selected setting
is non-default or that all application settings are covered.

Reports:

- `output/ptyxis-personal-state-2026-09-30/report.json`
- `output/ptyxis-personal-state-empty-control-2026-09-30/report.json`

Commands:

```sh
bun run scripts/limited.ts bun run experiments/ptyxis-personal-state-probe.ts
ORBIT_PTYXIS_EMPTY_PREFERENCES=1 bun run scripts/limited.ts bun run experiments/ptyxis-personal-state-probe.ts
bun run typecheck
```

The normal run passed after the control was added; the empty-profile control
failed as expected. Typecheck passed. This turn changes experiment and evidence
files only; it does not rerun or claim a new general suite result.

## Remaining requirements

Preferences are copied at display creation. Later host or private preference
changes are not shared. Existing terminal tabs, running commands, scrollback,
SSH connections, containers and in-memory shell state are not attached by this
route. Shell history sharing was deliberately excluded from this read-only
experiment. The check does not establish every user's shell startup behavior,
complete file permissions, device use, or complete application parity.
