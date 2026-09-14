# Validation summary

These are alpha measurements, not guarantees for arbitrary applications. Raw workstation logs, profiles, conversation identifiers and access links are intentionally excluded from the public repository.

| Area | Observed outcome | Reproduce |
|---|---|---|
| Browser/viewer stability | 600 seconds, 2077 submissions, 3005 frames, 5.006 FPS; maximum sampled frame age 284 ms | `experiments/viewer-timing.ts 600` |
| Frame format | Both backends capture JPEG quality 80; the recorded timing run above predates this change and its frame costs no longer apply | See measured capture cost below |
| Resources | Per-run peak about 951 MiB; no new OOM or hard-limit events; zero added swap | Same bounded timing run |
| Process containment | 117 sampled tree audits found no escapes; cleanup left no owned processes | Timing run and `tests/chrome-containment.test.ts` |
| Default and native tests | 27 distinct tests passed across default and native-enabled executions before public packaging | `bun run verify`, then native tests with `ORBIT_TEST_NATIVE=1` |
| Session surface cost | Capture latency nearly flat from 1280 by 800 to 1920 by 1200; continuous native capture rises 71.9% to 100.8% of one core across the same range | `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/surface-cost.ts` |
| Viewer theming | Generated stylesheet renders in owned headless Chrome; malformed colours and font names are dropped rather than escaped | `bun test tests/theme.test.ts`, `experiments/theme-preview.ts` |
| Secret scan | Gitleaks 8.30.0 over all 28 commits: no leaks. The pre-commit gate was verified by staging a fabricated key, which it refused | `gitleaks git --redact --no-banner` |
| Appearance in a private display | Files, Text Editor and Dolphin open dark with the person's icons, colour scheme and fonts; 12,544 font faces visible with the compositor starting in 0.1 s, against 3.9 s when fonts were linked | `experiments/appearance-check.ts`, `bun test ./tests/appearance.test.ts` |
| Desktop panel | Layer-shell strip captured inside a private display with two windows: collapsed `1/2`, expanded row naming agent, task, focused window, state, window 2 of 2 and pointer | `experiments/panel-check.ts` |
| Working indicator | Click-through frame around the output: green edge pixels while a launch was in flight with the applications visible beneath, none after it finished, with the panel process's CPU ticks across both states recorded from the pid its launcher wrote | `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/panel-check.ts` |
| Desktop panel cost | Panel 0.1% of one core, broker 0.5% answering its polls, over a 20 s window watching a session; the processor stalls traced to a leftover heavy session in the throttled slice, not the panel | `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/panel-cost.ts` |
| Workspace cleanup | Profiles are removed when their session stops and the broker's workspace when it closes; `sbar-orbit clean` removed dead, reused-pid and stale directories and kept live and recent ones in a unit test with a fake proc root | `bun test tests/workspace-storage.test.ts` |
| Several agents at once | Three browser sessions and two private displays driven by independent loops on one broker: 20 of 20 rounds correct, 9.8 s, median round 494 ms, 93.2% of one core, 3.9% of the machine | `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/concurrent-sessions.ts` |
| Nine sessions at once | Six browsers and three displays requested together: five start and complete 20 of 20 rounds, four are refused by the 30 second start queue with a retryable `DEADLINE_EXCEEDED`; host load was 85% from other work during this run | Same experiment with `ORBIT_CONCURRENT_BROWSERS=6 ORBIT_CONCURRENT_NATIVES=3` |
| Host load | With `CPUWeight=10` a busy host starves Orbit by design; under a host load of 20 to 32 on 24 cores, session creation and launches timed out that succeed on a quiet host. Every experiment report carries `hostBusyPercent` for this reason | `experiments/concurrent-sessions.ts` |
| Agent hosts | Claude Code and Codex completed browser tasks and native editor saves in opt-in trials | Model-host experiments; authenticated host required |
| Fresh machine, whole installation and a session | Clean Fedora 44 with systemd PID 1, a lingering account and delegated cpu/memory/pids: install completes, broker answers, browser session opens, native session launches an X11 application, takes typed text and returns a 1280x800 JPEG. 1549 ms of processor for the session steps inside 4 CPU, 7946 MiB, 1536 tasks; zero refused forks. No GPU, no screen, and the budget sizes from the host's totals | `experiments/fresh-machine/systemd-session.sh` |
| Package from the npm registry | `bun add -g sbar-orbit@0.1.0-alpha.3` into a temporary Bun home: 95 packages, `--help`, `preflight` and `install --dry-run --json` run from the installed package, dry run `installed: true` | `docs/packaging.md` |
| Native runtime from tracked source | Clean Fedora 44 container, `deps` image: bootstrap exits 0, built compositor reports `sway version 1.11`, helper present; `minimal` image refuses at the compiler | `experiments/fresh-machine/run.sh` |
| Source archive | Extraction, source checksums, browser capture and packaged Canvas rendering passed for `0.1.0-alpha.2`, 263 manifest entries verified | `scripts/package.ts`, `experiments/package-smoke.ts` |
| A browser with no network of its own | A leased session browsed normally while confined; CDP crossed the network namespace, the leased https authority was tunnelled and the far end saw the connection, the unleased one was not, the unleased plain HTTP server was never touched, and no sockets, wrapper or helper processes were left behind | `bun run scripts/limited.ts bun run experiments/confined-egress.ts` |
| Removing the browser's own proxy setting | Reaches nothing at all while confined, against everything while unconfined. This is the difference between a lease and a setting the browser agreed to honour | `bun run scripts/limited.ts bun run experiments/egress-lease.ts` |
| Starting with the desktop | Both paths installed and enabled on this workstation: a user unit wanting graphical-session.target and an XDG autostart entry, plus a launcher entry and its icon. A second panel hands over its request and exits zero, leaving one mark and one process | `sbar-orbit autostart status`, `bun test tests/autostart.test.ts` |
| The settings and their search | The settings are a view of the viewer: the page lists every setting from the one Python schema, draws its own switch, choice and slider, writes through that same program so a refused value is refused identically, filters on the Arabic terms, and puts everything back on reset. The panel publishes the monitors a page cannot see | `bun run scripts/limited.ts bun test tests/viewer-settings.test.ts` |
| Reaching a panel that is already running | `sbar-orbit settings` bound no socket, found the panel that had, handed over its request and exited zero; that panel then opened the settings view of the viewer. This is the path the applications menu entry uses | Measured by hand on this workstation |
| A browser of the person's own | The session the panel's button creates is paused and carries their name rather than an agent's, and the viewer link is loopback with a token. The click itself is not exercised: a private display moves the pointer and never clicks | Same experiment |
| Every mark design | The four shapes and two edges captured rather than described | Same experiment, `output/settings-*/mark-*.jpg` |
| Restore | A granted restore swapped the profile for a writable snapshot of the point, dropped the file written after it, kept the directory a subvolume, and the session browsed afterwards on the same lease. Refused when anything since the point had left the machine, when not paused, and for an unknown point | `bun test tests/restore.test.ts tests/session.test.ts` |

