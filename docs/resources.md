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
