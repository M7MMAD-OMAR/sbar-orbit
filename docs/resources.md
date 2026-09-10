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
