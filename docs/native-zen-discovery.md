# Zen stable Flatpak discovery

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
