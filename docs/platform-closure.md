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

Latest verified runtime integration on official main is `25412fd184e3a86721c563786e0a5a0e5f88c3c5`, after
[PR 13](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/13) merged bounded diagnostic
framing. Its tree `d4fcf260a6d23558ea51a3d170726ec31412760c` exactly matches the
PR merge checkout `48617228b16b632e85a85e238026bfa2f25061b6`, tested in
[run 37594463052](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37594463052)
at head `9aab17f6fe32951ea2f21bed4021365f7a6ebd72`. All nine PR jobs succeeded.
Each suite ran 916 tests across 179 files:

| Runner | Pass | Skip | Fail | Assertions |
| --- | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 | 821 | 95 | 0 | 5059 |
| macOS | 611 | 305 | 0 | 3899 |
| Windows | 599 | 317 | 0 | 3870 |

The separate [main run 37597801469](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37597801469)
now completed all nine jobs successfully on actual push checkout `25412fd`, with
the same 916-test, 179-file counts and assertions above. Its independently retained
main packet contains nine complete raw logs, nine ZIPs and 32 CRC-checked members;
all API ZIP digests and run/head identities are verified. The 977-file canonical
source matches actual official main tree `d4fcf260`. The main freeze manifest SHA256
is `24919636b7570936116426322d85f80e91a958cd08d037e4c6a4efb81cf59636`.
This is separate actual-main evidence, rather than inferred PR-source acceptance.
The earlier [main `7979632` run 37584808021](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37584808021)
failed a Windows pipe operation with error 143; eight of nine jobs succeeded.
The underlying cause and full cleanup remain unknown. Successful framing evidence
does not explain or fix that historical failure. The successful `0798bbd` run and
its source-bound limits remain preserved in the historical snapshot below.

The PR packet retains nine complete raw job logs, nine actual ZIPs and 32
CRC-checked members. Its canonical 977-file source tree matches both PR head and
tested merge. The freeze manifest SHA256 is
`11932662e0925622383e064d7152e450aa1dd37c4eca257ae2eff56d0ea6d332`.
Strict reconstruction on each platform recovered 65 logical messages, final
ordinal 65 and 161 physical frames, with six current producer rows and original
child exit zero. The coordinator and two fresh independent provider reviewers
verified the frozen packet. Nine local gates and two local reviews passed; the
retained local full suite reported 868 pass, 49 skip and zero failures. The framing
checkpoint was accepted at revision 73 after the two fresh provider reports.
These are bounded diagnostic-output results, not full-platform acceptance.

The actual main traces independently reconstruct 65 logical messages each, final
ordinal 65 and 161 physical frames, with six current producer rows per platform,
original child exit zero and no observer, sink or refusal errors. The main packet
uses its own logs, ZIPs and raw Git blobs, without borrowing PR trace bytes.
Hash-pinned Playwright/package bytes match across all 195 producer rows. Validated
provider metadata is not capture of the provider executable binary.

The original fixture-stop remains pending. Actual main observer drops are 57 on
Ubuntu, 75 on Mac and 77 on Windows. The preceding PR packet separately retained
73, 75 and 67 drops respectively. Browser identity is matched to existing CDP
responses only. Loaded executable identity and full cleanup remain `not measured`.
Frame fsync/close return is retained, without a power-loss persistence guarantee.
The previous `ab0061b` Mac log framing failure remains in historical evidence;
its failed bytes were not repaired into a passing trace.

The isolated current product candidate at source
`0890533218fa771c282ad88e0aa4aaea1fd71ff213e704c1d449d74a4f160875`,
plan `1b39ef63890d455e63c5aed9af45f25179bb9c1fe29b0b1c75319c8748291b60`,
passed eight local gates, including 55 focused tests and 708 assertions. Its later
full suite failed: 860 pass, 49 skip and 13 failures across 922 tests in 184 files.
The retained diagnosis identifies shared-module mock leakage. An isolated-child
repair packet is prepared but unexecuted, so no repaired result is established.
Literal P7 evidence for fresh current-product cross-platform CI remains absent.
The product candidate is not merged or accepted from focused checks alone.

Startup, Windows census, managed lifecycle, production performance, release and
registry parity, external U1/T1 through U12/T12 acceptance and the unconditional
native hold remain open. The full closure objective remains active. Historical
entries below describe their own source snapshots and do not supersede this
current execution state.

### Historical integration snapshot before PR 13

Historical verified integration base: 7 October 2026, official main `0798bbd`.
[PR 11](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11) is merged. The installed
Windows retention repair passed its source-bound local checks and two independent
reviews. Its PR workflow passed all nine jobs. The subsequent
[main workflow 37549089608](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37549089608)
also passed all nine jobs. These results establish their stated test scope, not
whole-platform acceptance. Skipped tests remain not measured.