All runtime experiments must use `bun run scripts/limited.ts` on supported Linux systems. The native tests require the documented Fedora bootstrap. Model-host trials are not part of the default suite and may incur model-service usage.

Sampling cannot exclude every transient focus or cgroup change. Frame metadata approximates readiness, not physical display latency. A successful scripted run does not confirm simultaneous human work. macOS, Windows, clean-machine installation, broader application coverage and broader failure coverage remain open.

### A shipped bug the confined measurement found

The clone's singleton markers were never being stripped. `stripSingletonMarkers` checked for each marker
with `stat`, and all three are symlinks that Chrome writes dangling by design: `SingletonLock` points at
`hostname-pid` and `SingletonCookie` at a number, neither of which is a file. So the check followed the
link, found nothing, removed nothing, and reported that it had removed nothing.

The consequence only appears while the person's own browser is running, which is most of the time and is
the case the clone exists for: the cloned profile carried their live lock, and Chrome refused it with
"The profile appears to be in use by another Google Chrome process on another computer". The unit test
passed throughout, because it wrote the markers as regular files.

Fixed with `lstat`, and the test now writes them the way Chrome does. Measured afterwards, with the
person's Chrome running: a cloned session confined to a network of its own started, reported the
`namespace` tier, and carried 168 cookies in its clone. Reproduce with
`ORBIT_REAL_PROFILE=1 bun run scripts/limited.ts bun run experiments/confined-egress.ts`.

