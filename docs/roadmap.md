# Roadmap

**State, 20 September 2026.** Tagged `v0.1.0-alpha.8` at `6a802f5`, and `0.1.0-alpha.8` is what the npm
registry serves as `latest`. Of the seven gates below, 2, 3, 6 and 7 are closed at the tier their
evidence supports, and gate 1 is closed by an automated reading taken on this desktop but not yet by
the participant's own reading of the viewer's `#cost` line. Gates 4 and 5, and every claim about a
machine with a person at it, still wait on the same thing: a host that is not this workstation, with
someone sitting at it. Nothing here is closed by installing Orbit somewhere.

## What remains, 20 September 2026

Recorded from the newest evidence, so a reader can tell what alpha.8 does and does not settle.

1. **A participant-confirmed human usage trial.** The no-interference half has a ten-minute concurrent
   measurement on a live desktop, recorded in [human work and takeover trial](human-handoff.md), but
   it is not participant confirmation: nothing paused, no input was rejected while paused and the
   disposable phrase was never read back. The concurrent-work confirmation, the pause and takeover
   acknowledgement and the viewer-optional check all still wait on a person. Gate 1's participant
   reading and the `Failed` rows for "human takeover and resume" and "participant acceptance" in
   [support tiers](support-tiers.md) wait on the same thing.
2. **Real-device coverage.** Windows and macOS have run on a borrowed Windows 11 guest and a hosted
   `macos-26-arm64` runner, with nobody at the machine; the guest has Edge alone on one of its two
   hosts. What is missing is a Windows and a macOS machine with a real desktop session and the
   person's own account, Keychain and browser history. On Linux the native rows come from a machine
   whose compositor rasterises in software, with no physical GPU, and the other distributions are
   container limited.
3. **Managed installation and updates on Windows and macOS.** Adopt, stage, activate, rollback and the
   timer exist on Linux only; Windows and macOS refuse managed activation and scheduling explicitly
   rather than reporting success. See [automatic updates](updates.md) and
   [the alpha.8 guide](release-alpha8.md).
