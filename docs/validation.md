# Validation summary

These are alpha measurements, not guarantees for arbitrary applications. Raw workstation logs, profiles, conversation identifiers and access links are intentionally excluded from the public repository.

| Area | Observed outcome | Reproduce |
|---|---|---|
| Browser/viewer stability | 600 seconds, 2077 submissions, 3005 frames, 5.006 FPS; maximum sampled frame age 284 ms | `experiments/viewer-timing.ts 600` |
| Resources | Per-run peak about 951 MiB; no new OOM or hard-limit events; zero added swap | Same bounded timing run |
| Process containment | 117 sampled tree audits found no escapes; cleanup left no owned processes | Timing run and `tests/chrome-containment.test.ts` |
| Default and native tests | 27 distinct tests passed across default and native-enabled executions before public packaging | `bun run verify`, then native tests with `ORBIT_TEST_NATIVE=1` |
| Agent hosts | Claude Code and Codex completed browser tasks and native editor saves in opt-in trials | Model-host experiments; authenticated host required |
| Source archive | Extraction, source checksums, browser capture and packaged Canvas rendering passed for a local prototype | `scripts/package.ts`, `experiments/package-smoke.ts` |

All runtime experiments must use `bun run scripts/limited.ts` on supported Linux systems. The native tests require the documented Fedora bootstrap. Model-host trials are not part of the default suite and may incur model-service usage.

Sampling cannot exclude every transient focus or cgroup change. Frame metadata approximates readiness, not physical display latency. A successful scripted run does not confirm simultaneous human work. macOS, Windows, clean-machine installation, broader application coverage and repeated recovery remain open.
