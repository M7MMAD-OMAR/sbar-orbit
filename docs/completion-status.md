# Completion status and evidence

Snapshot: 6 October 2026. [PR 4](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/4)
is merged into official `main` at `56fd8f318c5ec2aaded827a8be89387bf54579f1`.
Its tree `68f03eff2e89fe7b5ff19eb691453f6d4de4b2ff` equals the tested integration
`333b92e`. Historical evidence remains separately identified below.
The checkout declares package version `0.2.0`. The published
[GitHub release v0.2.0](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.2.0)
points to `af37cc4` and does not include the current main fixes. Registry `latest`
is `not measured`. The [roadmap](roadmap.md) retains historical gate detail.

**Full external-user acceptance is open. Native owner handoff is held unconditionally.**
A successful installation is installation state. A skipped or unknown measurement
is `not measured`, never a pass. Apply the [support tiers](support-tiers.md) beside
each capability; a completed fixture or CI portion does not close its full user story.
The governing bar is [acceptance.md](acceptance.md), U1/T1 through U12/T12 plus its
performance and failure gates.

The coordinated [platform closure contract](platform-closure.md) records branch
reconciliation, the current defect investigations and the dependency order for
the remaining product, performance, portability and external acceptance tasks.
It preserves the full acceptance scope and the unconditional native hold.

## Verified official-main integration

[Run 37474272086](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37474272086)
completed all nine normal workflow jobs successfully on `333b92e`, whose complete
tree matches merge `56fd8f3`. Each platform suite reported 809 tests in 176 files.

| Runner | Pass | Skip | Fail |
| --- | ---: | ---: | ---: |
| Ubuntu 24.04 x64 | 714 | 95 | 0 |
| Windows x64 | 492 | 317 | 0 |
| macOS arm64 | 504 | 305 | 0 |

The retained local combined-runtime suite passed 761 tests, skipped 49 and failed
none: 810 tests in 176 files, 243.89 seconds. TypeScript exited zero. Local evidence
is retained under `/var/tmp/orbit-consolidation-2026-10-06`; these runtime checks
precede this documentation update. The different platform counts reflect executed
coverage, not proof of skipped capabilities. Native acceptance is not established.

