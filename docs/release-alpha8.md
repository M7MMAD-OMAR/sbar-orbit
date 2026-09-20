# 0.1.0-alpha.8

This is an experimental alpha, not the stable 1.0 release. Linux gains a managed installation and
an opt-in update path. macOS and Windows keep their existing browser support; managed update activation
and scheduling explicitly refuse there until their service integration is implemented and measured.

## Install on Linux

Prerequisites remain Bun, Chromium or Chrome, and a systemd user session with delegated cgroups.
The private native display needs its separate Fedora runtime. No root installation is performed.

```sh
bun add -g sbar-orbit@0.1.0-alpha.8
sbar-orbit install --managed
"$HOME/.local/bin/sbar-orbit" update status
"$HOME/.local/bin/sbar-orbit" update on
```

`install --managed` copies the release into the per-user versions directory and installs frozen
runtime dependencies without lifecycle scripts. It does not modify the registry package's directory.
The stable command is `~/.local/bin/sbar-orbit`; put `~/.local/bin` ahead of the global package-manager
bin directory on PATH, or use the explicit command above, so future launches follow the active version.
Source checkouts continue to use Git and are refused by managed adoption. Custom installation prefixes
are not supported for managed updates in this release.

## Migrate an earlier installation

Close all Orbit sessions first. Earlier brokers do not implement the update admission protocol, so
this first migration is explicit and has no automatic rollback. The managed rollback mechanism applies
to later updates, once alpha.8 is installed and running.

```sh
systemctl --user stop sbar-orbit.service
bun add -g sbar-orbit@0.1.0-alpha.8
sbar-orbit install --managed
"$HOME/.local/bin/sbar-orbit" doctor
"$HOME/.local/bin/sbar-orbit" update on
```

Do not run the stop command while sessions are open: stopping a broker closes them. Adoption refuses
an existing live broker or open sessions instead of silently replacing it. Existing accounts and
workspace state are not copied, removed or relocated by adoption.

## Updating after adoption

```sh
"$HOME/.local/bin/sbar-orbit" update check
"$HOME/.local/bin/sbar-orbit" update stage
"$HOME/.local/bin/sbar-orbit" update activate VERSION
"$HOME/.local/bin/sbar-orbit" update off
```

Automatic updates are opt-in. A daily systemd timer adds a randomized delay of up to four hours.
Candidates wait 72 hours after registry publication, stay within the compatible major line (minor line
while at 0.x), and cannot move a stable installation onto a prerelease. Alpha installations accept
newer alpha releases or a stable release on the same line, not a different prerelease channel.

Archives are checked against the registry SHA-512 digest and their package name/version. Concurrent
update mutations are excluded by a kernel file lock that is released if the updater dies. Activation
takes an idle-broker lease that blocks new sessions, switches the current link and restarts systemd.
The new broker must answer `doctor` with the expected version. Otherwise the pointer is restored and
the old broker restarted; `rollbackHealthy` separately reports whether that recovery answered.

A failed attempt to enable the timer leaves automatic updates off. Unsupported operating systems
return an explicit refusal. A stopped or older broker without update admission must be started or
migrated explicitly; the updater does not guess that a missing response means it is safe to proceed.

## Evidence and limits

The actual registry alpha.6 package was installed, then migrated to the alpha.8 candidate archive in
a disposable Fedora 44 systemd container, preserving a state sentinel. The upgrade gate also exercises
actual installation, private browser creation,
busy-session refusal, upgrade, deliberately broken startup, recovery, retained user state, timer
activation and disabling, and explicit rollback. The two successor versions used in that gate are
local fixtures with changed manifests, not published alpha.9 or alpha.10 releases.

Run it against the registry artifact with:

```sh
bash experiments/fresh-machine/update-cycle.sh /absolute/path/sbar-orbit-0.1.0-alpha.8.tgz
```

The image is built from `experiments/fresh-machine/Containerfile.systemd`. This is a Linux systemd
gate, not evidence for macOS, Windows, all distributions, hardware or arbitrary future state-schema
changes. A future release that changes persisted schemas or service-unit contracts needs its own
migration and rollback evidence before using this update path.
