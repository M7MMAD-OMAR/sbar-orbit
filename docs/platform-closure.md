# Platform closure contract

Current recorded state: official main remains `bbfb6b5`. UI successor `215d59d` is locally accepted and published in draft PR20; provider and final-main acceptance remain open. Managed XML V10 remains unaccepted because its source-stable full-suite gate rejected generated Python caches. See the [latest successor and execution record](#connection-recovery-successor-and-current-execution-limits).

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

The verified main baseline is [834f3f6dbbda77aa8b002432e9b462b2702a2282](https://github.com/M7MMAD-OMAR/sbar-orbit/commit/834f3f6dbbda77aa8b002432e9b462b2702a2282),
which reconciled the accepted PR 15 evidence retained below. Documentation
PR 18 subsequently merged at `bbfb6b5b3892f920b798d212e2361d8907249c8d`.
Its successful nine-job PR run does not replace the failed actual-main run
recorded below. Runtime acceptance remains separate from documentation publication.

The startup and capture successor is [draft PR 17](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/17),
currently at `92608f93c18fc89e351759228d8f5ffea8391b0f`, tree
`efe3878f5a51a96f15c337d8997b2125c6e5396b`. It remains open and unmerged.
PR 15 acceptance does not accept this new candidate or close the full platform.

The combined candidate retains the exact portable resource sampling fixture
from `abe0d63` and integrates the five capture paths from `292cea0`.
Nine local checks and two fresh independent reviews accepted its local contract:
the full suite ran 963 cases with 914 pass, 49 skip, zero fail, 6063 assertions
and 274.63 seconds. Full-suite receipt SHA256 is
`e18c9835bece770a0fb77fb1ab9c94e762552fb58e90c7e9779a14cd8b672793`.
This local acceptance does not accept a provider run or final official main.

Its exact-source [normal run 37656562979, attempt 1](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37656562979)
failed: eight jobs succeeded and the Windows suite failed. The original
attempt archive identifies native checkout `92608f9` in all nine jobs.
Ubuntu reported 867 pass, 95 skip and zero fail; macOS reported 656 pass,
306 skip and zero fail; Windows reported 642 pass, 318 skip and two failures.
The Windows failures were
`cross child leaves real browser capture available in the shared suite`,
with startup endpoint timeout, and
`abrupt broker death reaps its browser tree and a fresh broker rejects stale sessions`,
with the unchanged 20000 ms test timeout. Their causes and repaired outcomes
remain `not measured`. The original Windows raw log SHA256 is
`d0f4abed43005cc7ca1ab202cbed2d2242761c7c661acd77ea5cd8cb6a1da66c`.
The authenticated attempt log archive is 495585 bytes with SHA256
`af9d4329e7cfd492f5c81c74bb0512e65e44aba0b589e05366490632d7341333`;
all 112 members passed CRC validation. This is a log archive, not a complete
source archive emitted by the runner. Failed provider evidence prevents
provider acceptance; the local result does not replace it.

The documentation head `bbfb6b5` passed all nine jobs in
[PR run 37654515558](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37654515558),
then its separate [actual-main run 37655792956, attempt 1](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37655792956)
failed. Eight jobs succeeded and Windows reported 638 pass, 317 skip,
two failures, 957 cases across 186 files, 4305 assertions and 526.38 seconds.
`settings retry an unavailable connection in ar` failed during fixture setup
at `tests/product-ui.test.ts:248`, waiting for `domcontentloaded`.
`public onboarding renders and keyboard navigation works in ar` failed at
line 628, waiting for `networkidle`. Both navigation deadlines remained
15000 ms. Raw Windows log SHA256 is
`ec41fe1b1d7d565b76850ef88ab64321569a56d264d0412d8eefe861fd3cc61e`.
The setup failure bypasses the existing caller cleanup in the settings fixture;
this control-flow cleanup gap is distinct from the unproven initial timeout
cause. No timeout extension, retry or repaired result is claimed. These main
failures differ from the candidate failures and are preserved independently.

The previous candidate `c8effcd8feb51d5da1ffdcea4af6340c2d31570f`
completed all three Ubuntu jobs in [profile diagnostic run 37646205630](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37646205630).
Its separate local full suite ran 963 cases: 914 pass, 49 skip, zero fail and
6057 assertions. That local result remains bound to the previous source and
is not a full-suite result for `abe0d63` or a cross-platform acceptance.

The previous source also failed [direct normal run 37646274451](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37646274451):
eight jobs succeeded, while the Windows suite reported 643 pass, 318 skip and
one failure across 962 cases in 187 files. Its sole failed case was
`failed resource sampling stays unavailable and retains successful counters`.
The [previous PR normal run 37646109212](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37646109212)
failed the same Windows fixture and separately failed the macOS case
`browser frame keeps its captured page and dimensions when tab actions finish concurrently`,
with `TIMEOUT` at the unchanged 3000 ms capture budget. The retained Mac summary
is 655 pass, 306 skip and one failure across 962 cases in 187 files. Profile
diagnostic success does not replace these normal-workflow failed measurements.

Commit `abe0d63` changes only the Windows-sensitive resource sampling fixture:
the test now matches the exact native `join` path used by production instead
of a slash-only suffix. It changes no production code, assertion, skip or
timeout. A source-pinned focused Linux child passed the named resource case:
one pass, zero skips, zero failures and ten assertions; four filtered cases
are excluded from those totals. The independent source/evidence review found
no actionable findings. Receipt SHA256 is
`10822fd7e2242adba37e91a0014e310852f1057810f71b3d2b65b26ce5ffcec9`;
its source manifest SHA256 is
`c426152ffde11fb2d85b8e0e8262098269c97aab3f3c0a61e0fdaf4ecfa9c07b`.
These local-only archives are not published by the PR link.

The retained connector metadata now reports [fresh PR run 37649479046](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37649479046)
completed successfully, with all nine jobs successful. This terminal metadata
supersedes the October 7, 2026, 8:08 PM Dubai time in-progress observation.
The decoded Windows suite log identifies PR merge checkout `cb2fb9b`, merging
`abe0d63c83461ff4d1351d4b4bf328b69ee69144` into official main `834f3f6`.
It records the resource sampling case passing and a terminal summary of
644 pass, 318 skip, zero fail, 962 cases across 187 files, 4367 assertions
and 393.38 seconds. This is an observed Windows outcome on that PR merge
checkout, not a direct candidate checkout or an actual-main measurement.

The retained Windows file is connector-decoded log text; its SHA256 is
`bda30f02f568fe1a47cede9a3c85a40b9c69badbbf85f794244773e3bc960ce9`.
That hash identifies the decoded file, not original HTTP response bytes.
Complete provider source/blob and archive verification, original raw retention,
Ubuntu and Mac case inventories and terminal counts, fresh candidate provider
acceptance, independent provider reviews and final-main evidence remain pending.
Unknown or skipped scope remains `not measured`. Terminal metadata and the
scoped Windows outcome do not accept the whole platform or transfer the previous
candidate's local suite result to `abe0d63`.
The fixture correction does not repair or explain the separate Mac capture
timeout, establish startup reliability or prove production performance gains.

The separate documentation [PR 18](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/18)
at `c0054c2080c426c0a82599c7d775cbded6e7c5cb` failed
[run 37651136473](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37651136473):
eight jobs succeeded and the macOS suite failed. Its retained authenticated raw
log identifies PR merge checkout `5b1ad1d`, merging that documentation head
into `834f3f6`, and reports 651 pass, 305 skip, one failure, 957 cases across
186 files, 4357 assertions and 360.37 seconds. The failed case was
`selected page restores keyboard focus after its command completes`, taking
18336.77 ms. The actual failure was a 5000 ms `waitForFunction` timeout at
`tests/product-ui.test.ts:385`, after `session.pause`, while waiting for the
paused viewer with two tabs and its second tab selected. The subsequent focus
verification was not reached. The failure cause and a repaired outcome remain
`not measured`; no cause is attributed to documentation, host load or a focus
regression. Raw log SHA256 is
`3d9263f98ad73fb7dc9de004abc7201876bc09a9ee49170b5257637c72ca555b`.
This is separate source-bound failed evidence and does not replace the PR 17
Windows result or establish final-main or whole-platform acceptance.

Public latency remains 42.942314 percent overhead against the 20 percent target,
a failed target. Managed lifecycle and recovery, release/package parity,
external participant acceptance and broader platform closure remain open.
Native owner handoff and plugin activation remain unconditionally on hold;
owner input, borrowed input/resume and alternate routes remain unauthorized.

## Accepted PR 15 integration evidence

Latest verified runtime integration on official main is [7458a35d380777ea5d990312dd9eadfe7cce943b](https://github.com/M7MMAD-OMAR/sbar-orbit/commit/7458a35d380777ea5d990312dd9eadfe7cce943b), after
[PR 15](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/15) merged the bilingual
product interface and capture contracts with the accepted CLI pipe diagnostics.
That runtime integration tree `39a86a0facb0b7f591c4020720851eb6a0f8e792` exactly matches published
head `3ee1963f30b9fcac7d6a45fcf257d770322547f5`, local validated integration
`a7e1f6a57e4957baf85b5ea1ff7e36906aab1666` and actual PR checkout
`c12ac8fb9fc70f51f242961ba9ef0e83e0b977d9`.

The product checkpoint was formally accepted at revision 184, with source hash
`c7eb1d0209d6f24e46cdbf1b0a6db3d6c2e6688cde12f8efdec16e21c7bf90ec`
and plan hash `0817b8cf6c53cee63c170eba1ebca94e2841680c66f59e055aec998b5631f63c`.
All 13 behavior gates, two fresh independent specification/standards reviews
and the fresh independent UI gate passed. This accepts the stated product and
diagnostic contract only; full platform closure remains open.

[PR run 37619300681](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37619300681)
completed all nine jobs successfully. Each provider suite actually ran 957 cases
across 186 files. These are the PR counts, separately bound to that workflow:

| Runner | Pass | Skip | Fail | Assertions | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 | 862 | 95 | 0 | 5526 | 378.34 |
| macOS | 652 | 305 | 0 | 4362 | 323.78 |
| Windows | 640 | 317 | 0 | 4333 | 389.89 |

The retained PR freeze manifest SHA256 is
`c77b6cc165eba703341c6100f991c661e698cacd06f40365ab27bd84004d5b1e`.
Offline checks verified 1132 retained files, 991 source blobs, 12 API-pinned ZIPs
and 56 CRC-checked members. All named provider cases and explicit skip inventories
match their terminal summaries. The local complete suite separately ran 958
cases: 909 pass, 49 skip, zero fail and 6006 assertions. The extra local case is
conditional confinement coverage in `tests/browser-upload.test.ts`; provider
scope does not include it. Child controls are separate observations and are not
added to these parent suite totals. Skipped or unknown scope is `not measured`.

The separate [actual-main run 37621614377](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37621614377)
completed all nine jobs successfully on actual push checkout `7458a35`.
Its complete raw logs independently identify that checkout for every job.
Each main suite ran 957 cases across 186 files, with these actual results:

| Runner | Pass | Skip | Fail | Assertions | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 | 862 | 95 | 0 | 5526 | 370.44 |
| macOS | 652 | 305 | 0 | 4362 | 353.60 |
| Windows | 640 | 317 | 0 | 4331 | 424.76 |

The actual-main freeze manifest SHA256 is
`292a178fcd7f0dcac245b3e231429f0e23fb29d93e94fd0ebe79fcedfa8c8345`.
The coordinator independently verified all 1140 retained files and modes, all
991 Git blob identities, nine raw logs, 12 new API-digest-pinned ZIPs, 56
CRC-checked members and their extracted bytes. Named case and skip inventories
match each main terminal summary. Windows main's 4331 assertions remain distinct
from PR Windows's 4333; no assertion parity or cause is inferred from equal
case totals. Main evidence uses its own provider logs and artifacts.

Main traces independently reconstruct 65 logical messages, final ordinal 65 and
161 physical frames per platform. Dropped records are 53 on Ubuntu, 75 on Mac
and 77 on Windows; fixture-stop remains pending. Six producer fields match the
current source and declared dependency hash support, with original child exit
zero. All six original pipe receipts and raw report/stderr/Python bytes match
current main suite diagnostics and five source producer digests. Main child
controls and actual real-parent report remain separate: 320x240, one page and
1208 image bytes. The parent JPEG binary and child stdout bytes are not separately
archived; raw-log metadata cannot establish image-content inspection.

Both original observe/list pipe cases passed on every PR provider with awaited
exit zero and exit-code snapshot zero. Raw report bytes are Python wrapper
output, with original CLI stdout assertions and metadata; full CLI stdout bytes
are not archived in those receipts. Artifact caps are checked after EOF rather
than enforcing a streaming memory bound. Pipe deadline enforcement, full process
cleanup and the earlier Windows exit 143 cause remain `not measured`.

PR traces independently reconstruct 65 logical messages, final ordinal 65 and
161 physical frames per provider, with six source-bound producer fields and
original child exit zero. PR dropped records are 67 on Ubuntu, 61 on Mac and 73
on Windows. Fixture-stop remains pending. Dependency package/coreBundle bindings
and existing matched CDP browser replies do not establish loaded executable
identity or archive provider runtime binaries. Windows ACL and ancestry race
resistance, full cleanup and power-loss persistence remain `not measured`.

The completed local suite used a 600-second aggregate inner supervisor and a
630-second outer gate for the expanded scope. Earlier V4 inner 300-second and V5
inner 330-second attempts actually timed out; their incomplete summaries remain
failed measurements. The budget adjustment is not a functional repair, exit 143
diagnosis, CPU/hang/production regression determination, cleanup proof or public
performance improvement. Original 6/8/15/45-second production and per-test
budgets remain unchanged. Earlier PR 13 framing, PR 14 pipe integration, raw
provider failures and rejected product measurements retain their own source
identities and limits in the historical records below.

Managed browser installation is measured at the Limited disposable runner tier
on Ubuntu, Windows and macOS. Managed update adoption, activation, scheduling
and real service/task rollback remain separate evidence or code gaps.
[GitHub v0.2.0](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.2.0)
still identifies `af37cc4`; retained [registry inspection](published-artifact-identity.json)
identifies `latest` as `0.1.1`. Those published artifacts do not establish parity
with this main integration or external installed behavior.

Public latency remains 42.942314 percent overhead against the 20 percent target,
a failed target. Idle overhead is 5.523438 MiB against 100 MiB, a bounded pass.
Product acceptance and suite completion establish no production performance
repair. Startup causes, Windows census, managed update lifecycle, release parity
and external participants U1/T1 through U12/T12 remain open or `not measured`.
[Support tiers](support-tiers.md) continue to govern capability claims.
Native owner handoff and plugin activation remain unconditionally on hold;
owner input, borrowed input/resume and alternate routes are not authorized by
this acceptance. The full platform objective remains active.

Public PR, workflow and commit references below identify publication and source.
Local-only review and diagnostic archives are not published by those links;
retained manifest digests identify the separately archived evidence. Historical
then-current candidate and publication statements apply only to their snapshots.

## Historical PR 14 integration and pending combined product snapshot



Latest verified runtime integration on official main is `c98dce1f05a8b2fe47dcb5403f04715fe6ba47e3`, after
[PR 14](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/14) merged the CLI pipe
diagnostic work. Its tree is `bb069b26ccd9436944404cfe7161f9f9c8e8bf82`.
The separate [main run 37608658929](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37608658929)
completed all nine jobs successfully. Retained raw job logs identify actual
`c98dce1` checkouts for all nine jobs. Each suite ran 925 tests across 181 files:

| Runner | Pass | Skip | Fail | Assertions |
| --- | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 | 830 | 95 | 0 | 5079 |
| macOS | 620 | 305 | 0 | 3920 |
| Windows | 608 | 317 | 0 | 3890 |

The [actual-main packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37608658929)
retains nine raw logs, 12 API-pinned ZIPs and 56 CRC-checked members. Its freeze
manifest SHA256 is `f7bb796598bcdb6e58919993de68f1ef75cfe4993ed7f241141058bff4259fe8`.
The [retention audit, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37608658929)
verified 981 canonical source blobs and exact platform case and skip inventories.
That audit checks retention and source binding; it supplies no new formal
checkpoint acceptance. Skips remain `not measured`.

Both original CLI pipe cases passed on each platform with awaited exit zero and
exit-code snapshot zero. Retained report.raw bytes are Python wrapper output,
not an archive of the CLI image. Original assertions checked CLI stdout and its
retained metadata; artifact caps are checked after EOF rather than enforcing a
streaming memory bound. This diagnostic integration does not explain the earlier
Windows error 143, establish full cleanup or prove general startup reliability.
Actual-main observer traces reconstruct 65 logical messages per platform, with
162 physical frames on Ubuntu and 161 on Mac and Windows. Dropped records are
49 on Ubuntu, 67 on Mac and 63 on Windows. Fixture-stop remains pending; browser
loaded executable identity, Windows ACL and ancestry race resistance, provider
executable archival and power-loss persistence remain `not measured`.

The current product candidate is [draft PR 15](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/15)
at `3ee1963f30b9fcac7d6a45fcf257d770322547f5`, tree
`39a86a0facb0b7f591c4020720851eb6a0f8e792`. The fetched tree matches local
`a7e1f6a57e4957baf85b5ea1ff7e36906aab1666`. Its source hash is
`c7eb1d0209d6f24e46cdbf1b0a6db3d6c2e6688cde12f8efdec16e21c7bf90ec`,
plan `0817b8cf6c53cee63c170eba1ebca94e2841680c66f59e055aec998b5631f63c`.
The [local execution packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/15)
records 13 passing gates. The local full suite reports 909 pass, 49 skip and zero
failures across 958 cases in 186 files, with 6006 assertions. Synthetic child
controls remain separate from full-suite counts. The new 958-case local suite
uses a 600-second aggregate inner supervisor and 630-second outer gate. Earlier
300-second V4 and 330-second V5 aggregate attempts timed out and remain failed
partial measurements. This adjustment establishes completed local measurement,
not a functional repair or a CPU, hang or production regression diagnosis.
Original production and per-test deadlines remain unchanged. Two local draft
readiness reviews pass, with formal overall acceptance explicitly false.
The [fresh independent UI report, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/15)
passes local English and Arabic desktop/mobile fixture review and was imported
at revision 180. It does not establish participant, physical device, assistive
technology, production or provider acceptance. Fresh provider CI for this exact
published product source and formal integrated checkpoint acceptance remain
pending in this preparation snapshot. Earlier candidate CI cannot accept this
new head. Exact-head [run 37619300681](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37619300681)
was in progress with no terminal conclusion at the retained API observation.
The product candidate has not been merged or formally accepted.

Managed browser installation is measured by the current installed-browser CI on
Ubuntu, macOS and Windows, at the Limited disposable runner tier. Published
package parity and external device behavior remain `not measured`. Managed
update adoption, activation, scheduling and real service/task rollback evidence
remain separate gaps; installation is not a managed update measurement.
The GitHub `v0.2.0` release still points to `af37cc4`, while retained
[registry inspection](published-artifact-identity.json) identifies `latest`
as `0.1.1`. Published artifacts do not match this main integration.

The source-bound public performance baseline remains 42.942314 percent latency
overhead, failing the 20 percent target, and 5.523438 MiB idle overhead, passing
the 100 MiB target. Passing suite budget or UI fixtures establishes no public
performance improvement. Startup causes, Windows census, managed update
lifecycle, release parity, external participant U1/T1 through U12/T12 acceptance
and the unconditional native hold remain open. Native owner input, borrowed
input/resume and owner plugin load must not be enabled or tested through an
alternate route. Full platform closure remains active.

Historical snapshots below retain their original failures and limits. Their
then-current candidate and publication statements apply only to those snapshots.
This is a preparation snapshot; after product acceptance or merge, obtain fresh
actual-main evidence and replace this current section before claiming a final
documentation reconciliation.

### Historical integration snapshot at PR 13

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
[terminal packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37535432220)
and [installed artifact packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37535432220)
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
[full terminal packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37538046122)
and [installed Windows packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37538046122)
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
[publication sidecar, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
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
[publication sidecar, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/10)
links the [actual Windows packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/10)
and retained review reports. Neither PR is accepted or merged.

The unpublished Mac review repair reached local revision 33 at source
`312f67e6a4efbaf02666a4f131161e8ce486fb5236971e55c441c16f314a5d19`
and plan `61e92c6cdd0550e7b7be124f03532a1b63122f5dc7ff80bfc8dcc8e39304e030`.
TypeScript passed; 20 pure observer controls passed with 87 assertions, and
seven defective variants each produced one intended failure, passing the negative
gate. The original stopping fixture passed one Linux test with five assertions.
The bounded trace retained 65 emissions, final sequence 293 and 37 drops; the
original fixture-stop remained pending, so full chronology is not established. Its
[frozen review-input packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
binds all 403 influential files and the actual raw receipts. The fresh repaired-source
[specification review, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
returned **FAIL** with one major I5 finding: a trace ending before an admitted
`Browser.getVersion` reply omits browser identity instead of explicitly recording
`not measured`. The [coverage report, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
retains the satisfied requirements and measurement limits. The fresh
[standards review, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
returned **PASS** without findings, but overall review remains **FAIL**. Subsequent
[old-source pure controls, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
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
[actual receipt, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
and [full raw log, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
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
retains historical isolated measurements and failed draft PR checks. The current
execution section above identifies the accepted PR 15 integration at 7458a35. Historical candidate results do not close pending acceptance.

## Dependency order and completion evidence

| Stage | Required outcome | Evidence required | Current state |
| --- | --- | --- | --- |
| Consolidation | Every branch/worktree classified; useful unique patches integrated; current core failures resolved; official branch updated | Git ancestry and patch IDs, preserved private work, discriminating regressions, local suite, independent review and matching three-platform CI | In progress |
| Product | Clear architecture and product hierarchy; usable viewer and public onboarding in English and Arabic | Actual rendered flows at desktop and mobile sizes, RTL and keyboard interaction, error/busy/paused states, current design contract and independent review | PR 15 merged at 7458a35; 13 gates, two fresh independent formal reviews and current UI gate pass; product checkpoint accepted at revision 184; current PR and actual-main evidence above; external acceptance remains open |
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
branch was merged through PR 6; the then-current product branch was draft PR 5.
The current execution section above records accepted and merged PR 15.
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

## Historical defect evidence

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


## Current UI cleanup local evidence and PR20 provider failure

The fixture cleanup predecessor `1b0b43e51401aa6951852922ce820d2a677577ac` was published in [draft PR20](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/20), without main acceptance. The connection recovery successor is recorded below. Its isolated fixture cleanup checkpoint had authentic old controls with two pass and four fail, current six controls passing, thirteen product UI cases and two unchanged caller cases passing. The full local suite reported 915 pass, 49 skip, zero fail and 6048 assertions across 964 cases. Fresh independent specification and ownership reviews passed, and delegated local acceptance completed. This supports local cleanup hygiene only. The original Windows timing cause, skipped scope, native activation and final-main acceptance remain `not measured`.

The actual [PR20 provider run 37670328088, attempt 1](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37670328088) failed: seven jobs succeeded, while Windows and macOS suites failed. All nine checkout logs identify PR merge `424be14614f301984a7d63e83043e105c86fffa6`, merging the UI head into main `bbfb6b5b3892f920b798d212e2361d8907249c8d`. The authenticated 508218-byte log ZIP has SHA256 `8d7b581b4bf036dd261db006e89265b8e2300ae2d205ae3895d89a32f6f9c5b0`; all 111 members passed CRC verification. This is that PR merge measurement, not a final-main result.

Windows reported 643 pass, 317 skip, three fail and 4344 assertions across 963 cases in 437.59 seconds. Failures were the shared-suite real browser capture child missing its browser endpoint, abrupt broker death setup, and capture while a web font remains pending. Original raw log SHA256 is `2c63345012854e9eb98567e437f0d98e3439d3b8dc4a56b6eb47f79b12340e52`. The first two failures occur before the intended capture or broker death measurement; no browser cleanup defect or timing cause is inferred from them.

macOS reported 657 pass, 305 skip, one fail and 4384 assertions across 963 cases in 360.05 seconds. The selected-page focus case failed its initial paused-page readiness wait after an observed 3000 ms capture timeout. The later keyboard focus assertion was not reached. Original raw log SHA256 is `2b575302556f015199b00c1277218db2af98ac4ab22c3a4de6cfe17d46efbdef`. The underlying attachment, pixel or metadata phase remains `not measured`; cleanup hygiene does not establish the capture cause.

A separate [direct-head workflow run 37671161645](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37671161645) was dispatched once for exact UI head `1b0b43e51401aa6951852922ce820d2a677577ac`. Its verified terminal result is failure: seven jobs succeeded, macOS failed and Ubuntu was cancelled during Linux selection callback dependency installation. The bounded Ubuntu suite was skipped, so its test result is `not measured`. All nine checkout logs identify that exact head. The authenticated 378732-byte archive has SHA256 `aeef79ce8a91e94b0801df7f24ba5d6cae545de865299aeb591c5d346621ae2a`; all 110 members passed CRC validation. macOS reported 657 pass, 305 skip, one fail and 4367 assertions across 963 cases in 381.03 seconds. The Arabic lifecycle and page-selection assertion failed at product-ui.test.ts:500 and :569, receiving connected true while connected false was expected. The 307254-byte raw log SHA256 is `9e046da37a91bda1bd28fd3ec26e46b1c1556d68ded07d2ae5b561a0fe9d0996`. This connection-state failure is preserved separately from the earlier initial capture failure. Current provider and whole-platform acceptance remain open.


## Connection recovery successor and current execution limits

[Draft PR20](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/20) now publishes `215d59df792b5706fab89b9413f98e3097bc48fa`, with parent `1b0b43e`. The two new paths are viewer/viewer.js and tests/viewer-polling.test.ts. The viewer marks a poll connected after observation and decoding complete and its poll error clears. A pending next frame therefore retains the prior disconnected state and visible capture error; healthy manual polling still recovers without requesting a frame. The genuine unchanged-old regression failed its assertion, while current polling passed all eleven cases with 44 assertions. Product UI passed thirteen English/Arabic cases. Related callers passed eleven cases with one existing Windows-only skip. The full local suite reported 918 pass, 49 skip, zero fail, 967 cases and 6061 assertions in 297.39 seconds. Original raw stderr SHA256 is `0a04476f2a9d3c911482102b65fa540180f2bbca364912aad19c3566d0a8660f`.

Both fresh specification and standards reviews passed. The corrected audit retained the actual successful caller child and its legitimate skip after the original wrapper rejected an incorrect zero-skip expectation. Seven new parser controls and thirteen source-bound retained execution audits passed. Delegated local acceptance completed before commit; publication continuity confirmed unchanged checkout source bytes. This does not claim another full-suite invocation. Git/ref and provider identity require downstream rebinding. [New PR run 37681318320](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37681318320) advertises the successor head; its terminal outcomes and all actual checkout identities have not been accepted in this record. Native activation, skipped scope, final main and underlying initial capture timeout cause remain `not measured`.

The prior documentation head `b7c513aea79d2020e8de3c11262d6f6052a1ec14` had a separate [run 37673060886](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37673060886): eight jobs succeeded and macOS failed its Arabic connection-state assertion. All nine checkout logs identify PR merge `f5116d4a09288f1dbb12b761c68645c46090a725`. The authenticated 502909-byte archive SHA256 is `fa3d209b59a6efee08f8d8eeffd0e53f461b7ca65db44e6b038fa1e81d60ca5c`; all 112 members passed CRC validation. macOS raw SHA256 is `d68b7960777eaa5488b03027bde67e492c1c73a5ca1329418d197c9e15eb3f4e`, with 651 pass, 305 skip, one fail and 4340 assertions across 957 cases in 366.64 seconds. This is additional baseline evidence, not a repaired successor result.

Managed lifecycle XML candidate V10 remains unaccepted. Its twenty-six prerequisite gates passed, including genuine old malformed-XML failures and four current XML cases with 536 assertions. Its full-suite child reported 979 pass, 52 skip, zero fail and 6813 assertions across 1031 cases in 321.91 seconds, but the required source-stable gate rejected 36 newly generated Python cache entries with gate exit 82. Both fresh reviews failed on that missing valid full-suite gate. Original full stderr SHA256 is `1731000df967f2c1ea48c822aa35f099fa3f33184295a135a043dea92737e0ba`. The passing child result does not replace the rejected gate. A separate bytecode-isolated successor requires fresh evidence; I3, I4, I5, provider and final-main closure remain open.
