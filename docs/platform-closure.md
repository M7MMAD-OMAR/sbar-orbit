# Platform closure contract

Owner request: October 6, 2026. Consolidate relevant branches into official `main`,
fix outstanding problems, publish verified work and continue the remaining work in
separate coordinated tasks. The full objective includes usable interfaces,
maintainable architecture and the existing acceptance requirements. A green
fixture does not close the complete platform.

The coordinator owns integration, serial use of the shared test budget, review,
official branch publication and reconciliation of evidence. Implementers work in
isolated checkouts. Independent reviewers inspect current source and evidence.
Separate tasks must return scoped commits and source-bound test results; they must
not push official `main`, change support claims or bypass the native release hold.

## Current execution

[PR 4](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/4) is merged and official
`main` is published at `56fd8f318c5ec2aaded827a8be89387bf54579f1`. Its complete
tree `68f03eff2e89fe7b5ff19eb691453f6d4de4b2ff` matches tested `333b92e`.
[Normal CI run 37474272086](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37474272086)
passed all nine jobs. The [completion evidence](completion-status.md#verified-official-main-integration)
records exact platform counts and the local combined-runtime result.
This closes the verified publication portion only. Core checkpoint review remains
incomplete while the original startup cause and required acceptance gaps remain.

Five separate owned workstreams are actively investigating in isolated checkouts:

| Workstream | Current investigation | Integration requirement |
| --- | --- | --- |
| Reliability and startup | Original saved-profile timeout, pre-CDP startup delay and recovery | Discriminating old-source failure, explained cause and reviewed repair |
| Product architecture and UX | Product hierarchy, usable interfaces and English/Arabic onboarding | Rendered interaction, RTL, keyboard and state evidence |
| Performance and restore | Failed 80.99 percent latency overhead against 20 percent target | Production repair with restore parity and matched comparisons |
| Portability and managed lifecycle | Published installation, service/update scheduling and rollback | Source-bound actual managed mechanism and published artifact acceptance |
| Actual hosts and acceptance | Missing host actions, image forwarding and external U1/T1 through U12/T12 | Authentic host/device evidence and explicit unmeasured limits |

Workstream code remains isolated. Implementers do not push official `main`.
The coordinator grants the shared resource budget serially and owns each reviewed
integration and publication. The full goal remains active; no stage is closed by
creating a task or obtaining a green fixture.

The existing GitHub `v0.2.0` release targets `af37cc4`, before these main fixes.
Registry `latest` is `not measured`; package version alone does not establish
published artifact parity. Release closure still requires matching artifacts and
all required evidence.

## Dependency order and completion evidence

| Stage | Required outcome | Evidence required | Current state |
| --- | --- | --- | --- |
| Consolidation | Every branch/worktree classified; useful unique patches integrated; current core failures resolved; official branch updated | Git ancestry and patch IDs, preserved private work, discriminating regressions, local suite, independent review and matching three-platform CI | In progress |
| Product | Clear architecture and product hierarchy; usable viewer and public onboarding in English and Arabic | Actual rendered flows at desktop and mobile sizes, RTL and keyboard interaction, error/busy/paused states, current design contract and independent review | Pending |
| Performance | Production idle overhead below 100 MiB and action overhead below 20 percent | Five matched direct-Playwright pairs on the same source, median and p95, owned process-tree resource accounting, restore parity | Failed target, repair pending |
| Portability and hosts | Published installation, real managed lifecycle, rollback and host parity on each claimed environment | Exact published artifact/version, fresh disposable external hosts, real owned service/task mechanisms, two actual agent integrations, explicit unsupported operations | Partial evidence, remaining work open |
| Acceptance | U1/T1 through U12/T12 plus failure gates and native release requirements | Actual participants and appropriate devices, source-bound telemetry/results, no personal desktop test surface, independent review | Open; native preparation externally blocked |
| Release | Official `main`, release claims and documents agree with all proved outcomes | Matching final CI, requirement-by-requirement audit, artifact and tag/registry identity when published, no stale evidence or unresolved required gates | Pending |

The source of the detailed product requirements remains [acceptance.md](acceptance.md).
The requirement-to-evidence matrix is [completion-status.md](completion-status.md).
The historical gate ledger remains [roadmap.md](roadmap.md). Those contracts are
not replaced by this execution order.

## Branch reconciliation

The initial inventory inspected every advertised remote branch and all 13
registered worktrees at that point. It found no tracked uncommitted work.
Private untracked artifacts and dependency directories were preserved in place.

- `agents/orbit-completion-2026-10-06` contains nine commits newer than the initial
  remote `main` at `0faa05c`. [PR 4](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/4)
  merged into official `main` at `56fd8f3`, including the reviewed follow-up repairs.
- Native application opening has four patch-equivalent commits already integrated.
  Zen ambiguity has one equivalent patch already integrated. Reapplying them is
  unnecessary and does not establish native owner acceptance.
- The three Hermes branches were included through combined integration `532e7b1`
  and subsequent fixes. Original real-machine assets are preserved; later source
  must not be replaced with the old patches.
- Upload commit `46a92d8` was unique and has been integrated as `30b4055`. The
  in-memory transfer fixes the confined browser's inability to read host paths.
  Descriptor-bound bounded-read hardening and fresh integrated validation are now
  included in the published main tree; broader acceptance remains open.
- Windows diagnostic commits `1de01ed` and `51cb766` are retained through the
  integrated repair and probe. The focused fixed-source result below is separate
  from full combined-source CI.
- Profile diagnostic `a38aaed` is evidence gathering, not a proved runtime repair.
  It is now included as an opt-in workflow recording the tested production tree
  identity instead of requiring equality with an obsolete source. The diagnostic
  compares isolated and full-suite `--smol` runs while retaining the original
  30-second saved-profile deadline. Test phase output is opt-in.

No branch or worktree is deleted merely because its patches are integrated.
Unique private research prototypes are not silently published or executed.

## Current defect evidence

[Combined integration run 37428123732](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37428123732)
at `0fe18e3` failed one Ubuntu saved-profile timeout and one Windows owned-browser
crash measurement. macOS and the six installed-browser/registered-host jobs passed.
These failures remain preserved.

The Windows retained-handle regression
[failed before correction](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37430571799).
The Win32-format process image query failed after confirmed process exit; native
path format retained the same process identity. The correction preserves error
handling, creation identity, job membership, exit-time assertions and deadlines.
[Focused fixed-source run 37471980141](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37471980141)
passed the retained identity regression and original browser crash gate: all ten
owned browser witnesses exited, the survivor list was empty, and reaping was
reported at 32 milliseconds over two polls. This is a bounded Windows measurement,
not complete platform acceptance.

The Ubuntu timeout root cause is not established. A successful isolated or normal
full-suite run does not explain the earlier failure. A diagnostic recorded 29.123
seconds before CDP connection, identifying a delay boundary rather than its cause.
Boundary traces and the exact `--smol` execution mode remain under investigation
without increasing the original test deadline. Core checkpoint review is incomplete.

The confined upload readback regression was run again against the unfixed browser
source during consolidation. Ordinary upload and default refusal passed, while
the confined page received no readable content and failed its exact-content
assertion. With byte transfer and bounded reads, the local focused run passed
14 tests with one Windows-only skip, including actual confined input/chooser
delivery and growth after a real descriptor read. That result is separate from
the now-successful full combined-source suite and platform CI. Neither result
closes broader external upload or product acceptance.

## Native and external acceptance limits

The unconditional [native release hold](native-handoff-incident.md) stays active.
Owner handoff, borrowed input/resume and owner plugin load must not be enabled to
make a test pass. The rejected native preparation and private prototypes must not
be executed, revised or delegated through an alternate route. A separately
reviewed disposable environment is only a future prerequisite after that external
blocking condition is resolved.

Participant confirmation, published-package acceptance, real macOS/Windows
desktop/account behavior and unmeasured host image forwarding remain open. Tasks
may prepare reviewable source, fixtures and evidence contracts without claiming
those external results. Missing or skipped required evidence remains `not measured`.