### Three things measured against an assumption, each wrong in the obvious direction

Recorded here rather than only in a commit message, because each cost a debugging session and each will
be rediscovered by whoever ports this.

**Chrome writes `DevToolsActivePort` only when it chose the port itself.** Measured on Chrome 152 on this
host: `--remote-debugging-port=9222` listens, prints its endpoint to stderr, and writes no file at all.
Only `=0` publishes one. A launcher that waits for that file therefore cannot use a fixed port, which is
the opposite of what a confined browser on a private loopback would otherwise want.

**A unix socket path is 108 bytes, and past it the kernel truncates silently.** A workspace path plus a
session id spends most of that, so a relay bound a shortened path, nothing dialled it, and the session
died waiting for a browser that had started perfectly.

**`bwrap --unshare-pid` is load bearing.** Without it the relay processes inside the sandbox are orphaned
when the browser exits, reparent to init on the host, and hold the network namespace open after the
session that owned it is gone. It also refuses the browser its escape: inside a pid namespace, Chrome's
attempt to move itself into a systemd scope of its own is refused by systemd with `Process 2 is a kernel
thread, refusing`, which is a containment Orbit otherwise has to remove a session bus to keep.

## Repeated recovery on Fedora

After the initial alpha tag, the crash and selected-file suites passed three consecutive runs under the shared resource caps: 5 tests and 26 assertions per run, with no skips or failures. Each run used fresh broker sessions and disposable application state. The shared scope had zero remaining processes after the runner exited.

The cases cover abrupt browser/native broker death, detached descendants ignoring termination, one compositor dying while another survives, and a real GNOME Text Editor file reservation surviving save until session stop. Native process snapshots now traverse every task thread and require sampled process entries to disappear, including zombies. Unexpected process-inspection errors fail the snapshot.

```sh
ORBIT_TEST_NATIVE=1 bun run verify tests/native-crash.test.ts tests/browser-crash.test.ts tests/native-file-leases.test.ts
```

Repeat the command three times for this check. This is repeatability evidence on one Fedora host, not power-loss recovery, arbitrary application compatibility or proof that a snapshot captures later descendants. Human takeover remains unconfirmed.

Repeated on 14 September 2026, after the supervisor death fix and the owned group sweep landed, one run at a time with nothing else in the slice: three consecutive runs, 6 tests and 33 assertions each, in 13.17, 12.87 and 12.89 seconds, no skips and no failures. The sixth test is the end to end check that a supervisor killed outright no longer leaves its application behind.

## Participant trial: resource acceptance failed

The participant explicitly confirmed that workspace names and the labelled pointer were visible. They then reported stopping the trial because CPU consumption was unacceptable. The runner recorded pause and participant stop after approximately 123 seconds; the manual phrase/resume workflow was not completed. This is not a successful human-work or resource-acceptance result.

A second trial had already started before the resource report arrived. It was terminated immediately after that report. Both runners reached terminal state and the Orbit slice had zero remaining tasks. A post-stop process sample cannot establish which process caused the earlier spike. No causal attribution is claimed from that sample.

### Live trial: measured session cost

