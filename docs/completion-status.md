# Completion status and evidence

Snapshot: 7 October 2026. Official main snapshot `ce447d1` completed
[run 37520632156](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37520632156)
with all nine normal jobs passing. Candidate results below belong to separate
branches and do not establish combined acceptance or a new release.
The later documentation snapshot `797a5ad` also passed all nine normal jobs in
[run 37524553247](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37524553247).

The newer documentation snapshot `0a989b0` completed
[run 37526680368](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37526680368)
with eight successful jobs and a Windows installed-browser failure. All three
platform suites passed. The installed `session create` command returned
`BACKEND_FAILED`: owned Chrome did not publish its local endpoint within the
unchanged 15-second deadline and was reported still running. This establishes a
startup failure, not its cause or a confirmed cleanup outcome. Investigation
remains open.

The next documentation snapshot `bdac974` completed
[run 37527704505](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37527704505)
with eight successful jobs and a Windows suite failure. All installation and
registration jobs passed, as did Ubuntu and Mac suites. The Windows abrupt
broker-death fixture reached its unchanged 20000-millisecond test deadline;
its suite reported 491 pass, 317 skip and one fail. The retained job log does not
locate the timed-out fixture phase or establish an owned-process survivor.
The later installed-browser pass does not explain the earlier endpoint failure.

