# Scoped native cursor cost

Measured 4 October 2026 using two real scoped GTK targets and a simulated person
window on a private nested KWin/Hyprland display. Eight six-second samples use
forward and reverse idle, static, read-only state and moving-cursor order.
Native guarded session actions and durable logs remain enabled. Fixture geometry,
simulated person focus, compositor identities and plugin binding remained stable.

| Phase | Pair response median | Pair response p95 | Probe CPU, forward/reverse | Hyprland CPU, forward/reverse | KWin CPU, forward/reverse | Missed pair deadlines |
|---|---:|---:|---:|---:|---:|---:|
| Idle | Not applicable | Not applicable | 0.17% / 0.00% | 1.00% / 0.17% | 1.50% / 0.33% | Not applicable |
| Static cursor | Not applicable | Not applicable | 0.00% / 0.00% | 0.00% / 0.00% | 0.33% / 0.17% | Not applicable |
| Read-only state | 40.91 ms | 47.51 ms | 15.33% / 17.33% | 3.00% / 3.67% | 0.17% / 0.33% | 2 / 14 |
| Moving cursor | 40.43 ms | 49.03 ms | 14.67% / 16.17% | 4.33% / 5.00% | 2.00% / 2.83% | 0 / 10 |

A pair means one sequential action per target. CPU is a percentage of one core.
Requested cadence is 20 pairs per second; achieved sample averages are within
0.001 pair per second, with the deadline misses printed above. Average cadence
does not prove every update met its deadline. Zero CPU ticks over six seconds
is below the tick resolution, not zero overhead. Read-only and moving response
costs are similar, so the guarded command path needs profiling before attributing
that cost to cursor drawing.

Approximate RSS was 279 MiB for Hyprland, 399 to 401 MiB for the outer KWin,
and 37 MiB for the probe. These include shared pages and are not added together
as unique memory. They describe the nested lab, not a production owner's desktop.

The targets stay in their pre-map scoped workspace. There is no viewer capture
during timing. Application and helper CPU are excluded. Public broker overhead,
actual visible display/input latency, old-system comparison, owner compositor
cost and whole-system performance are **not measured**. The O0 plugin is a
prototype build. This result does not establish performance acceptance or
superiority over the older private system.

Private evidence is retained in `.private/native-cursor-cost-762947/report.json`,
its `diagnostics/control/actions.jsonl`, and `.private/native-cursor-cost-summary.json`.
The report binds the probe and runtime sources by SHA256 and identifies the
loaded plugin binary/source. Failed setup attempts are retained separately.
All owned applications, simulated devices and the private lab were closed.

The probe is `native_cursor_cost_probe.py`. Run it through `lab.py run LAB --`
and `bun run scripts/limited.ts` after creating a disk lab, loading the exact
prototype plugin and holding the lab's virtual pointer/keyboard devices. It
never accepts an owner display or input device and preserves the controller log
through cleanup. Linux accounting reference, reviewed 4 October 2026:
https://docs.kernel.org/filesystems/proc.html.

## Guarded-action profile

A separate system-Python cProfile run on unchanged sources completed all eight
phases and cleanup. Instrumentation adds overhead, so its timings locate
bottlenecks and do not replace the benchmark above. Native session execution
accumulated 20.820 seconds across 984 calls. Fresh unit-property queries accumulated
14.374 seconds across 2962 calls, including 14.201 seconds in subprocess.run.
Lease verification accumulated 14.663 seconds, transport exchange 3.075 seconds,
host revalidation 2.378 seconds and journal recording 1.557 seconds. These are
overlapping cumulative call-tree totals, not independent costs to sum.

The main candidate is replacing repeated systemctl subprocess queries with fresh
reads through the manager's supported D-Bus interface. Invocation, active-state,
cgroup identity and bounded errors must still be checked for every verification.
No ownership decision may be cached to obtain the speedup. This optimization is
not implemented or measured yet.

Profile artifacts: `.private/native-cursor-cost.profile`,
`.private/native-cursor-profile-summary.json`, and
`.private/native-cursor-cost-880266/report.json`. All 15 source bindings were
verified and the owned lab was closed. Official profiler scope:
https://docs.python.org/3/library/profile.html. The rendered systemd manual was
inaccessible; its official source documents GetUnit and the unit D-Bus interfaces:
https://raw.githubusercontent.com/systemd/systemd/main/man/org.freedesktop.systemd1.xml.

## Fresh manager read candidate

On 4 October 2026, native leases began using fresh GIO D-Bus connections when the system Python binding is available. Every action still reads current state and preserves invocation, exact cgroup and process identity checks. No connection or state is cached. Missing bindings retain the systemctl path; a failed D-Bus query refuses the action. Connection/read cancellation and separate bounded connection cleanup retain failures.

A real owned service-only comparison matched all three properties across two alternating rounds of 50 reads per method. D-Bus median was 1.25/1.63 ms; systemctl median was 4.83/5.09 ms. The stopped service was refused and all recorded member identities disappeared. The raw source-bound proof is retained privately as native-manager-live.json. Cold import and Scope-specific integration were not measured by this comparison.

The unchanged two-target cursor workload completed eight samples on the new implementation. Moving-pair median was 20.71 ms versus the prior 40.43 ms; both new moving samples had zero scheduled deadline misses. These are separate source-bound runs, not simultaneous measurements. Probe CPU increased to 25.83/25.67 percent of one core from 14.67/16.17 percent. The previous CPU scope excluded systemctl child processes, while the new GIO work occurs inside the measured probe. These figures do not determine total CPU improvement or regression. Child-process accounting and a repeated original/new comparison are required before overall efficiency acceptance. Raw report: .private/native-cursor-cost-1103093/report.json, with all fifteen source hashes independently verified. The owned lab was removed after bounded cleanup. Whole-system performance and owner activation remain not measured.
