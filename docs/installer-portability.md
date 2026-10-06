# Installer portability and managed lifecycle audit

This bounded audit starts from `0faa05c64b70a553e665a2993a6da7957276261c`.
It inspects installation, browser discovery, per-user paths and managed update
activation. It uses disposable filesystem fixtures and does not register a host,
start a service, launch a browser or prepare a native runtime.

## macOS runtime discovery correction

The installer can run through a custom Bun installation while its generated
LaunchAgent cannot find that same runtime. The original
`src/macos-autostart.ts:76` plist generator persists `HOME` and `ORBIT_SOCKET`,
but no Bun search path. The launcher searches its inherited `PATH`,
`BUN_INSTALL`, `~/.bun/bin`, `/usr/local/bin` and `/usr/bin`. A launchd job
inherits none of the installer's shell settings. A runtime under a custom
directory, including `/opt/homebrew/bin`, can therefore be lost at login.

The correction puts the running installer's Bun directory first on the
LaunchAgent's `PATH`, followed by fixed system search directories. It persists
only that search path, home and socket. XML encoding protects spaces and
metacharacters in the directory. The chosen Bun still has to exist at login;
moving or uninstalling it requires installing Orbit's service again.

`tests/macos-launch-path.test.ts` executes a disposable copy of the real launcher
with the generated environment. Two recorder executables represent the custom
installer runtime and a competing default runtime. It verifies the selected
runtime and the full `serve --managed-socket` delegation arguments for paths
containing spaces and an ampersand. This is a Linux filesystem fixture, not a
measurement of launchd, a real Mac login, Keychain behavior or a browser session.
Real macOS activation of this correction remains `not measured`.

## Discovery and path findings

| Area | Source | Finding and limit |
| --- | --- | --- |
| Linux profile discovery | `src/platform.ts:93` | System profiles follow `XDG_CONFIG_HOME` or the supplied home. Flatpak and Snap profiles follow packaging-specific per-user locations. Executables use an explicit known list; arbitrary installations outside that list are not discovered. |
| Windows discovery | `src/runtime-paths.ts:32` | Known roots come from `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA`. App Paths is a fallback. A registry-only executable has no claimed branded profile identity. It cannot justify a profile-cloning capability. |
| macOS discovery | `src/runtime-paths.ts:113` | Known bundles are searched in `/Applications` and the person's `Applications` directory. The executable inside the bundle is selected directly. Renamed bundles and installations outside those locations need an explicit executable. |
| Per-user state and control paths | `src/service.ts:55`, `src/service.ts:97`, `src/service.ts:127` | Windows uses AppData locations; macOS uses Library locations and checks socket length; Linux uses XDG paths. Explicit socket and runtime-directory overrides remain operator choices. No real account data was read to assess these rules. |
| Linux runtime search | `src/service.ts:244` | Generated broker and update units already pin the installer Bun directory before absolute PATH entries. Relative PATH entries are excluded. |
| Windows autostart runtime | `src/windows-autostart.ts:237` | The default installer supplies no custom runtime environment to the scheduled task. Whether a custom Bun installation survives that task's inherited environment is `not measured` here. A Windows executable recorder fixture and actual account-specific task validation are needed before claiming a correction. |

These findings describe the named discovery paths, not an exhaustive proof for
every application name, packaging format or account configuration. Saved personal
profile cloning remains refused on Windows and macOS for the existing platform
reasons in [support tiers](support-tiers.md).

## Managed Windows and macOS activation remains unsupported

The repository has cross-platform version preparation and pointer primitives.
Those primitives do not implement a complete managed service lifecycle:

- `prepareManagedInstallUnlocked` in `src/update.ts:529` refuses non-Linux
  adoption, including a dry-run. Its first-adoption instruction names systemd.
- `activateVersionUnlocked` in `src/update.ts:201` refuses non-Linux production
  activation. The injected restart boundary is for disposable tests. It is not
  a supported production activation path.
- `restartService` in `src/update.ts:156` only restarts the systemd user unit.
- `systemdTimer` in `src/update.ts:476` refuses automatic scheduling elsewhere.

A bounded restart-command substitution would leave adoption, scheduling and
rollback lifecycle gaps. A complete port needs a platform adapter for service
ownership and idle broker admission, a stable installed launcher, bounded stop
and start, exact-version health checks, and rollback health verification. Windows
must keep the account-specific interactive logon task and private job ownership.
macOS must keep the user GUI LaunchAgent domain, login-only startup and owned
process-group cleanup. Disposable fixtures must first discriminate admission,
startup failure and rollback failure; fresh Windows and macOS measurements must
then exercise the real owned mechanisms.

No new updater is implemented by this audit. Managed adoption, activation and
automatic scheduling remain Linux-only. Existing pointer tests and historical
installed-browser evidence do not raise that support claim. Native opening,
handoff and performance remain `not measured`, and the unconditional native
handoff release hold remains active. The rejected native preparation path is
outside this audit and has not been retried or replaced.
