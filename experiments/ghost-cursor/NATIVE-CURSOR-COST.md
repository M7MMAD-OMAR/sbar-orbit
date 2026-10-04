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
