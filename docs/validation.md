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
| Source archive | Extraction, source checksums, browser capture and packaged Canvas rendering passed for `0.1.0-alpha.1` | `scripts/package.ts`, `experiments/package-smoke.ts` |
| A browser with no network of its own | A leased session browsed normally while confined; CDP crossed the network namespace, the leased https authority was tunnelled and the far end saw the connection, the unleased one was not, the unleased plain HTTP server was never touched, and no sockets, wrapper or helper processes were left behind | `bun run scripts/limited.ts bun run experiments/confined-egress.ts` |
| Removing the browser's own proxy setting | Reaches nothing at all while confined, against everything while unconfined. This is the difference between a lease and a setting the browser agreed to honour | `bun run scripts/limited.ts bun run experiments/egress-lease.ts` |
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

Repeat the command three times for this check. This is repeatability evidence on one Fedora host, not power-loss recovery, independent supervisor death, arbitrary application compatibility or proof that a snapshot captures later descendants. Human takeover remains unconfirmed.

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

The suites are sensitive to machine contention rather than flaky in themselves. Running a second `scripts/limited.ts` command alongside a suite splits one shared cgroup budget, and viewer tests that wait for a fresh frame then time out. Six consecutive gate runs failed only in the two runs that overlapped other measured work, including pre-existing browser scroll and CLI tests. Run one bounded command at a time.

This is a confirmed defect with a regression test, not yet a confirmed explanation of the participant's report. Participant-read viewer cost figures remain required before another resource-acceptance claim.

The participant's desktop viewer runs outside Orbit's runtime cgroup. Prior headless-viewer measurements do not prove acceptable cost inside the actual desktop app. Further interactive trials are on hold pending investigation of capture/decode/compositing cost and a participant-controlled low-cost viewing mode. Preserve the failed result when judging release readiness.