[PR 6](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/6)
is merged into official `main` at `886e319855ca65da741cf028cc5391e13e899ce8`.
[Run 37497113691](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37497113691)
passed all nine normal workflow jobs on that exact merge. PR 6 changes three host
evidence collector/comparator files, with 45 passing provenance controls; it does
not change production runtime behavior. Historical evidence remains separately
identified below.
An earlier main snapshot with all nine normal jobs passing is `449e4de`:
[run 37508929441](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37508929441)
passed all nine normal jobs. The isolated candidates below are not part of that
tested main source.
An earlier main snapshot `61ea92c` failed its Windows suite in
[run 37507008661](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37507008661);
the other eight jobs passed. `OpenProcess` returned error 87 while acquiring an
owned process witness before the abrupt broker-death test. Failed acquisition
remains unknown, not proof of exit or cleanup. The census/acquisition boundary
is under investigation. The later green run recorded ten retained Chrome identities
and confirmed their exits, but did not explain the earlier failed acquisition.
The newer documentation snapshot `d27debe` completed
[run 37510883436](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37510883436)
with seven jobs passing and the Ubuntu and Windows suites failing. macOS passed.
Ubuntu reached the saved-account fixture's unchanged 30-second deadline. Windows
reported ten exited Chrome witnesses and an alive `PING.EXE` witness whose creation
time predates both its alleged Chrome parent and the captured Chrome root. That birth-order
inconsistency requires investigation of process attribution; it does not prove a
Chrome survivor. Both failures remain open. That earlier green run alone does not establish
the results of subsequent workflows.
An earlier all-nine passing snapshot is `be8be0f`:
[run 37513298533](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37513298533)
completed successfully on all three platforms. This later passing run does not
explain the saved-account deadline or inconsistent process attribution above.
Published main snapshot `728bbd3` completed
[run 37517456996](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37517456996)
with all nine normal jobs passing. It publishes the diagnostic status documents;
this passing workflow does not establish the causes of the earlier failures or
close the isolated candidate investigations.
Published documentation snapshot `937a230` also completed
[run 37518837273](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37518837273)
successfully. Its normal CI result does not close the remaining investigations.
The checkout declares package version `0.2.0`. The published
[GitHub release v0.2.0](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.2.0)
points to `af37cc4` and does not include the current main fixes. A fresh passive
[registry archive inspection](published-artifact-identity.json) found `latest`
serving `0.1.1`; its SHA512 integrity and SHA1 match the registry metadata, and
its browser, session and launcher bytes differ from current main. Installed
behavior of that artifact remains `not measured`. The [roadmap](roadmap.md)
retains historical gate detail.

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
at `8fee6ea7b80e9fe3a3efee406009ba015f89661d`; it is not merged into main.
[Run 37490050966](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37490050966)
failed the rendered onboarding checks on all three platforms because the generated
website routes were absent. The build step exited zero after printing Bun usage
without running Vite or prerendering. A clean-output reproduction confirmed that
behavior. The corrected build generates both routes. The reviewed repair passed
41 focused local tests without skips, plus TypeScript and the actual website build.
Later test diagnostics passed those same local checks but still require a fresh
independent review. [Run 37495922444](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37495922444)
passed eight jobs, including the Windows and macOS suites, but failed the Ubuntu
English viewer flow while waiting for its initial canvas. The earlier Windows
selected-tab timeout remains unexplained despite succeeding in this later run.
An actual unfixed-backend reproduction separately established that pixels can
show the first page while returned metadata identifies the second tab. The current
candidate repairs that mismatch, refuses captures from changed or closed documents,
and bounds metadata observation without claiming cancellation of pending reads.
Meaningful old-source regressions failed before these repairs. The final candidate
passed 45 focused local tests without skips, TypeScript and the website build.
Fresh independent review of this source remains unproven.
[Run 37502263416](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37502263416)
passed seven jobs, including Windows, but failed the macOS and Ubuntu suites.
macOS has an initial tab-state timeout and two later manual-input readback failures;
the traced tab-selection helpers did restore focus and enabled controls. Ubuntu
again hit the original 30-second saved-account timeout. These failures do not
establish the cause of the earlier initial-canvas or selected-tab timeouts.
The current test-only follow-up adds bounded actual RPC, frame geometry and
trusted fixture input-event traces. Its 45 focused tests, TypeScript and website
build passed locally. [Run 37507476227](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37507476227)
passed seven jobs and failed macOS and Ubuntu. The actual English macOS click
hit the heading because the test used fixed 1280 by 800 coordinate fractions
while the captured canvas was 756 by 469. Whether the test assumptions or the
production pixel/input contract requires correction remains under investigation.
The Arabic backend selection completed successfully in 21 milliseconds, but the
test held its response while waiting for painted state; the viewer aborted after
five seconds. This does not prove a backend selection failure. Ubuntu passed the
product and saved-profile tests; its separate population-readiness fixture timed
out. No native preparation is authorized by that result. Current reviews remain unproven.
The current correction verifies a real green input pixel at the intended point
before deriving click coordinates from intrinsic canvas dimensions. It releases
the actual successful selection reply after asserting pending disabled controls,
then checks selected paint and settled focus. All deadlines and readback assertions
remain unchanged. The final helper failed specifically on lost settled focus using
the original `56fd8f3` viewer files, which were restored byte-for-byte afterward.
The final correction passed 45 focused tests, TypeScript and the website build.
[Run 37510346628](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37510346628)
on that exact candidate completed with seven jobs passing and the macOS and
Windows suites failing. The actual standalone, English and Arabic product flows
passed on macOS, including pending disabled controls and settled selection focus.
The source-bound geometry and input-readback assertions passed, but their exact
successful pixel and input-event trace values were not retained in available logs.
The separate macOS document-navigation capture test expected `BACKEND_FAILED` but
received `TIMEOUT` at the unchanged 3000-millisecond deadline. Windows failed the
stopping-session profile/restore fixture with `DEADLINE_EXCEEDED`. These failures
remain open; passing product flows do not establish their causes or complete
platform acceptance.
The current test-only follow-up retains actual capture, navigation-commit,
document-generation and stopping-session phase order without changing the
operations, assertions or deadlines. Its 45 focused tests, TypeScript, website
build, one stopping-session test and meaningful old-viewer focus negative passed
on the final source, with the original viewer files restored exactly afterward.
[Current run 37514795212](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37514795212)
completed with seven jobs passing, including Windows, and macOS and Ubuntu suites
failing. Its actual checkout was merge `b170c582` into main `be8be0f`, with the
selected product/runtime/test bytes identical to the candidate; the complete
trees differ in six documents and three host evidence files. Navigation and
stopping-session phase cases passed on all platforms. macOS separately hit the
tab-and-resize frame deadline. Ubuntu's initial English canvas remained hidden
after a concurrent document change correctly invalidated an observation. The
existing cost-based polling backoff scheduled recovery after the test's initial
wait ended; this is not evidence of a permanently stopped poll loop. These
remaining failures require discriminating evidence and repair, not weaker waits.
Two new actual old-source controls retained real JPEG delivery while the captured
page navigated or closed. Both observations remained pending at known-obsolete
boundaries, respectively 61.86 and 34.81 milliseconds after observation started,
within the unchanged 3000-millisecond deadline. Both rejected `BACKEND_FAILED`
only after delivery release. This demonstrates delayed known-obsolete rejection;
it does not identify the exact earlier runner stall. The later production repair
synchronously invalidates pending observations on document commit or close,
without claiming cancellation of browser work. Current results appear below.