One Fedora host, 24 logical CPUs, browser backend, four 20 second phases in one run. Reproduce with `bun run scripts/limited.ts bun run experiments/live-trial.ts`.

| Phase | Orbit share of one core | Orbit share of the machine |
|---|---|---|
| Session open, agent idle, no viewer | 10.4% | 0.43% |
| Agent working, no viewer | 48.9% | 2.04% |
| Session open, agent idle, viewer at the 1 FPS default | 12.2% | 0.51% |
| Agent working, viewer at the 1 FPS default | 58.0% | 2.41% |

The viewer reported `Viewer cycle: 53 ms of every 1000 ms (5%)`, split as request 45 ms, decode 6 ms, draw 0 ms. Most of that cycle is time awaiting the broker, not processor time.

The working phases submit actions as fast as the broker accepts them, about 15 per second, which is far beyond a real agent's rate. Read them as an upper bound. The viewer here is owned headless Chrome inside Orbit's cgroup, so its cost is included in the figures above; the reported participant case had a desktop viewer outside that cgroup, and desktop compositing on this workstation's mixed 4K and 240 Hz fractional-scaling displays is still not measured. Host busy percentages varied with unrelated desktop activity and attribute nothing.

### Pointer separation

Sampling the host cursor cannot show separation while a person is using the machine, so the live processes are inspected instead. Reproduce with `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/pointer-separation.ts`.

Browser sessions, three consecutive runs: 12 processes inspected per run, zero holding a file descriptor to the host compositor socket, zero carrying `DISPLAY` or `WAYLAND_DISPLAY`. The owned browser is headless and its input is injected over CDP into its own page, so there is no operating system pointer for it to move.

Native sessions: every process runs with `XDG_RUNTIME_DIR` set to the session's private directory, and the compositor's display socket resolves inside it rather than to the host's. The display name can be identical to the host's, `wayland-1` in both cases, so only the resolved socket path distinguishes them. `HYPRLAND_INSTANCE_SIGNATURE` is absent, so the host compositor's control channel is unreachable. The private display carries its own pointer: moving it to a requested coordinate is reported back at exactly that coordinate and drawn in the viewer with the agent's label.

This is a point-in-time process sample, not proof that a later descendant cannot open a display connection, and display separation remains not a security sandbox.

### Several applications at once

Four real applications launched into one private display: GNOME Text Editor, Files, Calculator and System Monitor. Reproduce with `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/multi-application.ts`.

All four launched, taking 1.0 to 1.8 seconds each. The agent pasted text into the editor through the session's private clipboard, saved with Ctrl+S, and the phrase was read back from disk, so file editing works with several applications open. Launching all four cost 68% of one core over about 8 seconds.

The binding constraint is the shared budget, not the number of applications. `CPUQuota=100%` is one core for everything Orbit owns. With System Monitor among them, which refreshes continuously by design, the session consumed 99.7% of one core while the agent was idle, and an owned browser for the viewer then failed to start at all with `BACKEND_FAILED`. An earlier run without System Monitor idled at 0.6% of one core. Treat a continuously redrawing application as a budget decision, and expect the viewer to compete with the applications it is showing.

System Monitor inside the session reported the host's real memory and CPU. Private display separation does not hide the machine from an application, which is the documented position, not a defect.

### The viewer in a window of its own

The command `preview open` spawns, as the broker builds it, opened inside an Orbit private display: system Chromium 151 on a scratch profile that is Orbit's, `--class=sbar-orbit-viewer`, `--app=` on the viewer link. Reproduce with `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/viewer-window.ts`; the frame and `report.json` land in `output/viewer-window-<date>/`.

