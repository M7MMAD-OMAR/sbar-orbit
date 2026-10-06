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

[PR 6](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/6) is merged and official
`main` includes merge `886e319855ca65da741cf028cc5391e13e899ce8`.
[Normal CI run 37497113691](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37497113691)
passed all nine jobs on that exact merge. Its three host evidence files extend
provenance validation without changing the production runtime. The
[completion evidence](completion-status.md#verified-official-main-integration)
separately retains the earlier PR 4 platform counts and local combined-runtime result.
This closes the verified publication portion only. Core checkpoint review remains
incomplete while the original startup cause and required acceptance gaps remain.
The later documentation snapshot `449e4de` also passed all nine jobs in
[run 37508929441](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37508929441).
Draft candidates below remain outside that verified main source.
Earlier main `61ea92c` failed the Windows owned-process witness acquisition
in [run 37507008661](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37507008661),
with the other eight jobs passing. Error 87 is failed measurement, not proved
cleanup; resolving the census/acquisition failure remains required for consolidation.
The later green run does not establish its cause.
Newer main documentation snapshot `d27debe` completed
[run 37510883436](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37510883436)
with seven jobs passing and Ubuntu and Windows suite failures. macOS passed.
Ubuntu hit the saved-account fixture's 30-second deadline. Windows recorded ten
exited Chrome witnesses plus an alive `PING.EXE` witness with a creation time
older than its alleged parent and root, an inconsistent process attribution.
That historical workflow was not fully green; both unexplained failures require
resolution before final integration acceptance.
An earlier all-nine passing snapshot is `be8be0f` in
[run 37513298533](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37513298533).
Current published main `728bbd3` also passed all nine normal jobs in
[run 37517456996](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37517456996).
These later passing results do not explain either earlier failure or close the
remaining acceptance gates. Draft PR 7 now carries the same-runner Mac capture
diagnostic, and draft [PR 8](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/8)
prepares a Windows acquisition-order counterexample. Neither is a production
cause or repair claim; actual retained platform evidence and review are required.

Newer official-main snapshot `4089c50` failed the Mac suite in
[run 37528913748](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37528913748),
with the other eight jobs passing. Its profile-and-restore removal fixture
reported `Invalid InterceptionId` in Playwright's CDP dispatcher. The actual
fixture phase and cause are unknown; the test name does not establish a failed
stop or an owned-process survivor. Draft PR 5 at `efab0ea` subsequently passed
all nine jobs in
[run 37530252584](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37530252584)
on merge `bbd332c8`, with all 71 scoped files matching the tested candidate.
That separate passing result does not explain the official-main assertion or
close the pending independent reviews and full acceptance requirements.

Official main snapshot `1a9c1e3` subsequently completed
[run 37531549547](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37531549547)
with all nine normal jobs passing. Ubuntu reported 714 pass and 95 skip; Windows
492 pass and 317 skip; Mac 504 pass and 305 skip, all with zero failures. This
result belongs to the exact official documentation snapshot. It does not explain
the retained `4089c50` CDP failure or close its cause and cleanup evidence gaps.

Two further diagnostic preparations have local source-bound gates only. The
unpublished debug-provider R5 source passed TypeScript and 12 pure portable
controls with 399 influential files unchanged. The installed-startup R25 source
passed TypeScript and 25 pure protocol/filesystem controls with 286 files
unchanged. Their exact hashes, local packets and raw logs are recorded in the
[workstream snapshot](completion-status.md#remaining-workstream-snapshot).
The debug preparation still requires actual Windows Bun feasibility, nested-job
compatibility and full unchanged Chrome coverage/performance. The installed
preparation still requires actual Windows startup/lifecycle/cleanup evidence;
its new readiness and Bun controls have no discriminating old-source run.
Both preparations require two fresh independent review axes. Neither is a
production collector repair, startup cause, platform acceptance or release claim.
The unconditional native hold and full external acceptance requirements remain.

Five separate owned workstreams are actively investigating in isolated checkouts:

| Workstream | Current investigation | Integration requirement |
| --- | --- | --- |
| Reliability and startup | Original saved-profile timeout, pre-CDP startup delay and recovery | Discriminating old-source failure, explained cause and reviewed repair |
| Product architecture and UX | Product hierarchy, usable interfaces and English/Arabic onboarding | Rendered interaction, RTL, keyboard and state evidence |
| Performance and restore | Latest owned-browser baseline fails at 42.942314 percent latency overhead against 20 percent target | Production repair with restore parity and matched comparisons |
| Portability and managed lifecycle | Published installation, service/update scheduling and rollback | Source-bound actual managed mechanism and published artifact acceptance |
| Actual hosts and acceptance | Missing host actions, image forwarding and external U1/T1 through U12/T12 | Authentic host/device evidence and explicit unmeasured limits |

Workstream code remains isolated. Implementers do not push official `main`.
The coordinator grants the shared resource budget serially and owns each reviewed
integration and publication. The full goal remains active; no stage is closed by
creating a task or obtaining a green fixture.

The existing GitHub `v0.2.0` release targets `af37cc4`, before these main fixes.
Fresh [passive registry inspection](published-artifact-identity.json) found
`latest` serving `0.1.1`, with matching archive integrity and production bytes
that differ from current main. Installed behavior remains `not measured`;
package version alone does not establish published artifact parity. Release
closure still requires matching artifacts and all required evidence.

The [remaining workstream snapshot](completion-status.md#remaining-workstream-snapshot)
records the newer isolated measurements and failed draft PR checks. These results
do not extend the verified main runtime or close pending acceptance requirements.

## Dependency order and completion evidence

| Stage | Required outcome | Evidence required | Current state |
| --- | --- | --- | --- |
| Consolidation | Every branch/worktree classified; useful unique patches integrated; current core failures resolved; official branch updated | Git ancestry and patch IDs, preserved private work, discriminating regressions, local suite, independent review and matching three-platform CI | In progress |
| Product | Clear architecture and product hierarchy; usable viewer and public onboarding in English and Arabic | Actual rendered flows at desktop and mobile sizes, RTL and keyboard interaction, error/busy/paused states, current design contract and independent review | Draft PR 5 at efab0ea; eleven local gates and all nine current merge CI jobs pass; earlier post-release Mac delay and official-main CDP failure remain unexplained; independent review unproven |
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

The later remote inventory also inspected `agents/profile-timeout-repair` and
`agents/windows-identity-fix-2026-10-06`. The profile branch has two additional
diagnostic commits, `6a6e56b` and `cf73128`, for Chrome readiness and shared-slice
counters; they are not proved startup repairs. Read-only reconciliation found
their useful phases and fields already covered by the isolated privacy-safe
diagnostic workstream, which replaces raw stderr with fixed categories and
selects the actual shared slice. Do not import the old raw stderr tracing.
This comparison does not prove a startup cause or accept the isolated repair.
Its other two patches are
already equivalent to main. Both Windows branch patches are equivalent to
integrated corrections, so reapplying them is unnecessary. The host provenance
branch is now merged through PR 6; the product branch remains draft PR 5.
The privacy-safe diagnostic candidate is published separately as
[draft PR 7](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/7) at `d71850c`.
Normal CI on preceding source `440f7cc` passed eight jobs and failed a Windows
parser assertion. The current POSIX path correction passed the existing focused
local tests. Corrected Windows and Ubuntu suites passed; macOS failed two
observation checks. Their missing payload/phase evidence remains under investigation.
The preceding three-job
diagnostic run passed, but no failing startup was reproduced and browser binaries
differed between isolated and full-suite measurements. Required independent reviews
remain unproven. The [current snapshot](completion-status.md#remaining-workstream-snapshot)
records the exact runs and limitations; neither draft closes the startup investigation.

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