The installed Windows evidence retains a sealed record window with verified
trace/status hashes and a seal-write acknowledgement. It does not establish
membership after handle closure, mapped executable image identity, acknowledgement
persistence, general startup reliability or the causes of historical failures.
[PR 10](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/10) is marked merged through
its inherited commit in PR 11, not as separate acceptance of its original candidate.
The earlier observer integration in PR 9 remains historical source-bound evidence;
pending fixture-stop and dropped records do not prove whole-platform cleanup.

[Capture diagnostics PR 12](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/12)
is merged into official main `0798bbd`. Head `6e8d92c` passed all nine jobs in
[run 37583092385](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37583092385).
The normal merge tree exactly matches the tested PR merge tree. Its separate
[main run 37583855212](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37583855212)
also passed all nine jobs. Each suite ran 882 tests across 179 files. Main reported
Ubuntu 787 pass and 95 skip, Windows 565 pass and 317 skip, and Mac 577 pass and
305 skip, each with zero failures. Skips remain not measured. Nine complete logs,
six actual ZIPs and 20 extracted members are retained for each workflow.

Each platform's isolated factory child passed the same 32 cases through ordinary
and owned temporary ancestor alias routes, with zero failures or skips and
185 assertions per route. These are 64 observations over 32 distinct cases;
they are not additional full-suite tests. The local repaired source passed all
nine planned gates and two fresh independent reviews, accepted at checkpoint
revision 126. Only the controlled fixture root was canonicalized; production
admission guards remain strict. Existing registration is revoked synchronously
at both close boundaries, while previously admitted operations retain observable
late settlement and original promise/error behavior.

The previous head `270a960` failed the Mac isolated wrapper in
[run 37581024647](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37581024647),
with 17 passes and 15 failures in its nested child. The owned alias counterexample
reproduced those 15 names against unchanged source; the real provider temporary
path was not captured, so historical cause remains unproven. Original lifetime
and helper counterexamples remain failures in retained evidence. The passing
repair does not prove general startup reliability, loaded executable identity,
Windows ACLs, full cleanup or native readiness. Successful child raw digests are
producer receipts; separate complete child bytes are not published for independent
hash recomputation. Selected capture JSON is complete on each platform, while the
older Linux protocol final in the main workflow is truncated and remains not
measured. Windows and Mac older finals retain pending fixture-stop and dropped
records, which are separate from the selected capture controls.

[Bounded diagnostic framing PR 13](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/13)
is also a draft outside main. Head `ab0061b` passed five local gates and two
independent reviews. Its
[run 37582132182](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37582132182)
passed all nine jobs, but strict reconstruction of the actual Mac log failed on
malformed frame JSON, including interleaved test output. The resource artifact
contains no independent trace channel. Windows reconstruction retained 65 logical
messages and a 64620-byte final message. Provider capture completeness remains
unproven on Mac; passing jobs do not close this diagnostic requirement. The failed
raw bytes are retained without suffix repair. Integration remains pending.

Product PR 5, startup PR 7 and Windows census PR 8 remain drafts. The product
candidate reconciled with `1114c2f` passed local typecheck, website build, 55 focused
tests without failures or skips, and the stopping observer fixture. These are
historical results for that candidate. A new isolated candidate starts from
`0798bbd` to combine document-consistent capture and metadata with the accepted
phase/lifetime recorder. The original staged work remains preserved. Combined
source, faithful settings fixture wording, missing state screenshots, fresh
independent reviews and exact integrated-head provider evidence remain pending.
The final integrated product candidate has not been published.

Performance, managed lifecycle, release and registry parity, external U1/T1 through
U12/T12 acceptance and the unconditional native hold remain open. Detailed entries
below describe named historical source snapshots and do not supersede this snapshot.


### Historical publication sequence

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
The historical published main `728bbd3` also passed all nine normal jobs in
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