Measured 14 September 2026: the window mapped in 1345 ms with the title `Viewer window trial | Orbit`, `display-mode: standalone` true, 1280 by 800 of page and nothing else, no tab strip and no address bar, and the profile directory held 38 entries afterwards, none of them the person's. Read from the viewer's own `#cost` element every five seconds for a minute at the default cadence, watching one browser session on a blank page: `Viewer cycle: 24 to 56 ms of every 1000 ms (2 to 6%)`, of which the request took 18 to 50 ms, the decode 2 to 3 ms and the draw 0 ms. That is the viewer's own report of its work per frame on this host; the participant's reading of the same element on their own desktop, which is what roadmap gate 1 asks for, is theirs to take from the same window, and a native session or a busy page costs more per frame than a blank one.

### The viewer's cost, read on the person's desktop

The same `#cost` line, from the viewer window Orbit opens on the person's own desktop: Hyprland, the desktop's default Google Chrome in Orbit's own profile, `display-mode: standalone`, a 1265 by 1389 page at device pixel ratio 1.5 on a 2560 by 1440 output. Reproduce with `bun run experiments/viewer-cost-desktop.ts`; it opens the window for the length of the reading and closes it.

Measured 14 September 2026, one browser session on a blank page at the default cadence, sampled every five seconds for a minute: `Viewer cycle: 75 to 129 ms of every 1000 ms (7 to 13%)`, request 59 to 110 ms, decode 6 to 9 ms, draw 0 ms; the window was ready 2139 ms after the command. That is two to three times the 24 to 56 ms the same viewer reported inside a private display, and the difference is in the request, the broker's capture and the trip to the page, not in the decode or the draw. It was read through DevTools from the element the person reads by eye, in the window on their screen, which is what gate 1 asked for; a native session or a busy page costs more per frame.

### Fifteen more applications, one at a time

Applications beyond those four, each launched through the broker into one private display, its first window recorded with title and launch time, one frame kept, and the window closed through the session's own command before the next. Reproduce with `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/application-coverage.ts`; frames and `report.json` land in `output/application-coverage-<date>/`.

Measured 14 September 2026: 15 of 15 mapped, in 714 ms to 2597 ms. GTK4 with libadwaita: Ptyxis, Characters, Clocks, Weather, Loupe, Papers, Showtime, Snapshot, Font Viewer. GTK3: Inkscape 1.4.4. LibreOffice Writer through its own VCL, with a file the session reserved. Qt 6 and KDE Frameworks: Konsole and Dolphin. GLFW and OpenGL: kitty. And Calculator forced onto Xwayland. Launch to first frame cost 21% to 64% of one core for all but kitty, which cost 163% while llvmpipe stood in for a GPU.

Two things the run showed that a reader should know before choosing an application. Ptyxis maps and then shows `Failed to connect to user scope bus via local transport`, because it starts its shell through the systemd user bus and a private session has no session bus by design; Konsole and kitty, which start a shell themselves, run one. KFontView 6.7.4 exits 1 with nothing on stderr when handed a font file, while `--version` runs and the two KDE applications beside it map, so that is the application's own refusal and it is left out of the list rather than counted as a failure of the display.

The first run of this experiment is what found the launch defect fixed the same day: Writer's window belongs to `soffice.bin`, a grandchild of the launched script, and the broker waited 30 seconds for a window carrying the launched pid before giving up on an application that had been on screen since the fourth. A mapped window is now matched on the session id the supervisor gave the application, and Writer maps in 1.6 seconds.

Not measured: anything past the first window. No application was driven, and how many of these run together within the budget is the previous section's question, not this one's.

### Launching real desktop applications does not guarantee fresh state

A trial that launched GNOME Text Editor in a native session found the application had restored its own previous draft from the user's home directory, showing a personal document inside the agent's workspace. Native sessions now set `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` inside the session's own directory, so an application starts without the person's configuration and cannot restore their previous session. The repeat trial opened only the disposable file it was given.

This stops session restore. It is not a security boundary: system `XDG_DATA_DIRS` still resolve, and an application keeps the OS user's filesystem permissions, so it can still read personal files if it is told to.

### Identified scheduling defect

