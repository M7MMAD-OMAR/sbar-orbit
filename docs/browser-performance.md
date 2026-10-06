# Matched private browser performance

This experiment compares production Orbit broker RPC with direct Playwright on
one Linux host. It uses the same discovered browser executable, headless mode,
1280 by 800 viewport, a disposable synchronous loopback form and one browser at
a time. Each arm starts a fresh worker and profile. Five pairs alternate which
arm runs first. Machine caches are warm; this is not a cold OS cache experiment.

Run, only while holding the shared test slot:

```sh
bun run scripts/limited.ts bun --smol run experiments/browser-performance.ts
```

The experiment has a 165 second admission deadline and each owned arm has a
25 second watchdog. It writes `output/browser-performance.json` even when a
measurement fails. Source files, lockfile, runner, fixture hash, browser path,
owned browser arguments and the shared resource budget accompany the result.
The source hash must match after execution. No runtime behavior is changed for
the benchmark, and no shared broker, accounts or native display are used.

## Metric contract

| Metric | Boundary and statistic |
|---|---|
| Session startup | Browser launch request to ready blank page, median and nearest-rank p95 of five arm runs |
| Startup to fixture | Same launch request through DOMContentLoaded of the loopback form |
| Cold worker startup | Parent spawn through ready blank page, includes module imports, broker creation and a matched 200 ms idle settling interval; uses same-host wall clock |
| CPU seconds | Python collector plus worker client and all waited descendants through shutdown; excludes the fixture server and experiment coordinator |
| Peak process-tree RSS | Largest sampled sum of the collector, worker and descendants, nominally every 50 ms; maximum sample gap and census failures printed |
| Idle broker overhead | Fresh idle Orbit worker RSS minus initialized direct worker RSS, before either starts a browser; five paired differences |
| Action latency | Ten sequential fill/click/read rounds, same text and verified output. Gate uses the median of five paired percentage differences in per-run mean action duration. Per-operation median/p95 is also printed |
| Frame latency | Three JPEG quality 80 capture requests per run, request to decoded response. Both use CDP Page.captureScreenshot; Orbit includes RPC and presence collection |

The idle worker is the benchmark client as well as the broker in the Orbit arm,
so the difference estimates additional broker module and idle service cost in
this arrangement. It does not measure an installed service's idle memory.
Browser and supervisor descendants are included only in the active tree metric.
RSS sums count shared pages in every process and may miss peaks between samples.
The Linux [resource usage contract](https://man7.org/linux/man-pages/man2/getrusage.2.html)
includes waited descendants in CPU accounting; its child `ru_maxrss` is the
largest child, which is why this experiment separately samples the RSS tree.

Direct Playwright uses its launch defaults and pipe transport. Orbit uses its
production CDP launcher and ownership supervisor. Browser flags therefore
differ beyond the matched executable, headless mode and viewport; both owned
browser command lines are retained for comparison. This measures the complete
public paths, not the isolated Unix socket transport. No result is evidence of
identical browser internals or a production workload.

The provisional targets from [acceptance.md](acceptance.md) remain strict:
median paired idle overhead below 100 MiB, and median paired extra action
latency below 20 percent. Equality is a failure. A missing, nonfinite or invalid
measurement is `not measured`. A measured target failure remains visible in the
report and must not be relabeled as a missing measurement.

Five startup observations and fifteen frame observations per arm are descriptive
samples. Their nearest-rank p95 is not a high-confidence population tail estimate.
Frame availability checks JPEG framing and nonempty payloads, not pixel accuracy.
Viewer displayed frame age, native performance, host focus and simultaneous
human work are not measured. This slice cannot close those acceptance gates or
raise a platform support tier.

## Evidence

On 6 October 2026, five matched pairs completed in 22.10 seconds on the Fedora
host, inside the shared four-core cgroup ceiling. All ten workers completed ten
verified form rounds and three JPEG captures. The collector reached `ECHILD`
for each tree. There were 413 RSS censuses, zero census failures and a maximum
sample gap of 68.08 ms. Source SHA-256 before and after was
`3d8a368cf649885c41486978e0995ae876bd0be3916c2c6a10b1ebd132765e5c`.
The runtime base was `0faa05c`; this measurement adds the experiment and tests
without modifying runtime behavior. Raw evidence is generated at
`output/browser-performance.json` and retained as `browser-performance.json`
in the checkpoint evidence directory, alongside the independent review reports.

| Metric | Direct Playwright median / p95 | Orbit RPC median / p95 |
|---|---|---|
| Session startup, ms | 437.78 / 594.58 | 488.25 / 698.50 |
| Startup through fixture, ms | 478.71 / 657.95 | 642.23 / 773.88 |
| Cold worker startup, ms | 953 / 1215 | 1040 / 1399 |
| Owned-tree CPU, seconds | 2.268 / 3.242 | 3.244 / 3.799 |
| Sampled peak tree RSS, MiB | 1138.30 / 1143.45 | 1395.43 / 1401.00 |
| Idle worker RSS, MiB | 109.24 / 110.22 | 116.54 / 118.53 |
| Fill, ms | 4.27 / 46.42 | 6.43 / 76.07 |
| Click, ms | 30.26 / 46.93 | 34.35 / 47.54 |
| Read, ms | 1.49 / 4.12 | 16.01 / 166.05 |
| Capture response, ms | 31.38 / 37.11 | 38.42 / 49.43 |

The median of paired idle worker differences was **7.30 MiB**, passing the
strict 100 MiB target within this idle-worker definition. The median of paired
extra mean action latency was **80.99 percent**, **failing** the strict
20 percent target. All five pair differences failed, ranging from 27.49 to
173.79 percent. The read operation showed the largest median gap. This is a
measurement of the two complete public paths with different production launch
defaults, not proof that one broker subsystem caused the gap. The active tree
RSS difference is not broker-only memory overhead.

The first two probe attempts failed browser mode validation and do not establish
a numeric target result. The first retained only its error and source identity,
so its exact failed predicate is not measured. The second retains the completed
direct worker and raw census, which identified Chrome child process titles
misclassified as root browser arguments. The regression for rewritten child arguments failed
on the unfixed classifier, then all seven focused tests passed after repair.
The NUL separator hypothesis was disproved by a passing test and is not claimed
as a defect. Logs and rejected attempts remain in the checkpoint evidence
directory beside the valid report. These are fixture-level measurements and
do not change any support tier or close the remaining acceptance gates.
