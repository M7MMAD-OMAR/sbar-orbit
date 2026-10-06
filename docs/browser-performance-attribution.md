# Browser performance attribution, October 6, 2026

The browser action latency target remains **failed**. The uninstrumented five-pair measurement recorded a median paired increase of 80.99%, against the 20% limit. The separate instrumented run identifies synchronous restore snapshots as the dominant measured read stage. The snapshot prototype shows a possible median gain, but no production optimization was applied and improved browser latency is **not measured**.

The baseline method and its limits are documented in [browser-performance.md](browser-performance.md). Acceptance and capability claims remain governed by [acceptance.md](acceptance.md) and [support-tiers.md](support-tiers.md). These measurements do not close the native handoff hold or establish human focus isolation, real account use, viewer age, other hosts, or application coverage.

## Source and method

The attribution run used commit `e621ab255706cf6f9ebb8e0007e40b0702e8f896` with an unchanged copy of the performance collector. Its ordered runtime, script and lockfile manifest digest was `5cac3b96dffe1644449339123e7e24add987372dddcd8a75bc69840670955def` before and after execution. The collector digest was `f519a721754fddecd4f803e5c0ca55371ba0224d868ab558c2d3f2b941a3f66f`. The earlier baseline used commit `0faa05c` and a different manifest digest. Do not combine the two runs as an optimization comparison.

Both runs used the same loopback fixture, Chrome executable, 1280 by 800 viewport, fresh profiles, five alternating direct Playwright and broker pairs, ten fill/click/read rounds per arm, and three JPEG captures. Launch flags and transport differ between the direct and broker arms. Concurrency was one, inside an exclusive shared resource slot. No real accounts or personal browser paths were used.

An external preload called each original function once, with its original arguments and receiver, and awaited its completion. It timed diagnostic writes, the guarded action boundary and the browser backend. It also recorded whether the restore store was active, added restore point counts and the original reported snapshot duration. Request-local association used `AsyncLocalStorage`. Policies, journals, diagnostics and snapshots retained their original behavior. The preload changes observation overhead and imports, so the instrumented aggregate is not release target evidence.

The 175 stage records map to five broker workers with 35 requests each. The five direct workers and coordinator recorded no broker stages. Each timed action type has 50 samples. The restore store was active for all 150 timed actions: reads added 50 snapshots; fill and click added none, matching their reversibility classification.

## Read stage results

| Measured interval | Mean, ms | Median, ms | p95, ms |
| --- | ---: | ---: | ---: |
| Original reported snapshot duration | 17.700 | 8.000 | 42.000 |
| Guarded interval minus backend | 17.733 | 8.217 | 41.597 |
| Browser backend | 2.420 | 2.105 | 4.947 |
| Sum of two diagnostic writes | 0.687 | 0.524 | 1.663 |
| Diagnosed broker request | 21.005 | 11.505 | 45.067 |

The guarded residual was 84.42% of mean diagnosed read time. It includes snapshot control overhead and taint handling, not just the snapshot subprocess. The reported snapshot duration is rounded to milliseconds. These intervals overlap and must not be added indiscriminately. Percentiles use `sorted[ceil(N * 0.95) - 1]`; medians use the midpoint for even sample counts.

Backend means were 13.023 ms for fill and 35.723 ms for click. Their diagnostic means were 0.877 ms and 0.776 ms, while guarded residual means were about 0.023 ms for each. The instrumented five-pair aggregate still failed at 56.76% extra action latency. None of these values proves counterfactual savings from replacing a stage.

## Disposable snapshot prototype

The separately authorized data-only prototype compared the current `/usr/bin/btrfs subvolume snapshot -r` command with a directory-FD-based `BTRFS_IOC_SNAP_CREATE_V2` call. Local Linux UAPI headers were compiled to obtain ioctl numbers, the 4096-byte structure layout and field offsets. The [Btrfs ioctl contract](https://btrfs.readthedocs.io/en/stable/btrfs-ioctl.html) identifies the destination directory as the ioctl FD, the source directory as the structure's FD, and the read-only flag as a snapshot option. The prototype used one owned synthetic Btrfs source and destination fixture, with 20 alternating pairs.

| Snapshot mechanism | Median, ms | Mean, ms | p95, ms |
| --- | ---: | ---: | ---: |
| Current CLI | 13.026 | 80.641 | 31.031 |
| Kernel ioctl prototype | 7.254 | 11.919 | 36.265 |

The ioctl was faster in 16 of 20 pairs. Median paired reduction was 36.79%, but its p95 was worse. Pair zero contained a 1356.271 ms CLI outlier and remains in the primary result. A separate sensitivity calculation without that pair gives means of 13.503 ms for CLI and 10.123 ms for ioctl, with median paired reduction of 35.47%. That calculation does not replace the primary measurement.

All 40 snapshots captured the asserted payload bytes before return, preserved that payload after source mutation, carried the read-only flag, rejected writes with `EROFS` and were removed. Selected invalid names and final-component source/destination symlinks were refused. Final FD counts matched and cleanup reported no failures. Recursive equality of all fixture files was not asserted.

Kernel version, btrfs-progs version and mount options were not recorded. This prototype has no warmup. The arm labels produce different payload lengths, despite the same workload shape. It does not measure ancestor symlink policy, ioctl failures, existing destinations, permission failures, cleanup failures, cancellation, original error preservation, ABI portability, an asynchronous production executor, or CLI fallback behavior. It is mechanism evidence on one Linux host, not a regression test or production acceptance pass.

## Production decision and retained evidence

No production binding is admitted from this measurement. [Bun's FFI guidance](https://bun.com/docs/runtime/ffi) labels `bun:ffi` experimental and recommends Node-API for stable native interaction. A worker around experimental FFI would address main-loop blocking without establishing binding stability. A supported optional Node-API binding would expand build, packaging and CI scope.

Any future implementation must await snapshot completion before backend work, retain snapshot ownership through stop and cleanup, close directory FDs on every path, preserve names and consistency markers, and keep the original CLI fallback when the binding is unavailable. An operational ioctl error must not automatically start a second snapshot attempt. A timeout cannot be treated as cancellation of an in-flight kernel operation. Production admission requires independent design review, supported ABI and packaging evidence, meaningful old-source failure, corrected-source lifecycle checks and a new comparable browser measurement.

Independent reviews passed the scoped original-call attribution and prototype artifact evidence. Neither reviewer executed a new runtime measurement. Hash equality establishes local consistency, not authenticated provenance or continuous integrity. The preload has a saved pre-run digest and independently matching current digest, but no separately saved literal post-run preload digest; its post-run equality is recorded as a boolean.

The complete machine-local evidence is retained under `$CODEX_HOME/orbit-completion/2026-10-06/browser-attribution/` and `$CODEX_HOME/orbit-completion/2026-10-06/snapshot-micro/`. These external artifacts are not included in a repository clone. They contain the raw benchmark/stage records, preload, manifests, quantiles, scoped reviews, prototype source, ABI values, all pairs, sensitivity calculation and runtime result. Their absence elsewhere means that local raw evidence cannot be independently rechecked from this document alone.
