# First browser experiment

**Result:** passed on Fedora 44, Chrome 152.0.7977.82, Bun 1.3.14 and Playwright 1.63.0. This is a real browser smoke test, not a simulation of native desktop isolation.

## Reproduce

```sh
bun install --frozen-lockfile
bun run verify
```

Requires Google Chrome (`channel: chrome`) and a running Hyprland session for telemetry. It serves a disposable fixture on an OS-assigned loopback port. Missing telemetry fails the test rather than producing a false pass. No real accounts, personal browser attachment, system package installation or system configuration change.

Outputs: `output/playwright/latest.json`, `agent-a.png`, `agent-b.png`. Each run creates a fresh temporary profile root recorded in its report. Those fixture-only profiles are retained and never reused; delete a specific recorded root manually if no longer needed. Browser processes and the fixture server close at test exit.

## Measured run

The table is frozen evidence from [validation summary](validation.md). Re-running tests updates `output/playwright/latest.json`, not this table.

| Measurement | Result |
|---|---|
| Bun test | 1 test passed, 0 failed, 33 assertions |
| Concurrent browser sessions | 2 |
| Form submissions | 26, including the surviving browser after its peer stopped |
| Independent storage after reload | Passed for both sessions |
| Startup of both browsers | 850 ms |
| Stop first browser | 42 ms |
| Whole experiment | 1,701 ms |
| Hyprland samples / maximum gap | 16 / 147 ms |
| Owned browser PID active or visible | 0 sampled hits |
| Peak RSS of profile-matched processes | 2,259 MiB |
| Profile-matched process RSS after closing | 0 KiB |

Resource numbers are a partial process measurement, not Orbit overhead: command-line matching can omit descendants, and summed RSS can count shared pages repeatedly. There is no matched baseline or CPU measurement yet. Do not use this run to claim the final design is lightweight.

Polling can miss transient focus changes. Launching headless with `DISPLAY` and `WAYLAND_DISPLAY` removed, using only browser APIs, and observing no window/focus hits supports the narrow result. Continuous event monitoring and the longer simultaneous-work test remain necessary.

## What this closes

Task 1's browser smoke experiment is complete. T1, T2 and T5 have partial evidence, not full release acceptance: this run is shorter than the planned stress test and there is no session broker yet.

Not tested: live viewer, real agent-host adapters, account connection, native app input/capture, file workflows, malicious bypass, macOS or Windows. Weston, Xvfb, Sway and WayVNC were not installed during the inventory. Xwayland, wtype and grim were present; their presence alone does not prove a private desktop path.

The session broker and CLI prototype from Task 2 now exists; see [CLI](cli.md) for its separate integration tests and limits. Native display research must continue before advertising a general workspace.

## Subsequent reliability observation

Two full suite runs timed out in this original browser experiment after 60 seconds while the other 13 tests passed. A standalone rerun passed in about 1.7 seconds. It also passed when run immediately after the native crash suite, and after the account suite. The exact cause remains unproven; the full-suite interaction still needs investigation. Startup, navigation and action deadlines are now explicit, and each run records its current phase and replaces the latest report with a running marker before starting so an interrupted run cannot masquerade as an earlier pass. This is an open stability observation, not a resolved failure claim.

## Current bounded launcher

Diagnostics located the full-suite failure at browser startup with a broken Chrome DevTools pipe. The browser launcher now owns Chrome beneath a process supervisor, reads its unique local endpoint, and connects through Bun WebSocket using the supported Playwright CDP transport interface. Targeted lifecycle tests passed before the resource pause; the new bounded single-browser measurement also passed. The default suite on this transport now passes under the shared caps; the combined native-enabled suite subsequently passed after a separate native IPC transport fix; see [native results](fedora-results.md). [Resource evidence](resources.md).

## Default suite under resource caps

The first measured default-suite run after the transport change passed 11 tests with 127 assertions, no failures and 7 optional native tests skipped. The previously failing two-browser experiment passed inside that run. Total duration was 77.212 seconds, with 73.524 CPU seconds, 3.97% average CPU across this 24-thread machine, 842,809,344 bytes peak cgroup memory and zero swap. No memory or task-limit events occurred in the run's scope. Its browser-only host samples saw no Orbit window/focus hits, but the maximum sampling gap was 1.373 seconds; this is not continuous no-interference proof.

[validation summary](validation.md) and [validation summary](validation.md). Reproduce with `bun run scripts/limited.ts bun run experiments/measured-suite.ts`. The runner limits execution to 90 seconds and the wrapper cleans the scope afterward. The longer duration reflects a one-CPU aggregate cap and is not a matched overhead baseline. This is one default-suite pass, not repeated stability evidence or a combined native-suite result.

## Abrupt broker death with a browser

`bun run verify tests/browser-crash.test.ts` passed 1 test and 6 assertions in 3.52 seconds under the shared resource cap. The test creates a real browser, snapshots descendants across every broker/child task thread, kills only that broker with SIGKILL and waits for the sampled processes to disappear from `/proc`, including zombie entries. A fresh broker rejects the stale session ID, creates a new browser, returns a PNG frame and stops it successfully.

This validates one abrupt broker-death path. The descendant snapshot cannot prove coverage of processes created after sampling, and it does not test independent supervisor death, machine reboot or memory exhaustion. The measured combined-suite record predates this added test; the new case was verified separately.

## Two broker sessions, 100 submissions each

The real Unix-socket broker accepted two concurrent scripted clients. Each browser filled and submitted 100 distinct values, including Arabic, with exact page readback and a server-side ledger. Twenty page reloads verified independent localStorage on the same origin. The ledger contained exactly 201 unique, single submissions: 100 per session and one additional submission from B after A stopped. No personal browser was attached.

The bounded run passed in 33.381 seconds. Startup for both sessions took 5.545 seconds; A's closed acknowledgement took 184 ms. The run used 31.329 CPU seconds, averaging 3.91% of this 24-thread machine, with 651.3 MiB peak scope memory, zero swap and no memory/task-limit events. Scope memory includes descendants and charged cache. These are averages and a single run, not instantaneous CPU peaks or a matched overhead benchmark.

[validation summary](validation.md). Reproduce with `bun run scripts/limited.ts bun run experiments/concurrent-browser.ts`. This supplies the 100-action isolation count for T2 through actual broker RPC, using at least 300 actions per session. It does not replace the 10-minute simultaneous human-work gate, model-driven native workflows or host focus telemetry. Stop timing measures acknowledgement; separate lifecycle tests cover sampled child cleanup.