The earlier `607c8110772f5fdb01675c048d1c3b49218e4634` snapshot of draft
[PR 7](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/7) adds opt-in startup diagnostics
with category-only stderr, selected fixture-root gating and shared-slice counters.
Five focused local tests and TypeScript passed. Required independent reviews
remain unproven. Its [normal run 37503614580](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37503614580)
passed eight jobs and failed the Windows suite on preceding source `440f7cc`.
The actual failure was a parser assertion: host-dependent path joining returned
Windows separators for a Linux cgroup path. The current follow-up uses POSIX path
joining and retains the existing assertions and sampling gates. Its five focused
local tests and TypeScript passed.
[Corrected run 37506862238](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37506862238)
passed eight jobs and failed macOS. Windows reported 495 pass, 317 skip and zero
fail, including the unchanged counter-scope assertion, establishing the narrow
path repair against the earlier failure. macOS reported 505 pass, 305 skip and
two failures: an MCP observation returned text where an image was expected,
without retaining its actual text payload, and a frame capture reached its
unchanged 3000-millisecond deadline. The logs do not distinguish attachment from
screenshot delay; both failures remain under investigation.
The [diagnostic run 37503759704](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37503759704)
passed all three jobs on preceding source `440f7cc`. Its full suite reported 717 pass,
95 skip and zero fail. Saved-account timings were 6.64 seconds isolated and
7.96 seconds in the full suite. Source and instrumentation hashes matched, but
Chrome versions differed, so this is not a controlled same-browser timing comparison.
No failing startup was reproduced. Positive CPU throttling counters in passing
launches do not prove the original timeout cause; unavailable I/O counters remain
unavailable. These diagnostics do not constitute a startup repair or acceptance.
The current follow-up adds owned-session capture phase diagnostics, sanitized
actual MCP error metadata and explicit shutdown outcome checks. Fourteen local
tests across five checks and TypeScript passed on its final source, with no
failures or skips. Linux tests leave the Mac instrumentation inert. Its direct
same-runner Mac diagnostic failed with runner exit code 2 in
[run 37515340231](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37515340231),
while [normal CI 37515345686](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37515345686)
passed all nine jobs on merge `b7582008`. That merge's production and capture
files match the candidate; six documents and three host evidence files differ.
The diagnostic artifact was advertised but could not be downloaded, so actual
phase, source-drift and browser-identity classification remains unavailable.
Actual Mac attribution and both independent reviews remain unproven. Earlier
full raw logs were overwritten through reused paths; original engine receipts
remain historical, but those missing raw bytes cannot be verified. Final-source
logs are retained in a separate immutable packet. No lost log is reconstructed
or replaced by a later run.

[PR 8](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/8) is a separate draft at
`6814b4dcc82feeb9d5649b9815365e4d4f025625`. It prepares two private owned-child
Windows trials comparing deferred acquisition with a handle retained while its
original process is alive. Creator handles close before exit. TypeScript, three
portable controls and the workflow structure check passed; those checks do not
establish actual Windows behavior. The collector is unchanged, unknown acquisition
is never promoted to cleanup success, and the birth-order attribution defect
remains a separate investigation.
[Run 37516200981](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37516200981)
failed before any job started: GitHub rejected `runner.temp` in job-level `env`.
No actual trial, process cleanup receipt or source manifest exists for that run.
The current narrow correction initializes the evidence directory inside the
runner step. Its structural check rejected the preserved failed workflow and
accepted the current context usage; TypeScript and three portable controls
passed again. The corrected workflow is published on the isolated draft branch.
The corrected separate diagnostic
[run 37517349298](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37517349298)
then failed its published-source guard before Bun setup or either process trial.
Its authenticated artifact contains only the initialized `not measured` fallback;
no trial, cleanup or source manifest is established. The guard compares raw
checkout bytes with Git blobs, while the repository explicitly checks out `.cmd`
files with CRLF. Clean local `.cmd` files demonstrate that mismatch. The actual
runner did not print the offending path, so its first mismatching row is unknown.
A canonical Git-content comparison retaining all raw before/after manifest rows
is being prepared; it has not been measured on Windows.
[Normal PR run 37517355682](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37517355682)
passed all nine jobs on actual merge `598556a5`, with Windows recording 495 pass,
317 skip and zero fail. That normal run does not execute the separate acquisition
trials or resolve the earlier process-attribution defect.
The published canonical-content guard passed two real clean CRLF file contrasts,
TypeScript and three portable controls. New separate diagnostic
[run 37519385304](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37519385304)
completed successfully and its authentic archive digest was verified. Independent coordinator comparison verified all 972 raw content rows against the
published Git tree with its actual attributes, with no omissions, duplicates or
before/after changes. The actual row order differs from the promised ordinal
order; that snapshot does not satisfy the aggregate ordering contract. The two private Bun-child
trials demonstrated unknown acquisition after exit and a same-identity exit
measured through a retained handle. This does not establish a production repair,
Chrome survivor evidence or the cause of the earlier false ancestry.
[Normal run 37519392994](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37519392994)
also passed all nine jobs on merge `3bb3ad70`. Windows reported 495 pass, 317 skip
and zero fail. Required independent review remains unproven.

