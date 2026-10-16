# Zen installation discovery

## Portable discovery, 13 October 2026

The local-only repair below has been extended with the shared
[application discovery contract](application-discovery.md). Zen resolves verified
desktop entries, PATH symlinks and literal wrappers, current-user running
executables, and available recent application metadata before using the standard
local layout as a fallback. Running executable and explicit profile evidence
take priority. Conflicting or truncated inventories are refused. Update channel
metadata is reported separately from observed running state and authentication.

## Local Linux archive, 12 October 2026

The running broker failed a Zen `launch-app` request with `UNSUPPORTED`:
`Zen Flatpak profile directory is unavailable`. This workstation now uses the
local archive at `$HOME/.local/share/zen/zen` and its profile at `$HOME/.zen`.
The old discovery code only supported the Flatpak layout.

When the Flatpak profile directory is absent, discovery now accepts this exact
local archive layout. It selects the profile using the existing `profiles.ini`
rules, refuses a profile outside `.zen`, copies the profile, and mounts the
application directory read only at `/app/zen` in the existing private namespace.
An explicitly supplied fixture deployment keeps the Flatpak path. This initial
repair did not discover other archive locations; the later shared discovery
contract above replaces that restriction. Unresolved simultaneous installations
still require an explicit decision rather than a guessed choice.

The local archive regression failed against the unchanged implementation with
the same profile error, then passed after the correction. The final focused
native run recorded 39 passes, zero failures, and 185 assertions across seven
files. `bun run typecheck` passed. Two bounded live runs launched the installed
local Zen in a private display and closed it afterward. The settled capture
showed its sidebar and default-browser prompt. These runs used the offline
copy; authenticated public website behavior was not measured.

A separate managed-broker session launched GNOME Text Editor, accepted text
through the private clipboard, opened its save dialog through `Ctrl+S`, and
saved the expected text to a disposable file. This establishes private desktop
input and file saving on this host. It does not establish control of applications
already open on the owner's display. The [native handoff release hold](native-handoff-incident.md)
remains active.

The managed broker imports runtime source at startup. It must be restarted to
activate the Zen correction. During this investigation two unrelated sessions
were still active or paused, so they were preserved pending the owner's restart
decision. Existing service path drift was also reported by `doctor`; rewriting
the units is a separate installation action.

## Stable Flatpak discovery

Orbit's Zen pilot copies one selected profile from
`$HOME/.var/app/app.zen_browser.zen/config/zen`. The profile must remain inside
that application directory after resolving paths. The copied profile runs
through Orbit's existing private mount root and resource budget.

The stable deployment is searched for the current `x86_64` or `aarch64`
architecture. The default system installation is `/var/lib/flatpak`. The
default user installation is `$XDG_DATA_HOME/flatpak`, with
`$HOME/.local/share/flatpak` as the fallback when `XDG_DATA_HOME` is unset,
empty or relative. Absolute `FLATPAK_SYSTEM_DIR` and `FLATPAK_USER_DIR` values
override the respective roots. These environment variables are documented
in the [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#environment).
Orbit checks both roots and requires an executable `zen/zen` file under
`app/app.zen_browser.zen/<architecture>/stable/active/files`. If both roots
contain different canonical deployments, discovery refuses with `UNSUPPORTED`
instead of choosing a version silently. Two roots resolving to the same
deployment are treated as one installation. The internal fixture override
`deploymentFiles` selects one exact deployment; it is not a caller option on
`launch-app`.
The current `profiles.ini` parser selects a profile directory from defaults;
it does not map an installation section to a system or user deployment. A
single selected profile therefore does not resolve this deployment ambiguity.

The synthetic discovery tests use a disposable home whose name contains
spaces and deployment roots outside that home. They do not read a person's
profile or start a browser. The launch preparation test checks that its
source profile and home do not appear in the private launch arguments.
These fixtures cover path discovery and mount preparation only. Account
compatibility, other Flatpak branches, custom installations configured by
`installations.d`, and startup on other distributions remain not measured.

On 6 October 2026, before changing discovery, the six focused fixtures ran
with three passes and three failures. The moved XDG root and the two explicit
Flatpak roots failed with `UNSUPPORTED`; the default, empty-XDG and relative-XDG
cases passed. After correcting the roots,
`bun run verify tests/native-zen-launch.test.ts` ran 17 tests with 17 passes,
zero failures and 86 assertions. The bounded TypeScript check also passed.
No browser was started and the full native suite was not run for this change.

The later source review added fixtures for two distinct deployments and two
root aliases resolving to one deployment. These new fixtures are not measured
locally. Their regression and type checks must run remotely. To establish the
regression, run the new discovery tests against the parent revision before
applying the discovery change, then run them against the changed revision.
# Historical active-browser adapter

Active browser profile copying is retired from the desktop-only public API.
The public broker rejects `launch-app` with `app: "zen"`, including requests from
older adapters. The implementation and evidence below are retained for historical
reference and are not a supported fallback for desktop work.