The subsequent official-main snapshot `60dc625` completed
[run 37535432220](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37535432220)
with eight jobs passing and the Windows installed-browser job failing. All three
suites passed: Ubuntu 714 pass and 95 skip, Windows 492 pass and 317 skip, Mac
504 pass and 305 skip, each with zero failures across 809 tests in 176 files.
Only these two status documents changed from `1a9c1e3`; all 965 other Git-tree
mode/type/blob rows match. The installed `session create` command failed after
15753 milliseconds with the unchanged 15-second endpoint timeout. Its verified
2811-byte artifact contains installer state, empty installer stderr and two
command timings; no diagnostic JSON, screenshot, smoke report, process identity
or cleanup receipt exists in that archive. Installation and task state do not
establish a Chrome survivor, exit or cleanup outcome. The startup cause and
cleanup remain `not measured`. The local
[terminal packet](/var/tmp/orbit-consolidation-2026-10-06/main-60dc-ci-37535432220-terminal-retained/evidence-packet.json)
and [installed artifact packet](/var/tmp/orbit-consolidation-2026-10-06/main-60dc-installed-artifact-11445627442/evidence-packet.json)
retain complete suite logs, artifact identities and exact source comparison.
The earlier `1a9c1e3` all-nine green result and `4089c50` Mac CDP failure remain
historical evidence; none establishes the causes of these distinct failures.

The later official-main snapshot `83fc3f8` completed
[run 37538046122](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37538046122)
with eight successful jobs and a Windows suite failure: 490 pass, 317 skip and
two fail across 809 tests in 176 files. The test failed the popup-following
`observe` with a pixel-capture TIMEOUT at the unchanged 3000-millisecond deadline,
before `window.close` was called. The delayed-pipe observation test received child exit 143 instead of
zero under its 8000-millisecond child budget; the child's active phase and cause
remain unknown. Ubuntu and Mac suites passed, with 714/95 and 504/305 pass/skip
respectively and no failures. The installed Windows job separately passed eight
checks: create 6230 milliseconds, observe 542 and stop 513. That Limited installed
flow does not prove generation-aware cleanup or resolve the earlier endpoint
timeout. Only these two documents changed from `60dc625`; all 965 other Git-tree
mode/type/blob rows match. The
[full terminal packet](/var/tmp/orbit-consolidation-2026-10-06/main-83fc-ci-37538046122-retained/evidence-packet.json)
and [installed Windows packet](/var/tmp/orbit-consolidation-2026-10-06/main-83fc-ci-37538046122-retained/installed-windows-artifact-11448090150/evidence-packet.json)
retain raw logs, actual artifact bytes and source bindings. The earlier all-nine
green `1a9c1e3` and failed `4089c50` and `60dc625` results remain separate
historical evidence; this documentation update is no runtime repair.