The subsequent typed-sort workflow candidate `6814b4d` completed
[diagnostic run 37523498184](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37523498184)
successfully. Its actual archive contains the unmodified native Git path sequence
and both sort results. On the same 972-path input, the old `System.Object[]` sort
reproduced 39 adjacent order violations; the new `System.String[]` sort produced
strict ordinal order with the same counted multiset. Actual before/after manifest
bytes matched and contained all 972 paths in that order. Archive SHA256
`1edb38022ae5630d6740f5a2e016236a8b67b324b3b54b1a12acdaa57ced52f1`
matches its advertised digest; actual size is 121035 bytes. The initial REST
download timed out with zero bytes; a different connector transport delivered the
verified archive. This establishes the workflow ordering correction, not a
production collector repair or the cause of the earlier process attribution failure.
[Normal run 37523503415](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37523503415)
also completed successfully. Fresh independent review and production witness
repair remain open.

The current Mac diagnostic writes allowlisted nonthrowing arm records into the job
log as well as artifacts. Its six local gates passed, including TypeScript and 16
tests without failures or skips. Actual
[run 37519219281](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37519219281)
failed diagnostic provenance validation: both isolated and full fixture commands
exited zero and the recorded captures completed within 3000 milliseconds, but the
full arm connected first to Chrome 152.0.7977.83 and later to 154.0.8037.98 with
different executable digests. The isolated arm's identity checks passed; the full
arm is invalid for a same-browser comparison. This explains this diagnostic's
exit 2, not the preceding unavailable diagnostic or original capture failures.
[Current normal PR run 37519226341](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37519226341)
completed with eight successful jobs and a Mac suite failure. It recorded a Mac
capture timeout in the fixture
that observes while waiting for an element. Its 514 pass, 305 skip and one failure
belong to merge `86d6bd5` into `937a230`; that distinct timeout remains unexplained.

A retained packet audit found ten copies of stale revision-29 `engine-status.json`
used to enumerate later product snapshots. Their full formal-scope completeness
and fresh-status claims are unsupported. Actual canonical check receipts, raw
logs and the present files' digests remain separately retained evidence. No
missing historical file bytes are reconstructed. A correction sidecar preserves
the affected artifact identities; the current candidate snapshot independently
matches all 59 current files. Its TypeScript, four real prompt-obsolete
regressions, 49 focused tests, actual website build and stopping-session diagnostic
passed without failures or skips. Current negative controls caught both original
browser pending-observation defects and the original viewer settled-focus defect,
then restored the current browser and all four viewer files exactly. Independent
review remains unproven. Actual
[run 37520931996](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37520931996)
on candidate `cf86ebe` completed with eight jobs passing and the Ubuntu suite
failing. Its merge checkout `3ca2f574` into `ce447d1` matches all 59 scoped
candidate files. All four new capture controls passed on every platform. Ubuntu
passed all 49 focused cases; Mac and Windows passed 47 and skipped two existing
Linux-only viewer cases. Full suites reported Mac 528 pass, 305 skip and zero
fail; Windows 516 pass, 317 skip and zero fail; Ubuntu 736 pass, 95 skip and two
failures. Ubuntu reached the unchanged saved-account 30000-millisecond deadline
and the pure population-parser fixture's 5000-millisecond deadline. Their internal
failure phases were not retained, so their causes remain unknown. The latter
fixture compiles and runs a parser control; it does not operate a private display
or authorize native preparation.

The later five-file diagnostic candidate `d59ac67` retains actual saved-account
lease, browser creation, CDP, storage and close phases, plus population-parser
compiler, probe, pipe and child-exit phases. Diagnostic wrappers preserve original
promises and outcomes, restore only their own methods and prevent late registration
after cleanup. All ten local gates passed on its exact 71-file snapshot, including
six lifecycle controls and both affected fixtures. Capture and fixture deadlines
remain unchanged. Actual
[run 37525107763](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37525107763)
completed with eight successful jobs and a Mac suite failure. Its merge `5bc166ff`
into `797a5ad` matches all 71 scoped candidate files. Ubuntu reported 744 pass,
95 skip and zero fail; Windows 522 pass, 317 skip and zero fail; Mac 533 pass,
305 skip and one failure. Both previously failing Ubuntu fixtures passed with
actual phases and no pending operations at final cleanup; these passes do not
explain the preceding timeouts. Mac again reached the unchanged 3000-millisecond
capture deadline in the first concurrent tab-and-resize frame case. Actual logs
do not distinguish capture delay from time spent intentionally holding real JPEG
delivery while the tab and resize actions finish. All four prompt-obsolete controls
passed. The Mac failure and independent reviews remain open.

