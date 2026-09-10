# Validation summary

These are alpha measurements, not guarantees for arbitrary applications. Raw workstation logs, profiles, conversation identifiers and access links are intentionally excluded from the public repository.

| Area | Observed outcome | Reproduce |
|---|---|---|
| Browser/viewer stability | 600 seconds, 2077 submissions, 3005 frames, 5.006 FPS; maximum sampled frame age 284 ms | `experiments/viewer-timing.ts 600` |
| Resources | Per-run peak about 951 MiB; no new OOM or hard-limit events; zero added swap | Same bounded timing run |
| Process containment | 117 sampled tree audits found no escapes; cleanup left no owned processes | Timing run and `tests/chrome-containment.test.ts` |
| Default and native tests | 27 distinct tests passed across default and native-enabled executions before public packaging | `bun run verify`, then native tests with `ORBIT_TEST_NATIVE=1` |
| Agent hosts | Claude Code and Codex completed browser tasks and native editor saves in opt-in trials | Model-host experiments; authenticated host required |
| Source archive | Extraction, source checksums, browser capture and packaged Canvas rendering passed for `0.1.0-alpha.1` | `scripts/package.ts`, `experiments/package-smoke.ts` |

All runtime experiments must use `bun run scripts/limited.ts` on supported Linux systems. The native tests require the documented Fedora bootstrap. Model-host trials are not part of the default suite and may incur model-service usage.

Sampling cannot exclude every transient focus or cgroup change. Frame metadata approximates readiness, not physical display latency. A successful scripted run does not confirm simultaneous human work. macOS, Windows, clean-machine installation, broader application coverage and broader failure coverage remain open.

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

The participant's desktop viewer runs outside Orbit's runtime cgroup. Prior headless-viewer measurements do not prove acceptable cost inside the actual desktop app. Further interactive trials are on hold pending investigation of capture/decode/compositing cost and a participant-controlled low-cost viewing mode. Preserve the failed result when judging release readiness.