Core checkpoint review remains incomplete because the original Ubuntu startup
cause is unresolved. A diagnostic observed 29.123 seconds before CDP connection;
it locates a delay boundary without explaining its cause. A successful normal
suite does not close that investigation, the failed performance target, external
acceptance or the native hold. Five isolated workstreams are investigating the
remaining scope under the [closure contract](platform-closure.md#current-execution).
Their changes require coordinated review and fresh integration evidence.

## Remaining workstream snapshot

These results belong to isolated workstreams and do not establish a new combined
runtime or release. [PR 5](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/5) is a draft
at `d3745811fcbb29851859985e1aa9506d10453731`; it is not merged into main.
[Run 37490050966](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37490050966)
failed the rendered onboarding checks on all three platforms because the generated
website routes were absent. The build step exited zero after printing Bun usage
without running Vite or prerendering. A clean-output reproduction confirmed that
behavior. Corrected command execution generated both routes locally; final source
review and fresh platform CI are still required.

The current managed-lifecycle workstream fixtures executed 119 tests, skipped 20
and failed none; TypeScript exited zero. Independent specification and operational
reviews are still required. These fixtures do not establish actual macOS service,
Windows task or published installation acceptance.

Fresh actual Claude, API and CLI disposable browser reports each record seven
successful actions and empty owned-process cleanup lists. Independent reviews
validated their actual receipts, images, source and launcher identities and 14
recorded process creation witnesses per run. These checkpoints are accepted only
at the Limited disposable browser fixture tier, with sampled cleanup coverage.
The separately reviewed Codex run establishes its seven fixture actions only;
model use of image pixels and external-user acceptance are not measured by those
results.

The corrected owned-browser performance baseline measured 42.942314 percent
latency overhead, which fails the 20 percent target, and 5.523438 MiB idle overhead,
which passes the 100 MiB target. Its source identity is
`b19eea35f74d1ba522490735b3c6dfc41d8224a3d78e27b2383271afcf9e2635`;
retained report SHA256 is
`1f398e1f0ea0a919c9b369a0c7ecbc383acd37414c41a660a271238424ec0bf8`.
This is a new measurement of unchanged production behavior, not a production
optimization or an improvement claim relative to a different historical run.
Attribution identifies snapshot child lifecycle as a large read cost; it does not
prove a kernel-only limit. A safe production repair remains required.

## Historical completed evidence portions

The earlier retained full workflow is
[run 37415015766](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37415015766)
on runtime source `1e9e88e37d299fe6ea3aed6c51e4fa6142cdcb81`. All nine jobs succeeded
on their first attempt. Later documentation does not imply a newer runtime was tested.

| Runner | Pass | Skip | Fail | Executed scope |
| --- | ---: | ---: | ---: | --- |
| Ubuntu 24.04 x64 | 687 | 94 | 0 | 781 tests in 169 files |
| Windows x64 | 469 | 312 | 0 | 781 tests in 169 files |
| macOS arm64 | 480 | 301 | 0 | 781 tests in 169 files |

The [source-bound portability ledger](portability-verification.md#corrected-exit-measurement-and-fresh-windows-owned-tree-cleanup-evidence)
retains logs and artifact links. Completed portions at **Limited** tier are:

- Checkout-built archive installation and installed-launcher browser create, navigate,
  read, pause refusal, resume, observe and stop on disposable runners. Bun and browser
  prerequisites were provisioned. Native installation was skipped. A published
  release on a fresh external device was not tested.
- Nine generated Claude, Codex and Hermes MCP entries negotiated 16 tools. Actual
  host CLIs were absent, so their real integrations remain `not measured`.
- Ubuntu passed the original intentional EACCES close-notification fixture.
  Prior failing source and correction remain recorded in the ledger.
- Windows abrupt broker death: ten captured stable Chrome process witnesses matched
  the private owned job and all reported exit with nonzero exit times. The original
  PID survivor list was empty; reaping was reported at 31 milliseconds over two polls.
  This covers that tree in one run, not every browser tree, repeated workload or
  startup-failure cleanup. The polling fix first failed two added measurement
  regressions; runtime Windows job cleanup source did not change.

## Integrated corrections and retained measurements

Four corrections have been integrated after old-source regression failures and
independent review: cleanup attempts every resource release and retains failures;
pause drains previously accepted advisor work; the macOS LaunchAgent retains the
installer Bun directory; and common CLI RPC replies drain stdout before exit.
Their fixtures establish the corrected contracts, not actual macOS login or every
browser failure mode.

[Actual host action measurements](host-action-acceptance.md) exercised seven
fresh-browser actions through installed Codex and Claude, plus API and CLI parity,
on one disposable Fedora fixture with deterministic local model endpoints and no
account access. All four paths passed on the recorded matching source. Codex
returned the authentic image in its native host-client event, but its mock-provider
request had no image nodes. Claude delivered its image to the model request.
Hermes failed before CLI startup because its dependency environment was unavailable;
its tool actions remain `not measured`. These are Limited measurements, not full
U7/T7 acceptance or measurements of the combined main checkout.

[Five matched browser pairs](browser-performance.md) measured idle extra RSS of
7.30 MiB, below the 100 MiB target. Paired mean-action median overhead was 80.99%,
**Failed** against the strict 20% target. Process-tree sampling and CPU accounting
limits remain beside the result. [Stage attribution](browser-performance-attribution.md)
identified actual Btrfs snapshots on all 50 reads in that instrumented fixture.
The isolated ioctl prototype is not a production optimization and has worse p95;
no production latency improvement is claimed.

The historical workflow above predates these changes. The verified main workflow
now covers their combined tree at the executed fixture scope. Participant,
external-device, published-artifact and native acceptance remain open.

## Requirement-to-evidence matrix

`Completed portion` identifies a bounded result, not completion of the full row.
`Code gap` identifies missing implementation or a source investigation, without
asserting an unknown root cause. `Human/device gap` requires real participation or
an appropriate external environment. `External blocker` forbids proceeding along
the rejected preparation path. The next evidence column describes requirements,
not authorization to operate the person's desktop or bypass a blocker.

| Requirement | Completed portion and evidence tier | Remaining status | Next evidence needed |
| --- | --- | --- | --- |
| U1 / T1: work without focus or host input interference | Historical browser telemetry and ten-minute scripted trial in [human-handoff.md](human-handoff.md); Limited for the full experience. | Human/device gap. Owner native claim also Failed by the 6 October crash; current corrected behavior not measured. | Participant confirms uninterrupted concurrent work; retain focus-event coverage and polling gaps without personal titles/keys. Native evidence must satisfy the separate hold below. |
| U2 / T2: two isolated sessions, 100 actions each | [experiment.md](experiment.md#two-broker-sessions-100-submissions-each) records 100 submissions per browser, independent storage and a post-stop submission. Limited to that scripted case. | Human/device gap for sustained simultaneous human work. | Repeat the acceptance workload with a participant and preserve independent form/storage results while both sessions run. |
| U3 / T3: opt-in viewer, under 1 second age at 5 FPS, work survives viewer close | [validation.md](validation.md): 2077 submissions, 5.006 FPS, maximum sampled displayed age 284 ms. Measured scripted viewer portion on the named host. | Human/device gap; participant cost reading and work after viewer close are not confirmed. | Participant reads the viewer's own `#cost` line and confirms continued work after closing it; no automatic opening and matched timing evidence remain required. |
| U4 / T4: pause, human takeover, resume and serialized input | [human-handoff.md](human-handoff.md) and `experiments/human-handoff.ts --auto-participant`: pause refusal, scripted control phrase, resume and 64 further submissions. Limited; `humanParticipationConfirmed` stayed false. | Human/device gap. Native borrowed input/resume are held. | Actual participant takeover/resume and conflicting input measurement; native cases only after the external blocker is resolved and the release requirements are met. |
| U5 / T5: stop one owned session within 5 seconds, preserve others/personal apps | Historical two-session post-stop check; latest installed stop smoke and bounded Windows owned-tree exit case above. Limited to those cases. | Human/device gap for the complete stop experience; startup-failure cleanup and arbitrary tree coverage not measured. | Measure the 5-second bound, surviving second session and personal app usability on matched external hosts. Investigate retained Windows startup failure separately. |
| U6 / T6: connected login survives restart, lease isolation, personal profile untouched | Historical Fedora account clone and lease checks in [accounts.md](accounts.md); named application pilots in [support-tiers.md](support-tiers.md) are Limited. Windows/macOS real-profile clone remains Refused at its documented scope. | Human/device gap for other accounts and real restart/service continuity. Platform restrictions remain explicit. | Evidence for each named allowed account/application, restart, competing lease and source-profile integrity; never infer token refresh or arbitrary account parity from a copied identity. |
| U7 / T7: CLI, MCP, API contract and two actual host integrations | Historical registrations plus [actual Codex/Claude actions and API/CLI parity](host-action-acceptance.md), Limited to the disposable fixture and recorded source. | Human/device gap: Codex model-image forwarding and Hermes actions not measured; real-provider, policy, installed-release and broader host behavior remain open. | Measure the missing contracts on the claimed installed release and external environments, retaining exact host-returned results and cleanup identity. |
| U8 / T8: unsupported desktop actions refuse without host fallback | Explicit platform refusals in [support-tiers.md](support-tiers.md); Limited pure native release refusal fixtures in [native-handoff-incident.md](native-handoff-incident.md). | Device evidence gap for complete adversarial denied-path telemetry across supported host classes. | Exercise denied operations and record zero host fallback/focus change. Pure fixtures only prove their refusal contract. |
| U9 / T9: private Fedora Wayland and X11 input/capture | Historical named Fedora private-display application experiments remain Limited in [support-tiers.md](support-tiers.md). Latest cross-platform CI skipped native installation. | External blocker and device evidence gap for post-incident native validation; corrected owner claim/input/cursor/cleanup not measured. | Separately reviewed disposable Fedora environment after blocker resolution, then pinned real compositor evidence described below. Historical private-display tests do not prove owner desktop safety. |
| U10 / T10: failure/restart, stale refusal, cleanup, fresh session | Historical browser crash and egress sweep evidence in [acceptance.md](acceptance.md); latest captured Windows owned-tree abrupt-death exit case is Limited. | Source investigation and device evidence gap: earlier Windows startup timeout and PID `7528` identity unresolved. SIGKILL itself cannot sweep filesystem state. | Confirm restart/successor cleanup, stale rejection and fresh session under each failure mode; preserve creation identity, ownership and exit timing rather than PID liveness alone. |
| U11 / T11: selected files only, simultaneous edits obey lease/worktree policy | Historical cooperative reservations in [files.md](files.md); selected host-file and application save pilots remain Limited in [support-tiers.md](support-tiers.md). | Human/device gap for cross-application edit conflicts, save semantics and arbitrary file access. | Selected fixture changes, untouched sibling/source data and lease/worktree conflict outcome on each claimed application. A successful file read is not write/atomic-save evidence. |
| U12 / T12: repeat T1-T11 on actual macOS/Windows hosts | Disposable installed-browser CI plus named Windows guest and macOS runner measurements, Limited. | Human/device gap; native/profile restrictions remain Refused as documented. | Repeat applicable T1-T11 on real external desktop/account/device classes; report unsupported operations explicitly, including Keychain/TCC limits, never as skipped passes. |
| Performance: five matched direct-Playwright comparisons, idle overhead under 100 MiB, action overhead under 20% | [Five matched pairs](browser-performance.md): idle extra 7.30 MiB passes; paired mean-action median extra 80.99% fails. Limited with process accounting and sampling limits. | Performance target Failed; sustained workloads, other devices and throttling remain not measured. | Reduce production overhead without weakening restore guarantees, then rerun matched source-bound pairs and retain p95. The [snapshot prototype](browser-performance-attribution.md) is not a production improvement. |
| Failure matrix: timeout, invalid/duplicate action, busy profile, backend/capture/preview failure, shutdown during input | Named suites and historical recovery checks retained in [validation.md](validation.md); latest suite counts establish only executed test scope. | Device/workload evidence gap for the complete matrix on current claimed environments; unexplained failures remain open. | Link each requested failure case to exact source, observed outcome and executed environment. A new regression must first fail on unfixed behavior before claiming defect detection. |
| Fresh portable installation and real service/update lifecycle | Latest checkout-built archive smoke Limited; earlier service/path/package old/new fixtures in the [ledger](portability-verification.md#requirement-ledger) Limited. | Device evidence gap for published package and foreign systemd paths; Code gap: Windows/macOS managed activation and scheduling are explicitly unsupported. | Published-release acceptance on fresh external hosts; disposable systemd broker/updater startup, configuration precedence, drift, restart, rollback and cleanup. CI installer `service: done` alone is installation state. See [updates.md](updates.md). |
| Native root cause and ABI safety | Core trace establishes failing `dataDeviceForClient` lookup; old synthetic inventory fixture failed and correction passed, Limited. | Code investigation plus external blocker; origin of invalid device entry and real ABI/lifetime safety not measured. | Rule out ABI/lifetime defects with the pinned real-compositor regression below. Do not label the synthetic guard a proven real claim fix. |

## Native release hold and external blocker

The [native incident contract](native-handoff-incident.md) records the owner's
compositor crash during Chrome claim at 3:40 AM, Asia/Dubai, on 6 October. Opening
the requested account on workspace 4 had succeeded; the pointer demonstration
did not run. Corrected owner claim and visible cursor remain `not measured`.

Owner handoff, borrowed input, borrowed resume, owner plugin load and admission
resume remain disabled before host access. Status, pause, handback and unload remain
available for recovery. **There is no runtime override for this release hold.**
Reconsidering it requires all of the following evidence, without using the person's
desktop as the test surface:

1. A pinned Fedora compositor/plugin regression on a separate disposable display:
   broken source fails for the actual defect and corrected source passes.
2. Absent clipboard protocols, incomplete/invalid device inventory and a real Chrome
   client exercised; ABI and lifetime defects ruled out rather than assumed fixed.
3. A complete real claim/input/handback cycle with visible cursor, selection
   isolation, owner focus preservation and cleanup measured.
4. Source-bound logs/artifacts and independent review of the actual evidence.
   Synthetic null-entry and pure release-refusal tests remain supporting evidence only.

The [portability ledger](portability-verification.md#unfinished-acceptance-gates)
records the native preparation rejection: `This content was flagged for possible
cybersecurity risk`. It provides no specific tool/operation identity. The uncommitted
Docker/probe prototypes were not executed, and no Fedora workflow was written.
This is an **external blocker**, not a passing gate. Do not execute, revise, continue
or delegate that rejected preparation or its prototypes through an alternate path.
A separately reviewed disposable environment is a future prerequisite only after
the external blocking condition is resolved. This page does not authorize a bypass.

## Preserved failures and unknowns

The successful latest run does not erase these earlier outcomes:

- September Linux installer-contract failure, Windows cold first-capture timeout
  and local managed broker SIGABRT after 4 hours 46 minutes retain no identified
  cause, as recorded in [release-readiness.md](release-readiness.md#managed-broker-abort-20-september-2026)
  and the [historical roadmap](roadmap.md#what-remains-20-september-2026).
- The participant stopped the original CPU-cost trial around 123 seconds. Fixes
  and automated viewer cost readings do not replace participant acceptance; the
  support table retains that Failed row.
- The October owner compositor crash is confirmed; the origin of the invalid device
  entry remains unknown. Historical headless handoff success is separate evidence.
- Windows installed-browser startup readiness failed earlier with unknown root
  cause. Later graceful stop or crash-test success does not explain it. See the
  [startup failure snapshot](portability-verification.md#official-source-review-correction-and-preserved-windows-startup-failure).
- At `5c1193d`, abrupt broker death returned survivor PID `7528` without creation
  identity/job evidence; live owned survivor versus PID reuse remains unknown.
- At `dcf8279`, stable witnesses were sampled approximately 67 milliseconds apart
  and classified alive while the PID list was empty. Eventual survivors were not
  measured there. The later polling correction preserved both strict assertions;
  its success is a new bounded measurement, not a retrospective survivor verdict.
- Earlier Windows POSIX-path fixture, portability-driver assertion mismatch and
  Ubuntu EACCES listener failures retain their failing runs and later corrected
  evidence in the [ledger](portability-verification.md).

All limitations remain visible when a capability is claimed. No row closes because
Orbit was installed, a newer version was declared, an unchanged-source rerun was
green, or a failed test was skipped.
