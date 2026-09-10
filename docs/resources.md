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