The viewer scheduled its next poll with `Math.max(0, cadence - elapsed)`. When one iteration outlasted its cadence, that delay became zero and stayed zero, so the viewer polled continuously with no idle gap. This applied to the default 1 FPS mode, not only to Smooth, and it is self-reinforcing: heavier load lengthens the iteration, which removes the gap, which raises the load. Headless timing runs did not expose it because their iterations stayed well inside the cadence.

The viewer now idles at least as long as the measured iteration cost, capping its duty cycle at roughly half of one core and lowering the frame rate instead of saturating the machine. It also reports its own measured per-frame cost, busy share and request/decode/draw split beside the frame age, because the desktop viewer runs outside Orbit's cgroup and `scripts/measure-cpu.ts` therefore cannot observe it.

### Measured capture cost

Interleaved measurements on one Fedora host, 1280 by 800, under `scripts/limited.ts`. Browser capture: PNG 68 ms and 188 KiB per frame, JPEG quality 80 47 ms and 70 KiB. Native capture, end to end through `observe()`: PNG 72.2 ms at the median, JPEG quality 80 8.6 ms. Isolating the native stages showed a fresh `grim` process cost 0.7 ms, the sway `get_tree` query 0.6 ms and broker base64 0.0 ms, so PNG deflate accounted for essentially all of it. Both backends now capture JPEG quality 80.

JPEG is larger than PNG on a mostly blank display, 28 KiB against 3 KiB per native frame, while still costing 7.3 ms against 27.4 ms. The choice favours processor time over bytes because the reported failure was processor cost on a local loopback link.

Following extra tabs does not add per-frame cost. Each followed tab gets its own CDP pointer observer, so observation was measured as tabs accumulated, with and without those observers: 34.0, 34.1 and 102.0 ms at three, five and eight tabs with them, against 34.0, 49.3 and 97.9 ms without. The growth at eight tabs is Chrome's renderer count, not the observers.

These are single-host medians, not guarantees, and they do not by themselves establish participant-acceptable cost.

The mechanism was read off the counters on 12 September 2026, while two other agents held live Orbit
sessions on this workstation. The shared slice stood at 357 of 512 tasks and 1.74 of 2 GiB, and its own
counters recorded `pids.events max 180` and `memory.events high 493588`. So the limit a contended suite
hits first is the task count, not processor time: a spawn fails with `EAGAIN` and the failure surfaces
wherever the next process was going to start. One of those paths reported it as an account lock helper
being unavailable, which sends a person looking for a program that is installed; that path now says the
budget is at its limit instead. The classification is reasoned from the captured failure, since
reproducing it on demand means filling the budget that other agents' sessions are using.

The suites are sensitive to machine contention rather than flaky in themselves. Running a second `scripts/limited.ts` command alongside a suite splits one shared cgroup budget, and viewer tests that wait for a fresh frame then time out. Six consecutive gate runs failed only in the two runs that overlapped other measured work, including pre-existing browser scroll and CLI tests. Run one bounded command at a time.

Measured again on 13 September 2026, with the budget sized to the machine (see [resources](resources.md)): the full suite ran in 54 seconds, 196 passing, with zero `memory.high` events, zero refused forks and 43 of 544 CPU periods throttled during the run, while another agent held three browser sessions open the whole time. The same suite under the old fixed budget on the same morning took 88 to 104 seconds and lost 12 tests to refused forks in one run and 1 to a crashed renderer in the next. Every figure above this paragraph was measured at the old one core, 2 GiB budget.

This is a confirmed defect with a regression test, not yet a confirmed explanation of the participant's report. Participant-read viewer cost figures remain required before another resource-acceptance claim.

The participant's desktop viewer runs outside Orbit's runtime cgroup. Prior headless-viewer measurements do not prove acceptable cost inside the actual desktop app. Further interactive trials are on hold pending investigation of capture/decode/compositing cost and a participant-controlled low-cost viewing mode. Preserve the failed result when judging release readiness.