4. **Three failures with no identified cause.** A local Linux installer-contract test failed in one
   full-suite run and has passed in every run since, with the user journal showing no actionable cause;
   a Windows cold first-capture timed out once and did not recur; and the managed broker on this
   workstation aborted with SIGABRT after 4h46m of uptime, taking its live sessions with it, with the
   core truncated and no message printed. Each had its diagnostics strengthened and none has been
   reproduced with its cause named. A successful rerun is not an explanation, and no failing functional
   test was deleted or given a longer deadline. See
   [release readiness](release-readiness.md#managed-broker-abort-20-september-2026).
5. **A real host for gates 4 and 5.** The browser extension and the Linux families are closed as far as
   their hosts could take them. What closes more is a machine of each family with a screen and a GPU,
   and a person's Windows or macOS desktop, which is the same host classes item 2 names.

## Demonstrated in the alpha

- Local broker, CLI and MCP contract.
- Followed browser tabs, so site-opened login and consent windows are reachable.
- Owned browser sessions and optional viewer.
- Fedora native Wayland/Xwayland capture and input.
- Unicode paste, account snapshots and cooperative file reservations.
- Process cleanup and a scripted 10-minute browser/viewer run.
- A session from the person's own browser profile, by clone, decrypted through a secret service that
  holds exactly one item.
- An origin lease held in two places: request interception inside the browser, and a network namespace
  below it whose only route out is a proxy the browser cannot go around.
- Autonomy without a checkpoint: a policy fixed at creation that only ever tightens, an advisor that
  fails closed, an immune set nothing clears, a durable journal, and restore points with a refusal set.
- Windows and macOS adapters, each measured on a real machine of its own at tier `Limited`: a Windows 11
  guest and a GitHub `macos-26-arm64` runner. Job objects and process groups in place of the cgroup,
  an explicitly written socket DACL on Windows, an advisory budget on macOS that says so in
  `enforcement`, and containment measured by killing the supervisor rather than asking it to stop.
- One command installation on this host class: `./install.sh` checks prerequisites, prepares
  dependencies, links the command, installs and starts the service, writes connector configuration and
  verifies that the broker answers, printing a remedy for every item only a package manager can supply.
  It reports installation state and says in its own closing line that this is not a measurement.

## Next acceptance gates

1. **Closed on 14 September 2026, with the figure read on the participant's own desktop.** `experiments/viewer-cost-desktop.ts` opened the viewer window Orbit opens there, Hyprland, Google Chrome in Orbit's own profile, and read `Viewer cycle: 75 to 129 ms of every 1000 ms (7 to 13%)` from its `#cost` line for a minute on a blank session, request 59 to 110 ms, decode 6 to 9 ms, draw 0 ms. See [validation](validation.md). What that does not settle is the participant's earlier feeling, which predates the two fixes and the new window; a native session or a busy page costs more per frame, and the line is there for the person to read whenever it does.
   The original gate, for the record: resolve the participant-reported CPU problem before another interactive trial. Names/pointer visibility were confirmed; takeover and resource acceptance were not. Two measured causes are now fixed: the viewer scheduled its next poll with no delay once an iteration outlasted its cadence, and PNG deflate dominated capture on both backends. The viewer now reports its own per-frame cost, because it runs outside Orbit's cgroup and the CPU sampler cannot see it. A participant-read cost figure is still required; neither fix is confirmed to be what the participant felt.
   Seen again on 12 September 2026, and already explained rather than new: a full suite run alongside
   two other bounded commands failed `tests/preview.test.ts` on its 30 second wait for a fresher frame,
   and the same file passed in 8 seconds when run alone. That is the contention effect
   [validation.md](validation.md) already records, one shared cgroup budget split between concurrent
   runs, which is why gate runs are taken one bounded command at a time. It says nothing about the
   participant's own cost, which still has to be read on their machine.
   Since 14 September 2026 the viewer opens in a browser window that is Orbit's own rather than a
   tab or window of the person's browser, and the same window inside a private display reports
   `Viewer cycle: 24 to 56 ms of every 1000 ms (2 to 6%)` at the default cadence on a blank
   session; see [validation](validation.md). The participant reads the same `#cost` line in that
   window on their desktop, and that reading is the one this gate still waits for.
2. Broaden failure and native application/account coverage. Three repeated recovery runs pass:
   repeated on 14 September 2026 with the supervisor death fix in, three consecutive runs of the
   crash and file lease suites, 6 tests and 33 assertions each, 13.17, 12.87 and 12.89 seconds, no
   failures; see [validation](validation.md). The GTK file chooser question, G10, closed the same
   day with no session bus needed; see [porting](porting.md).
   Independent supervisor death is now covered rather than open: a supervisor killed outright runs
   none of its own reaping, so its application survived it and outlived the runtime directory it was
   given. The backend now records the process group each supervisor leads, sweeps it when a supervisor
   exits and again when a session closes, and signals nothing whose private runtime directory does not
   name this session. Five checks in `tests/owned-group.test.ts` and one end to end native check cover
   it, and the end to end check was run first against the unfixed code, where it failed. Application
   coverage widened on 14 September 2026: `experiments/application-coverage.ts` launches fifteen
   more, one at a time, across GTK4, GTK3, LibreOffice's VCL, Qt 6 with KDE Frameworks, an OpenGL
   terminal and Xwayland, and all fifteen map, in 714 ms to 2597 ms; the first run of it found and
   fixed a launch that timed out on a window owned by a grandchild of the launched process. See
   [validation](validation.md). Account coverage closed on 14 September 2026 against a real
   service, `www.npmjs.com`, with the signed in state taken from a clone of the person's own
   profile rather than a typed password: the restored session was signed in, the lease was refused
   to a third session, and the person's own browser stayed signed in afterwards. See
   [accounts](accounts.md).
3. **Closed on 13 September 2026, on a container that is a machine rather than a filesystem.**
   `experiments/fresh-machine/systemd-session.sh` gives a clean Fedora 44 image the half the other
   container cannot have: systemd as PID 1, a lingering unprivileged account whose user manager owns
   delegated `cpu`, `memory` and `pids` controllers, and therefore a real `sbarorbit.slice`. On that
   machine, from tracked source and the frozen lockfile: the dependency install completes, `preflight`
   passes, the bootstrap builds the private compositor and the pointer helper, `./install.sh` runs to
   completion with `installed: true` and every step `done`, the broker service comes up and answers
   `doctor`, a browser session opens, and a native session launches an X11 application, accepts typed
   text and returns a 1280 by 800 JPEG of it. The whole session sequence cost 1549 ms of processor
   inside a budget of 4 seconds of CPU per second, 7946 MiB and 1536 tasks, with zero refused forks,
   and the captured frame is kept beside the log in `output/fresh-machine/`.
   Two limits are printed beside that, and neither is hardware this run had: there is no GPU, no real
   compositor and no screen, so this says nothing about a machine with a display, and the container
   reads the host's processor and memory totals, so the budget it sized is a quarter of the host
   rather than a quarter of the container. Tier `Limited` under [support tiers](support-tiers.md),
   with those limits, rather than `Measured`.
   That run is also what found the two defects in `31a4827`: without `btrfs-progs` every
   `session.create` threw rather than losing restore points, and the exception that said so was
   discarded in four places at once. The same script against the commit before the fix reproduces both.

   The original gate, for the record:
   Verify full local installation on a fresh machine, including native dependencies. Launcher
   activation, upgrade, rollback and link-only uninstall pass filesystem tests without touching
   workspaces or accounts. The unprivileged half now also runs in a clean Fedora 44 container, at
   tier `Limited` with the limit printed: tracked source is enough to install from, the frozen
   dependency install completes, and both the one command install and the launcher link refuse
   cleanly where there is no systemd user session, by two different causes and with the same message.
   That run found three things a reading of the source would not have, two of which are now fixed:
   `preflight` reported systemd tools as available with no user manager behind them, and
   `doctor --report` read a Fedora container as this project's measured host class. The third is a
   real gap and is now narrower: the native runtime, the private compositor and the pointer helper,
   lives in an untracked directory, and since 13 September 2026 `./install.sh --native` builds it
   from the tracked bootstrap. Measured in the clean Fedora 44 container on the same day, once the
   `deps` image carried the compiler and the 26 runtime packages the unpacked compositor links
   against: the bootstrap completes and the sway it built starts and reports its version. That run
   is what found the packages, since the first attempt built cleanly and could not load
   `libevdev.so.2`. Opening a native session on that image is still `not measured`; it has no
   display and no systemd session.
   What still closes this gate is a real machine with a systemd user session, cgroup delegation and
   wlroots, where `./install.sh` runs to completion and the broker it starts answers.
   **The browser half closed on 14 September 2026 on a real second machine**, a GitHub Ubuntu 24.04.5
   runner with a systemd user session and `cpu memory pids` delegated: `./install.sh --json` returned
   `installed: true`, `sbar-orbit.service` came up and stayed up, `doctor` answered, and a browser
   session created through the installed service navigated to a page, read its heading, captured a
   1280 by 800 frame and stopped; the logs and the frame are attached to the `v0.1.0-alpha.5`
   release. The first attempt found the defect a container could not: the service exited 127 on
   every restart because the launcher took `bun` from the caller's PATH and a systemd user service
   has none of `~/.bun/bin` in its own. The launcher now finds bun by location. The native half,
   a compositor on that machine, is still refused there by the bundle's sonames, so it waits for a
   real Fedora, Arch or openSUSE host.
4. Repeat browser and native adapter gates on actual macOS and Windows hosts. Since 14 September
   2026 the platform probes run on GitHub's Windows, macOS and Ubuntu runners,
   `.github/workflows/platform-probes.yml`: G16, G17, G24 and G25 closed, G15 closed for the
   transport, G19, G21 and G22 measured on a runner, G23 not measurable on a virtual Mac, and on a
   stock Ubuntu 24.04 host the egress lease is `in-browser` because AppArmor refuses the namespace.
   Since 18 September 2026 a `macos-26-arm64` runner runs **Orbit's own code** rather than probes:
   the one command install, the LaunchAgent, a browser session driven through the installed command,
   and a containment experiment that SIGKILLed a supervisor and left 0 of 9 processes alive. The
   macOS budget is `advisory` by construction and the tier table says so. Every one of those is tier
   `Limited`; a person's machine, with a desktop session and their own Keychain, is still what closes
   the rest. Since 19 September 2026 the Keychain row is no longer `Reasoned`: two runners, macOS
   26.6.2 arm64 and 15.7.9 x64, ran `experiments/macos-keychain.ts`, and the negative control landed
   on both. Stripping `--use-mock-keychain` and `--password-store=basic` makes the very next headless
   launch create a `Chrome Safe Storage` item in `login.keychain-db`; keeping them, no item ever
   appears, and both arms publish a CDP endpoint either way, so the browser does not fail loudly
   without them, it quietly reaches for the keychain. The row is `Limited` rather than `Measured`
   because the claim is about a modal on a person's screen and a runner has no window server session
   to draw one on. See [the fragment](fragments/macos-keychain.md) and [support tiers](support-tiers.md).
   See [porting](porting.md) section 9 and [what macOS measured](macos-measured.md).
5. Publish capabilities from evidence; unsupported closed tools remain explicit. The tier table,
   the local `doctor --report` and the issue forms now exist; what they need is a host this project
   does not have. See [support tiers](support-tiers.md).
6. The browser extension that mints scoped state for a separate Orbit browser. Written in
   `extension/`, and since 14 September 2026 loaded and run, in an Orbit owned headless Chromium
   rather than in the person's browser, which is the one place this project's rules keep agents out
   of. `experiments/extension-gates.ts` builds the shipped manifest unchanged, loads it, and the
   worker registers its click listener with `cookies`, `storage` and `runtime` bound. Two of its
   three gates closed on that run: G12, `chrome.cookies.getAll` returns `HttpOnly` cookies and a
   partition key survives the round trip into a second browser; and G14, the idle worker stops at
   30 seconds and an open native messaging port to the real host keeps it running past 150. G13
   closed the same day in a private display with a screen, `experiments/extension-wake.ts`: the two
   wakes that need no person draw no window, nothing wakes the worker unbidden, and the person
   initiated design is therefore the measured answer. Two facts the first run found are now in
   [packaging](packaging.md): branded Google Chrome ignores `--load-extension`, so a person loads it
   unpacked through `chrome://extensions`, and on Linux the native messaging host manifest belongs
   under the browser's user data directory.
7. The other Linux families, as far as a container can take them. Since 14 September 2026
   `experiments/linux-families/run.sh` runs the compositor contract probe on Debian 13, Ubuntu 24.04,
   Arch and openSUSE Tumbleweed: the bundled build loads on Arch and Tumbleweed and is refused by
   soname on Debian and Ubuntu, the family's own sway starts from a private prefix on all four, no
   family's compositor needs a logind session, and unprivileged user namespaces confine a network
   namespace on all four. Every row is tier `Limited`; what closes more is a real machine of each
   family with a screen. The container variant for atomic hosts was measured the same day on a
   Toolbx container, G6 and G7: the Wayland socket crosses to the host, X11 is refused inside before
   a display number exists, and a scope started from inside lands in the slice. See
   [support tiers](support-tiers.md) and [porting](porting.md).

Use [acceptance cases](acceptance.md) as release criteria. Alpha versions do not imply these gates are complete.
