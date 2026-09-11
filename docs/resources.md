# Resource limits

Supported Linux launchers share one user cgroup slice, `sbarorbit.slice`.

| Resource | Aggregate limit |
|---|---|
| CPU | One logical CPU worth of time |
| Memory pressure threshold | 1792 MiB |
| Hard RAM limit | 2 GiB |
| Added swap | 0 |
| Tasks, including threads | 512 |
| Scheduling | Reduced CPU/I/O weights and niceness 10 |

```sh
bun run serve
bun run verify
bun run scripts/limited.ts bun run experiments/viewer-timing.ts 600
```

Limits cover owned jobs collectively, not unrelated applications or a viewer opened in an existing user application. A limit failure must never trigger an unrestricted retry. Cgroup membership is checked at browser startup and sampled by diagnostics; this is not a security boundary against same-user programs.

Browser workspaces use private disk-backed directories. Retained profiles on tmpfs would consume RAM after processes exit. The viewer reuses a Canvas and explicitly releases decoded frames. The earlier memory-pressure failures informed these changes; the corrected scripted run completed 10 minutes. See [validation](validation.md).

Diagnostics sample shared and per-run accounting separately. File cache, retained files and active application memory are different contributors. Do not sum per-process RSS as if shared pages were unique. The timing experiment stops above 1900 MiB shared charged memory, before the unchanged hard cap.

## Several sessions at once

`experiments/concurrent-sessions.ts` runs independent loops against one broker, each doing real work and checking its result: browser sessions fill a field, read the echo back across two tabs; private displays paste Arabic into a fixture and click its save button. Three browsers and two displays: 20 of 20 rounds correct in 9.8 seconds, median round 494 ms, 93.2 percent of one core, which is 3.9 percent of this 24 thread machine. The budget is the ceiling, not the session count: everything Orbit owns shares one core, so adding sessions stretches every round rather than failing any, until a deadline is reached. At six browsers and three displays, five sessions started and completed 20 of 20 rounds at a median of 2.0 seconds per round, and four were refused with `DEADLINE_EXCEEDED` after waiting 30 seconds behind the others to start; that refusal is the intended answer, since a caller has a deadline of its own and a backend nobody waits for is pure cost. That run also coincided with 85 percent host load from other work, so its round times are an upper bound.

Two things had to change for that to hold. Backends now start one at a time, because several Chromes and compositors booting together on one core timed each other out. And a paste is acknowledged when the shortcut is delivered, not when the application has read the clipboard, so an agent that clicks immediately after pasting can lose the click; the tool contract already says to wait for the text to appear, and the experiment does.

## Temporary files are memory

`/tmp` is tmpfs on Fedora, and tmpfs pages are charged to the cgroup that wrote them, for as long as the files exist. Private displays keep their runtime directory there: sockets, a copy of the person's theme, the compositor log, an application cache. Until this was fixed nothing removed those directories when a session closed. After a day of tests and experiments 2,942 of them held 1.5 GB, all charged to `sbarorbit.slice`, which sat at 1.28 GB of shared memory with no session running, 400 MB under `MemoryHigh`.

That is where the day's unexplained slowness came from. Above `MemoryHigh` the kernel does not kill, it throttles: every allocation in the slice stalls while pages are reclaimed. `memory.events` showed 3.2 million `high` events. The symptoms were a compositor that stopped answering its socket within five seconds, an input helper that missed its acknowledgement, a screenshot that took longer than three seconds, all at 45 percent of one core, which is what waiting looks like. Sessions and brokers now remove their directories when they close. `sbar-orbit doctor` reports `memory.current` and the `high` counter; a slice that is heavy while idle is this problem again.

## The desktop panel is not the cost

The panel and its mark were suspected of the processor load, so they were measured. `experiments/panel-cost.ts` launches the panel into a private display, samples its own CPU from the pid its launcher wrote over a fixed window, and samples the broker over the same window.

| Watching one session for 20 s | Share of one core |
|---|---|
| Panel process | 0.1% |
| Broker answering the panel's polls | 0.5% |
| Panel process, opening and closing the cards without pause for 20 s | 3.4% |
| Panel process, carrying the mark with the hand in continuous motion | 3.3% |

