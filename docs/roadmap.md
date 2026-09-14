# Roadmap

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
- One command installation on this host class: `./install.sh` checks prerequisites, prepares
  dependencies, links the command, installs and starts the service, writes connector configuration and
  verifies that the broker answers, printing a remedy for every item only a package manager can supply.
  It reports installation state and says in its own closing line that this is not a measurement.

## Next acceptance gates

1. Resolve the participant-reported CPU problem before another interactive trial. Names/pointer visibility were confirmed; takeover and resource acceptance were not. Two measured causes are now fixed: the viewer scheduled its next poll with no delay once an iteration outlasted its cadence, and PNG deflate dominated capture on both backends. The viewer now reports its own per-frame cost, because it runs outside Orbit's cgroup and the CPU sampler cannot see it. A participant-read cost figure is still required; neither fix is confirmed to be what the participant felt.
   Seen again on 12 September 2026, and already explained rather than new: a full suite run alongside
   two other bounded commands failed `tests/preview.test.ts` on its 30 second wait for a fresher frame,
   and the same file passed in 8 seconds when run alone. That is the contention effect
   [validation.md](validation.md) already records, one shared cgroup budget split between concurrent
   runs, which is why gate runs are taken one bounded command at a time. It says nothing about the
   participant's own cost, which still has to be read on their machine.
2. Broaden failure and native application/account coverage. Three repeated recovery runs pass.
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
   [validation](validation.md). Still open in this gate: account coverage.
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
4. Repeat browser and native adapter gates on actual macOS and Windows hosts.
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
   stays open, because it asks what a wake path puts on the person's screen and a headless browser
   has none; the design keeps its person initiated answer. Two facts the run found are now in
   [packaging](packaging.md): branded Google Chrome ignores `--load-extension`, so a person loads it
   unpacked through `chrome://extensions`, and on Linux the native messaging host manifest belongs
   under the browser's user data directory.

Use [acceptance cases](acceptance.md) as release criteria. Alpha versions do not imply these gates are complete.