Two further diagnostic preparations have local source-bound gates only. The
unpublished debug-provider R5 source passed TypeScript and 12 pure portable
controls with 399 influential files unchanged. The installed-startup R25 source
passed TypeScript and 25 pure protocol/filesystem controls with 286 files
unchanged. Their exact hashes, local packets and raw logs are recorded in the
[workstream snapshot](completion-status.md#remaining-workstream-snapshot).
The debug preparation still requires actual Windows Bun feasibility, nested-job
compatibility and full unchanged Chrome coverage/performance. The installed
preparation still requires actual Windows startup/lifecycle/cleanup evidence;
matched R13 helper controls recorded four intended failures versus four passes,
and R15 recorded two intended failures versus two passes on identical test bytes.
These helper counterfactuals preserve the original R25 source and establish pure
protocol discrimination only. R19 also recorded two intended failures versus two
passes using identical test bytes, limited to typed producer metadata retention.
Actual Bun selection/reference and the new identity gate/hash APIs are not proved
by that historical comparison; original R25 positive controls remain unchanged.
A separate unpublished Mac interception preparation passed TypeScript and 17 pure
observer controls; five intentional mutants each failed its selected assertion.
All 403 influential files remained restored or unchanged at source `cd755832`
and plan `220ee9ba`. A later Linux instrumentation fixture passed one selected test
and retained private connection admission and the existing browser-version reply.
Its final sequence 293 dropped 37 records; session-stop and broker-close settled,
but the original non-awaited fixture-stop promise remained pending at its `before`
boundary. This is bounded partial Linux chronology, not HTTP server or broader
process cleanup. At that local stage no actual Mac fixture ran and the historical
CDP cause remained
unproven. The [workstream snapshot](completion-status.md#remaining-workstream-snapshot)
links the exact local receipts and raw output.
All these preparations require two fresh independent review axes. None is a
production collector repair, startup cause, platform acceptance or release claim.
The unconditional native hold and full external acceptance requirements remain.

Fresh independent review contexts have since been restored. Draft
[PR 9](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9), exact candidate
`e7be8fe07f8737748a9a42318c0f012063294bc3`, passed all nine jobs in
[run 37538255624](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37538255624)
on merge checkout `63528067a3eef5a84f93766ad3092e78c174f234`. Its actual Mac
diagnostic dropped 69 records and left the original non-awaited fixture-stop
pending. Three target crash notices occurred during session-stop; they do not
establish a browser-process crash or the historical CDP cause. Fresh specification
and standards reviews both returned **FAIL**, each with a major finding: missing
session-correlation defect discrimination and consumption of the original
unhandled fixture-stop rejection. The
[publication sidecar](/var/tmp/orbit-consolidation-2026-10-06/mac-interception-pr9-publication-sidecar.json)
links the actual platform packet, review reports and retained rejection contrast.

Draft [PR 10](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/10), exact candidate
`0861b81fae6b0f0d6b6350a331cc52fbb26f57d7`, also passed all nine jobs in
[run 37538794497](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37538794497)
on merge checkout `57db3c4992f324fb05ada0631dab78fbf22eec6c`. Actual installed
Windows collection retained 102 records and reported endpoint readiness at
10058 milliseconds. Its reported measured state is not accepted evidence:
the fresh specification review returned **FAIL** for final-report write failure
remaining measured and production membership being shortened before invalidation.
The standards review is **INVALID** because a late sibling-summary exposure broke
context separation. Its two independently identified pre-exposure findings,
membership truncation and stale durable status after write failure, remain
actionable; they do not constitute a valid independent pass. The
[publication sidecar](/var/tmp/orbit-consolidation-2026-10-06/windows-installed-pr10-publication-sidecar.json)
links the [actual Windows packet](/var/tmp/orbit-pr10-installed-windows-0861b81-2026-10-07/packet.json)
and retained review reports. Neither PR is accepted or merged.

The unpublished Mac review repair reached local revision 33 at source
`312f67e6a4efbaf02666a4f131161e8ce486fb5236971e55c441c16f314a5d19`
and plan `61e92c6cdd0550e7b7be124f03532a1b63122f5dc7ff80bfc8dcc8e39304e030`.
TypeScript passed; 20 pure observer controls passed with 87 assertions, and
seven defective variants each produced one intended failure, passing the negative
gate. The original stopping fixture passed one Linux test with five assertions.
The bounded trace retained 65 emissions, final sequence 293 and 37 drops; the
original fixture-stop remained pending, so full chronology is not established. Its
[frozen review-input packet](/var/tmp/orbit-main-4089-macos-interception-2026-10-07/implementation/fresh-review-33-immutable/packet-index.json)
binds all 403 influential files and the actual raw receipts. The fresh repaired-source
[specification review](/var/tmp/orbit-main-4089-macos-interception-2026-10-07/mac-repair33-fresh-specification/report.json)
returned **FAIL** with one major I5 finding: a trace ending before an admitted
`Browser.getVersion` reply omits browser identity instead of explicitly recording
`not measured`. The [coverage report](/var/tmp/orbit-main-4089-macos-interception-2026-10-07/mac-repair33-fresh-specification/coverage.md)
retains the satisfied requirements and measurement limits. The fresh
[standards review](/var/tmp/orbit-main-4089-macos-interception-2026-10-07/mac-repair33-fresh-standards/report.json)
returned **PASS** without findings, but overall review remains **FAIL**. Subsequent
[old-source pure controls](/var/tmp/orbit-main-4089-macos-interception-2026-10-07/root-browser-unknown-old33/receipt.json)
produced zero passes and two intended failures with five assertions: final browser
version was absent both without a reply and after an early failure. Original error
identity was preserved and all 403 source bytes remained unchanged. This is pure
unknown-state discrimination, not a Mac runtime or historical CDP reproduction.
A narrow I5 repair is authorized for preparation only; no repaired-source checks
or actual platform result are established by that authorization.

The separate Windows old-source retention harness ran once in its own engine run,
revision 4, while original source `b0a5bc9` and checkpoint 27 remained preserved.
It ended **FAIL** across nine tests: one setup pass, eight intended semantic
failures, 74 assertions and no skips. The
[actual receipt](/var/tmp/orbit-windows-installed-startup-2026-10-07/retention-repair-preparation-r27/old-controls/old-actual/actual-receipt.json)
and [full raw log](/var/tmp/orbit-windows-installed-startup-2026-10-07/retention-repair-preparation-r27/old-controls/old-actual/full.raw.log)
retain final-report write failure, live and cleanup membership pre-truncation,
and stale durable status after append or overflow failure. All 286 source bytes
and modes remained unchanged. Reported absence of the owned local test group
only concerns that harness; no Windows provider startup or generation-aware cleanup
was measured. Collector and truncation repairs and a separate external seal-hook
proposal are authorized for preparation only, without repair checks or runtime
proof. These draft and local results do not close platform acceptance,
published-artifact parity or the unconditional native hold.

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