The panel resident set is about 116 MB, the ordinary cost of a Python and GTK process, and it is the person's own process outside Orbit's budget. The dot's blink and its colour transitions are CSS on the Cairo renderer, repainting a widget a few pixels across. The morph that draws the card out of the capsule is a Cairo path a few hundred pixels across, redrawn on the frame clock; the tick callback is added when the shape starts moving and removed when it settles, so the 3.4% row above is the worst case of a hand that never stops hovering, and a real hover pays it for a third of a second. Polling once a second is one session-list call and one presence read per open session, each a compositor tree query or a page-title read measured well under a millisecond of broker time. None of this moves a 24-core machine.

## What actually spikes the processor

When the machine stalls, the cause has been one of four, none of them the panel:

- **An agent waiting with `read -t N < /dev/zero`.** This is the one that produced the complaint that started this section, and it is invisible in `ps` because the process is called `bash`. `/dev/zero` never yields a newline, so the shell reads it a byte at a time as fast as the kernel allows: the wait is a spin that holds a whole core for its entire duration. Measured on this workstation on 11 Sept 2026: `read -t 3 < /dev/zero` costs 99% of one core, `python3 -c 'import time; time.sleep(3)'` and a read on a FIFO nothing writes to both cost 0%, and one live agent waiting 115 seconds had burned 102 seconds of CPU when it was caught. With several agents doing it at once the load passed 18 on 24 logical CPUs and the desktop stalled. Agents reach for it because their harness refuses a foreground `sleep`. Find it with `ps -eo pid,pcpu,args --sort=-pcpu | grep /dev/zero`.

- **A leftover session running a heavy application.** A private display that launched an Electron application, a browser with many tabs, or a build, and was never stopped, keeps every one of those processes alive inside `sbarorbit.slice`. Measured on this workstation: one forgotten display running the Hermes desktop application held the slice at 1.5 GB against its 1792 MB high mark, and the slice throttles rather than kills above that mark, so everything in it stalls at once. Stopping the session dropped the slice to 717 MB and the stall cleared. Check with `sbar-orbit status`; stop what you do not recognise, and `sbar-orbit clean` reclaims the disk a killed broker left.
- **The slice starving under host load.** `sbarorbit.slice` has `CPUWeight=10`, so when the rest of the machine is saturated the agents' work is throttled by design and its own startups then time out, which reads as a spike inside the slice while the true load is elsewhere. Read `/proc/loadavg` and `systemd-cgtop` before blaming Orbit.
- **A runaway process from another agent.** Several coding agents share this machine. A stuck shell or a spinning build from one of them can pin a core at 100% with nothing to do with Orbit. `ps -eo pid,pcpu,args --sort=-pcpu | head` names it in one line. Measured once: six Claude Code sessions in one scope, one of them running a test pool sized to the core count, took that scope to 16.8 of 24 cores and 11.5 GB.

## What actually freezes the desktop

A stall is not a freeze. This workstation records every stall it notices, and of 868 captures only 18 show a desktop that stopped answering for two seconds or more, the worst of them for 51 seconds. All 18 are dated 2 to 7 Sept 2026, and all 18 carry the same signature: swap 100% full, under 1.5 GB of memory available, and two or three agent processes holding almost all of it, 14.2 GB in one and 6.5 GB in another. No Orbit process appears in any of them. The desktop froze because the machine ran out of memory and swap, not because anything was busy.

The stalls that are not freezes are disk, not processor: 698 of the 868 captures have tasks blocked in btrfs page and tree locks, and the names blocked there are the agents' own runtimes and browsers. A contributor worth naming is the 41 containers that restart themselves at boot: their health checks fork about 179 processes a second, and every one of those is namespace and cgroup work against btrfs metadata.

So the order of suspicion for a freeze is memory first, disk second, and processor last. Orbit is capped at one core and 1792 MB and cannot cause any of the three; its own throttling is contained to itself, which `wchan` confirms, since every task ever caught waiting on the memory-high mark belonged to Orbit and none to the desktop.

The order to diagnose in: `/proc/loadavg` first, then `sbar-orbit status` for a heavy leftover, then the slice's `memory.current` against its high mark, then the top CPU consumer machine-wide. See [[orbit-slice-starvation-causes]] in the project memory for the measured history.