The published one-file first-frame diagnostic follow-up `8fee6ea` passed all eleven
planned local gates on its frozen 71-file snapshot. It traces actual backend
creation, capture, held JPEG delivery, concurrent tab and resize actions,
observation settlement and cleanup, preserving original promises, operations,
assertions and deadlines. Both old-source controls failed at their intended
boundaries and restored production bytes exactly. This validates instrumentation;
it does not explain the earlier runner timeout or establish independent review.

Actual [run 37527793374](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37527793374)
on this candidate completed with eight successful jobs and a Mac suite failure.
Its merge `feff5a80` into `bdac974` matches all 71 scoped files. Mac reported
533 pass, 305 skip and one fail. The first-frame trace shows observation starting
at 2710 milliseconds, actual JPEG ready at 4371, held delivery released at 5007,
and observation failing at 5713. Delivery settled before the original capture
deadline, so the retained trace narrows the remaining wait to post-release work;
it does not identify the specific metadata operation or explain its delay.
Owned backend close and profile removal finished with no pending diagnostic
operations. Ubuntu and Windows suites passed. Further boundary evidence and
independent review remain required; no capture deadline was increased.

The newer Mac diagnostic candidate `ceca438` records phases from the actual
concurrent preview fixture and actual source manifests before and after each arm.
TypeScript and 17 selected local tests passed with no failures or skips.
[Run 37521638238](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37521638238)
checked out that exact candidate and ended with diagnostic exit 2. Both fixture
commands exited zero, capture fulfilled within the original 3000-millisecond
deadline and fixture shutdown completed. Actual source manifests matched before
and after both arms. The full arm again changed from Chrome 152.0.7977.83 to
154.0.8037.98 with different executable digests, invalidating the comparison.
No capture timeout was reproduced and the browser mutation cause remains unknown.
These records were retained in the complete job log; the advertised archive was
not downloaded. Normal CI on exact `ceca438` is `not measured`: commit queries
returned only the diagnostic, while PR metadata still reported parent `607c811`
despite the branch ref and diagnostic checkout identifying `ceca438`. Neither
that discrepancy nor passing captures closes the earlier Mac failure.

The newest separate Mac candidate is `fbf81d8`. Its controlled diagnostic uses a
complete app-bundle copy in an owned disposable CI directory, with fixture-only
default selection. Signed bundle metadata supplies the expected version without
an extra copied-browser launch. Full resource, mode, internal-link and extended
attribute inventories are checked before and after each arm; source and selected
browser drift still invalidate the comparison. Explicit executable owners are
refused, and ordinary production selection remains unchanged. This intervention
is a controlled fixture measurement, not a repair of the ordinary resolver.
All six local gates passed, including TypeScript and 21 selected tests without
failures or skips; Linux leaves Mac instrumentation inert. The initial timer-type
check failed and its original raw log and receipt remain retained separately.
The corrected candidate matches all 442 current scoped files. Actual
[controlled run 37526278775](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37526278775)
passed on exact `fbf81d8`. Both isolated and full-suite arms retained identical
source, selected copied executable, resources and attributes; captures fulfilled
within the unchanged deadline and owned copy removal was confirmed. The original
bundle changed during the full arm while the selected copy remained Chrome
152.0.7977.83. This measured intervention does not establish update causality or
repair ordinary browser selection. The downloaded 283218-byte artifact matches
its advertised SHA256 and both original arm records.
[Normal run 37526285644](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37526285644)
passed all nine jobs on merge `9b558b4b`. Ubuntu reported 729 pass, 95 skip and zero
fail; Mac 519 pass, 305 skip and zero fail; Windows 507 pass, 317 skip and zero
fail. Production and controlled diagnostic files match the direct candidate;
nine documentation and host evidence files differ. The earlier timeout cause
and both independent review axes remain unproven.

The current managed-lifecycle workstream fixtures executed 119 tests, skipped 20
and failed none; TypeScript exited zero. Independent specification and operational
reviews are still required after expanding source binding to include the invoked
installer and service adapters. Fresh review creation is currently unavailable:
agent contexts reached their limit, the configured Codex CLI model was rejected
by the account, and Claude CLI authentication expired. Earlier reviews cannot
prove the revised source. These fixtures do not establish actual macOS service,
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