## A supervisor killed on its own

Recorded 12 September 2026, Fedora 44, one host, under `scripts/limited.ts`.

A native application is owned by a small supervisor process, and the supervisor asked to stop reaps its
whole tree on the way out. That path was already covered. The path that was not: a supervisor killed
outright, which runs nothing at all. Its application kept running, became nobody's child, and outlived
the private runtime directory the session had given it. The broker watched the supervisor it spawned,
so nothing reported the loss.

The failure was reproduced before it was fixed, not after. With the fix removed, the end to end check
killed the supervisor of a mapped fixture application and the application was still alive when the
check gave up. With the fix in place the same check passes, the session keeps working, and a second
application launches into it.

| Check | What it exercises | Result |
|---|---|---|
| `tests/owned-group.test.ts`, 5 checks | An application that ignores a graceful stop, one that accepts it, a process from another session, a process that does not lead its own group, and identifiers that could reach something else | Pass |
| `tests/native-crash.test.ts`, the supervisor case | A real Fedora session: kill only the supervisor, then observe and launch again | Pass, and failed first against the unfixed code |

Ownership is checked before any signal. A process identifier alone is not evidence, because the number
can be reused between the supervisor's death and the sweep, so the group is signalled only when the
process leads its own group and its own environment names this session's runtime directory. The escalation
from a graceful stop to a forced one is measured by the first test against an application that ignores
the first signal.

This covers one failure mode of one component. Applications beyond the four are the section above,
since 14 September 2026; account coverage, which needs a real account and the person's consent, is
the part of gate 2 still untouched.

## Fresh machine installation, the unprivileged half

**Tier: Limited. The limit is that a container has no systemd user session, no cgroup delegation, no
wlroots compositor and no desktop, so the broker service, autostart, the private display and the
shared resource budget were never exercised.** This is not gate 3 closed. Clean machine installation
stays open, and the only thing that closes it is a real machine.

Run on 12 September 2026 with rootless podman 5.8.4 and crun, against `docker.io/library/fedora:44`
at digest `sha256:be9d65e2344d805cc11114319c685ecaa96b6d9b4350a0a6460cdb931babbd19`. Two images are
built from one Containerfile: `minimal` is Fedora plus Bun and nothing else, `deps` adds the packages
a person would install by hand. Those packages go in with `dnf` as root while the image is built, not
through any Orbit command, because Orbit installs none of them and never asks for elevation. Source reaches the container as a `git archive` of tracked files at
`489813a`, 237 entries, so no `node_modules` and no runtime directory cross the boundary. Bun is
pinned to 1.3.14, the version this workstation runs, and its release zip is checked against the
digest in the release's own `SHASUMS256.txt` before it is installed. No port is published, no host
namespace is shared, and the only host path inside the container is the read only source archive.

Reproduce the whole thing with `experiments/fresh-machine/run.sh`.

| Area | Observed outcome | Reproduce |
|---|---|---|
| Tracked source is enough to install from | `git archive` of 237 tracked files extracted and `bin/sbar-orbit` arrived executable | `experiments/fresh-machine/run.sh` |
| Frozen dependency install | 100 packages in 22.9 s from the committed lockfile, no lifecycle scripts | `bun install --frozen-lockfile --ignore-scripts` in both images |
| Prerequisites on a bare machine | Exit 1. Every group absent and each one carrying its remedy: no `systemctl`, no `systemd-run`, no `python3`, no Chrome or Chromium, no native runtime. Nothing was started | `./bin/sbar-orbit preflight` in the `minimal` image |
| Prerequisites once the packages are installed | Exit 0, `browserPrerequisitesFound` true with Fedora's `chromium` 152.0.7977.82 found at `/usr/bin/chromium`. `nativePrerequisitesFound` stayed false. This shows the check recognizing what a root build step put in place, not a path by which a person gets there | Same command in the `deps` image |
| The one command install | Exit 1 in both images, with the guard's own message naming a container as an expected case rather than a budget crash. `--dry-run` refused identically, so the refusal is not a dry run artifact | `./install.sh --dry-run`, then `./install.sh` |
| The launcher link install | Exit 1, `RESOURCE_LIMIT_REQUIRED` from `src/resource-budget.ts`, thrown before any filesystem work | `bun run scripts/local-install.ts install "$PWD" "$HOME/.local"` |
| The installed command | Not run. `~/.local/bin/sbar-orbit` was never created, because the install above refused | |
| The local report | Exit 0 from the source checkout. `sessionType` none, `secretService` absent, `systemdUserScopes` false, `confinedEgress` false, and the three notes that follow from those | `./bin/sbar-orbit doctor --report` |