## When the host is busy

The slice carries `CPUWeight=10`, a tenth of the default. That is deliberate: the person's own work always wins. The consequence is that Orbit is not merely capped at one core, it is the first thing starved when the rest of the machine is busy. Measured on this workstation during another agent's test run, host load 20 to 32 on 24 logical CPUs, private displays failed to start and applications failed to map within their deadlines, while the same commands on a quiet host succeed in seconds. A report from a busy host measures the host, not Orbit; every experiment records `hostBusyPercent` so the two are not confused.

## Session surface size

A session starts at 1280 by 800 and can be created or resized up to a total of 1,920 by 1,200 pixels. The cap is on the total pixel count rather than on each side, so an unusual shape is allowed while the cost of a frame stays bounded.

The cap comes from this measurement, not from a guess. One size at a time, one backend at a time, 24 frames requested back to back with no viewer attached, on the shared one-core budget:

| Browser surface | Pixels | Median capture | Frame size | Back to back | Projected at 1 frame/second |
|---|---|---|---|---|---|
| 1280 by 800 | 1,024,000 | 50.9 ms | 92 KiB | 51.2% | 5.1% |
| 1600 by 1000 | 1,600,000 | 51.4 ms | 147 KiB | 67.5% | 5.1% |
| 1920 by 1080 | 2,073,600 | 50.9 ms | 213 KiB | 76.3% | 5.1% |
| 1920 by 1200 | 2,304,000 | 52.6 ms | 227 KiB | 77.6% | 5.3% |

| Private display | Pixels | Median capture | Frame size | Back to back | Projected at 1 frame/second |
|---|---|---|---|---|---|
| 1280 by 800 | 1,024,000 | 16.4 ms | 42 KiB | 71.9% | 1.6% |
| 1600 by 1000 | 1,600,000 | 16 ms | 58 KiB | 91.1% | 1.6% |
| 1920 by 1080 | 2,073,600 | 16.9 ms | 70 KiB | 99.3% | 1.7% |
| 1920 by 1200 | 2,304,000 | 16.8 ms | 77 KiB | 100.8% | 1.7% |

Two things follow from this. Capture latency is almost flat across the range, because it is dominated by the round trip and the encoder's fixed cost rather than by pixels, so at the viewer's default cadence of one frame per second a larger surface costs roughly what a small one costs. Continuous capture is not flat: the private display already reaches a whole core at the cap, which is where the headroom ends and why the cap sits there.

The cheaper way to give one application room is `window` with `fullscreen` on a native session. It changes nothing about the captured size, so it costs nothing per frame.

Reproduce with `ORBIT_TEST_NATIVE=1 bun run scripts/limited.ts bun run experiments/surface-cost.ts`. Run it alone: a second bounded command splits the same budget and the numbers then describe the contention instead of the surface.

## Read-only CPU observation

```sh
bun run scripts/limited.ts bun run scripts/measure-cpu.ts 5
```

This samples aggregate counters for 1 to 30 seconds without starting a broker, browser or agent. It records no process arguments, page titles or credentials. Orbit includes every job in its shared slice and the sampler itself. The external desktop viewer is outside that slice.

| Output | Meaning |
|---|---|
| `orbitOneCorePercent` | 100 means one logical CPU used throughout the interval |
| `orbitMachinePercent` | Orbit usage divided by the number of logical CPUs |
| `hostBusyPercent` | Whole-machine CPU time, excluding idle and iowait |
| `hostIowaitPercent` | Separate whole-machine iowait fraction |

Rates use two counter samples and monotonic elapsed time. Reads are approximate, not atomic. Invalid intervals, counter resets and changed CPU counts are rejected. Guest columns are excluded because their time is already included in user/nice. See Linux [cgroup CPU accounting](https://docs.kernel.org/admin-guide/cgroup-v2.html) and [proc statistics](https://docs.kernel.org/filesystems/proc.html).

A 3-second sampler-only check succeeded after live trials were stopped. It validates collection, not the cause of the participant's earlier CPU spike or the cost of the real desktop viewer. The low-cost preview modes still need rendered and participant resource validation; live trials remain on hold.
