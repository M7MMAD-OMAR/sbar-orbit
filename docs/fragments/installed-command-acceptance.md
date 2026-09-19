# Installed command acceptance, 19 September 2026

The reusable check is `experiments/installed-browser-smoke.ts`. Run it through
`scripts/limited.ts`, passing the installed launcher and an output JPEG path.
It serves a random heading on an ephemeral loopback port, drives the installed
command, reads the heading back, checks that pause refuses navigation, resumes,
captures a frame and stops the session. It never starts a broker itself. Choose a new output path for each run; existing
files are deliberately not overwritten.

## Windows 11 guest

An ordinary disposable account, Edge, Bun 1.4.2, and a source archive with frozen
dependencies already installed. Bun was placed in its supported per-user location.
This measures the installer and installed command, not acquisition of Bun on a
machine without it. The prefix contains spaces.

The first real installation failed with `Access is denied`: a task named
`SbarOrbitBroker` belonged to an older account SID. Task Scheduler names are
machine-wide even when their triggers are per-user. Orbit now appends the current
account SID to the task name and leaves the other account's task intact.

After that correction, `install.cmd --json --prefix PATH` exited 0, the service
step requested immediate startup, and `verify` received a broker response. No
manual `serve` command or additional logon was used.

The installed-command check passed in 6813 ms. The JPEG decoded as 1280 by 800
through System.Drawing and was also opened on the development host: its random
heading was legible. This duration includes command startup and is not a latency
or resource-use guarantee.

`tests/windows-autostart.test.ts` and `tests/install.test.ts`: 34 pass, 0 fail.
Disabling the immediate-start branch made the real scheduler test fail because
`started` was false; restoring it returned the suite to green. The installed
broker still answered afterwards. Scheduler tests use unique disposable names,
not the installed broker's name.

The same guest was then rebooted into the same test account. Without reinstalling
or manually starting the broker, the installed-command check passed in 9302 ms
and System.Drawing decoded another 1280 by 800 frame. This closes the previously
unmeasured browser chain after the logon trigger on this guest, at tier `Limited`.

## Linux development host

The same installed-command check passed in 3249 ms through the existing installed
launcher and managed broker. This is not a fresh Linux installation measurement.
The local installer and scheduler unit checks passed: 28 pass, 6 Windows-only skips.
Typecheck passed.

## Limits

macOS execution of this installed-browser check and resource acceptance on physical
machines remain open. Automatic host registration now passes the three-platform
protocol probe; see [release readiness](../release-readiness.md). These measurements do not establish
support for native Windows or macOS applications.