### What the refusals say

`/proc/self/cgroup` inside the container reads `0::/`. That one line explains every refusal below it.
`requireResourceBudget()` looks for a path component named `sbarorbit.slice` in its own cgroup, and a
container with its own cgroup namespace and no systemd user session has none, so there is nothing for
it to read a quota out of. `scripts/local-install.ts` calls it on line 7, before it does any work at
all, so the launcher link install stops there rather than half way through.

This was recorded rather than worked around. Giving the container the host's cgroup namespace, or a
parent slice by that name, would have written host cgroup state to make a test pass, and the result
would have measured the workaround instead of the product. Whether `local-install.ts` should gain a
documented path for a machine with no systemd user session is an open question, not something this
run decided.

`install.sh` already answers it for itself. Its guard checks `systemctl --user show-environment` and
refuses with a message that names a container, a bare ssh session with no lingering user manager, and
a Linux system without systemd, and it points at `preflight` as the check that runs anywhere. Both
images produced that message: the `minimal` one has no `systemctl` at all, and the `deps` one has the
binary and no user manager for it to talk to. The same refusal from two different causes is the
useful part.

### Three things this run found that a reading of the source would not have

**`preflight` could not tell an installed file from a working one.** In the `deps` image it reported
`systemctl` and `systemd-run` available, because the files exist, while the install that needs them
refused a moment later. An availability check that goes green on a machine where the thing cannot
work is read as a pass, so the check was changed rather than documented: `preflight` now also asks
whether a systemd user manager is actually running for this account, by looking for the private
socket it keeps in the runtime directory. It is still a file check and still spawns nothing. The
container that found this is where the new check first returns false, and the workstation is where it
returns true. Covered by `tests/preflight.test.ts`.

**Native prerequisites cannot be satisfied from tracked source at all.** `private-sway` and
`private-pointer` were absent in both images, and installing every Fedora package did not change
that, because the compositor and the pointer helper live in `.runtime/`, which is not tracked and
never leaves this workstation. A fresh machine gets them from `experiments/fedora-display/bootstrap.sh`
or not at all. That is a real gap in the fresh machine story and it belongs in the packaging notes,
not only here.

**`doctor --report` read the container as this project's own host class.** It printed
`tier.assigned` "Reasoned" with the reason given for a Fedora 44 host, because `/etc/os-release`
inside the image says Fedora 44 and nothing in the probe distinguished a container from the machine
around it. Every capability line was correctly false or absent; the tier line was the weakest thing
in the report, because a person filing from a container would be told they are on the measured host
class when they are not. The tier now checks for the markers a container runtime writes itself, and
says a container is not the measured class whatever distribution it carries. The tier stays
"Reasoned" either way: what changed is the reason printed beside it, which is the part a person reads.

### What this run cannot be read as

No browser was launched, no broker started, no session created, no frame captured and no unit
installed. The CPU and memory figures elsewhere in this file were taken under a budget that did not
exist here, so nothing in this section speaks to cost. A second container is not a second host: both
images ran on the same kernel as the workstation, so shared library compatibility on another
distribution is still untested. Gate 3 needs a machine.
