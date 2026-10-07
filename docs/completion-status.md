# Completion status and evidence

Current recorded state: official main remains `bbfb6b5`. UI successor `215d59d` is locally accepted and published in draft PR20; provider and final-main acceptance remain open. Managed XML V10 remains unaccepted because its source-stable full-suite gate rejected generated Python caches. See the [latest successor and execution record](#connection-recovery-successor-and-current-execution-limits).

## Current startup diagnostic candidate and provider limits

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

## Current verified integration and accepted product contract

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

## Historical integration snapshot at PR 13

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

## Historical integration snapshot before PR 13

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


Historical publication sequence: official main snapshot `ce447d1` completed
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

The later official-main snapshot `4089c50` completed
[run 37528913748](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37528913748)
with eight successful jobs and a Mac suite failure. All installation and
registration jobs and the Ubuntu and Windows suites passed. Mac reported
503 pass, 305 skip and one fail. The profile-and-restore removal fixture reported
`Invalid InterceptionId` from Playwright's CDP response dispatcher after
1395.35 milliseconds. The retained log does not identify the active fixture phase,
response method or process outcome. This is a distinct failure from the earlier
frame and Windows deadlines; its cause and cleanup outcome remain unmeasured.

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
is retained under the coordinator's private archive; these runtime checks
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

The candidate entries in this section are historical source-bound records. The
[current verified integration and accepted product contract](#current-verified-integration-and-accepted-product-contract)
section above governs the current integration state.

These results belong to isolated workstreams and do not establish a new combined
runtime or release. [PR 5](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/5) is a draft
at `efab0eae7e0bed576bba81bc179b8ce148edf399`; it is not merged into main.
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

A separate unpublished Windows debug-provider feasibility preparation reached
local R5 engine revision 10. TypeScript passed and 12 pure portable controls passed
without failures or skips on Linux. Its formal source hash is
`3bf50ae0d52608cdb69836b63f66b59615d77effadb037e26a50f391d1ec2b5d`;
all 399 influential files remained unchanged. The controls cover exact creator
handoff, distinct assignment/observation rights, missing and inflight transfer
seals, third-generation refusal, exception dispatch and retryable handle ownership.
The earlier R4 typecheck failure is retained. These checks do not measure the
native `DEBUG_PROCESS` producer or demonstrate an old native regression. Actual
Windows Bun feasibility, nested-job compatibility, complete unchanged Chrome
coverage and performance remain `not measured`; both independent review axes
remain unproven. The production collector is unchanged. The local
[packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
and [raw controls, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
retain the source bindings and measurements.

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

The next one-file first-frame diagnostic follow-up `efab0ea` passed all eleven
planned local gates on its frozen 71-file snapshot. It adds boundaries around
actual presence, pointer binding, page title and the existing cached pointer
operation, preserving their original receiver, arguments and returned promises.
The wrappers are removed during cleanup; exact private method and map-entry
identity after backend close is not directly measured.

Actual [run 37530252584](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37530252584)
completed all nine normal jobs successfully. All three suite logs checked out
merge `bbd332c8` into official `4089c50`; all 71 scoped candidate files match
`efab0ea`. Ubuntu reported 744 pass, 95 skip and zero fail; Windows 522 pass,
317 skip and zero fail; Mac 534 pass, 305 skip and zero fail. Skips are not measured
capabilities. The current Mac first-frame trace records held JPEG release at
1951 milliseconds, title completion at 1957, cached pointer and observation
completion at 1959, and final cleanup with no pending diagnostic operations.
This passing candidate does not explain the earlier post-release delay or the
official-main CDP assertion. Both independent review axes remain unproven;
there is no combined acceptance, official-main merge or new release.

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

At the earlier local stage, a separate Mac interception diagnostic preparation
passed TypeScript
and 17 pure observer controls locally on Linux, without failures or skips. Five
intentional observer mutants each failed its selected assertion: receiver
preservation, duplicate-response history, unhandled asynchronous rejection,
absent-callback data access and callable `call` property access. These are mutant
controls, not reproduction of the historical Mac CDP failure. All 403 influential
files were restored or unchanged. Pure-check engine revision 14 binds source
`cd755832d7ac78dbc7c009c09e233c2675489b6f75049079b30c4fafb259981d`
and plan `220ee9ba8a75ab5902b2412cb7fff5557871a5996f9432d21f841de1a7c25f81`.
The local [passing-check manifest, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9),
[raw controls, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
and [mutant manifest, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
retain the actual receipts and raw output. At that local stage no actual Mac
fixture ran;
the Mac root cause, cleanup outcome and both independent review axes remain
unproven. This prepares evidence collection without changing support or acceptance.

The later source-bound Linux instrumentation fixture passed one selected test
with five assertions and no failures or skips. It admitted private POSIX connection
1 at 1994 milliseconds and observed the existing `Browser.getVersion` reply,
Chrome 154.0.8037.97, at 2020 milliseconds. Producer, observer, fixture, lock and
Playwright 1.63.0 core-bundle identities were retained; all 403 influential files
remained unchanged at the same source and plan hashes. The final trace reached
sequence 293 with 37 dropped records and no refusals, observer errors or sink
errors. Session-stop and broker-close settled, but fixture-stop remained pending
at its `before` boundary because the original fixture stop promise was not awaited.
This is bounded partial Linux chronology, not HTTP server cleanup, broader owned
process cleanup, actual Mac behavior or evidence of the Mac failure's cause.
The local [fixture manifest, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
and [trace classification, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/9)
retain actual raw JSON and receipts; the actual launched browser binary identity
remains `not measured`.

The separate installed-Windows startup diagnostic reached local engine revision
25 with TypeScript passing and 25 pure protocol/filesystem controls passing on
Linux, without failures or skips. All 286 influential source files remained
unchanged; its formal source hash is
`b0a5bc9acfb0277297fc93f772a8a189312ac889dfc95e7f2860207c78d23b09`.
The controls retain selected Bun producer identity, ordered endpoint/assignment
readiness, exact stop-attempt pairing and unknown attribution or cleanup states.
The earlier matched membership negative/positive comparison remains separately
retained. The matched R13 and R15 helper contrasts below now establish narrow
historical discrimination; R19 typed metadata retention is also contrasted below.
At that local stage actual installed Windows startup, lifecycle and cleanup
remained `not measured`, as did both independent review axes. Executable hashing
perturbs opt-in timing; its post-read threshold
cannot interrupt file IO, and disk bytes do not prove mapped-image identity.
The local [packet, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
and [raw controls, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
retain the exact measured scope. These diagnostic checks do not close the earlier
15-second endpoint failure, published-artifact acceptance or the native hold.

Subsequent matched pure-protocol controls now distinguish the historical R13
readiness helper from current source: four intended old-helper failures and four
current-helper passes used identical test SHA256
`92a273222da6a884dfa652e84de6d48b5abe98ab3e181b49e74982fe5f9eed81`.
R15 dual-origin binding separately produced two intended old-helper failures and
two current-helper passes using identical test SHA256
`fbd3e648005f24276e675cb8d935c1412ca16cf22795dd916e0ca47f77bb7cf1`.
Neither matched run skipped tests. All 286 current source bytes and modes were
restored or unchanged, preserving source `b0a5bc9` and the original R25 packet.
These are helper counterfactuals, not full historical-source or Windows runtime
measurements. The local
[R13 comparison, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
and [R15 comparison, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
link their preserved old failures and full raw logs. Actual Windows startup/cleanup
and both fresh review axes remain unproven.

The matched R19 typed producer metadata retention comparison also recorded two
intended old-helper failures and two current-helper passes without skips, using
identical test SHA256
`68a747c964d355d6ef1e72fefdfcd430bda8b7913eaf3fb480acf8c8335f8f5b`.
The [local R19 comparison, publication reference](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/11)
links both preserved raw results. Its scope is typed metadata retention only;
it does not prove actual Bun selection/reference, the new identity gate or hash
APIs through a historical comparison. Original R25 current-source positive
identity/hash controls and source `b0a5bc9` remain unchanged. Actual Windows
startup/cleanup and independent reviews remain unproven.

The current managed-lifecycle workstream fixtures executed 119 tests, skipped 20
and failed none; TypeScript exited zero. Independent specification and operational
reviews are still required after expanding source binding to include the invoked
installer and service adapters. Fresh review creation was unavailable at that
earlier checkpoint:
agent contexts reached their limit, the configured Codex CLI model was rejected
by the account, and Claude CLI authentication expired. That historical blocker
no longer describes the current fresh contexts. Earlier reviews cannot
prove the revised source. These fixtures do not establish actual macOS service,
Windows task or published installation acceptance.

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
| Fresh portable installation and real service/update lifecycle | Latest checkout-built archive smoke Limited; earlier service/path/package old/new fixtures in the [ledger](portability-verification.md#requirement-ledger) Limited. | Device evidence gap for published package and foreign systemd paths. Current Windows/macOS managed browser installation is measured in disposable CI; managed update adoption, activation and scheduling remain separate code/evidence gaps. | Published-release acceptance on fresh external hosts; disposable systemd broker/updater startup, configuration precedence, drift, restart, rollback and cleanup. CI installer `service: done` alone is installation state. See [updates.md](updates.md). |
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


## Current UI cleanup local evidence and PR20 provider failure

The fixture cleanup predecessor `1b0b43e51401aa6951852922ce820d2a677577ac` was published in [draft PR20](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/20), without main acceptance. The connection recovery successor is recorded below. Its isolated fixture cleanup checkpoint had authentic old controls with two pass and four fail, current six controls passing, thirteen product UI cases and two unchanged caller cases passing. The full local suite reported 915 pass, 49 skip, zero fail and 6048 assertions across 964 cases. Fresh independent specification and ownership reviews passed, and delegated local acceptance completed. This supports local cleanup hygiene only. The original Windows timing cause, skipped scope, native activation and final-main acceptance remain `not measured`.

The actual [PR20 provider run 37670328088, attempt 1](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37670328088) failed: seven jobs succeeded, while Windows and macOS suites failed. All nine checkout logs identify PR merge `424be14614f301984a7d63e83043e105c86fffa6`, merging the UI head into main `bbfb6b5b3892f920b798d212e2361d8907249c8d`. The authenticated 508218-byte log ZIP has SHA256 `8d7b581b4bf036dd261db006e89265b8e2300ae2d205ae3895d89a32f6f9c5b0`; all 111 members passed CRC verification. This is that PR merge measurement, not a final-main result.

Windows reported 643 pass, 317 skip, three fail and 4344 assertions across 963 cases in 437.59 seconds. Failures were the shared-suite real browser capture child missing its browser endpoint, abrupt broker death setup, and capture while a web font remains pending. Original raw log SHA256 is `2c63345012854e9eb98567e437f0d98e3439d3b8dc4a56b6eb47f79b12340e52`. The first two failures occur before the intended capture or broker death measurement; no browser cleanup defect or timing cause is inferred from them.

macOS reported 657 pass, 305 skip, one fail and 4384 assertions across 963 cases in 360.05 seconds. The selected-page focus case failed its initial paused-page readiness wait after an observed 3000 ms capture timeout. The later keyboard focus assertion was not reached. Original raw log SHA256 is `2b575302556f015199b00c1277218db2af98ac4ab22c3a4de6cfe17d46efbdef`. The underlying attachment, pixel or metadata phase remains `not measured`; cleanup hygiene does not establish the capture cause.

A separate [direct-head workflow run 37671161645](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37671161645) was dispatched once for exact UI head `1b0b43e51401aa6951852922ce820d2a677577ac`. Its verified terminal result is failure: seven jobs succeeded, macOS failed and Ubuntu was cancelled during Linux selection callback dependency installation. The bounded Ubuntu suite was skipped, so its test result is `not measured`. All nine checkout logs identify that exact head. The authenticated 378732-byte archive has SHA256 `aeef79ce8a91e94b0801df7f24ba5d6cae545de865299aeb591c5d346621ae2a`; all 110 members passed CRC validation. macOS reported 657 pass, 305 skip, one fail and 4367 assertions across 963 cases in 381.03 seconds. The Arabic lifecycle and page-selection assertion failed at product-ui.test.ts:500 and :569, receiving connected true while connected false was expected. The 307254-byte raw log SHA256 is `9e046da37a91bda1bd28fd3ec26e46b1c1556d68ded07d2ae5b561a0fe9d0996`. This connection-state failure is preserved separately from the earlier initial capture failure. Current provider and whole-platform acceptance remain open.


## Connection recovery successor and current execution limits

[Draft PR20](https://github.com/M7MMAD-OMAR/sbar-orbit/pull/20) now publishes `215d59df792b5706fab89b9413f98e3097bc48fa`, with parent `1b0b43e`. The two new paths are viewer/viewer.js and tests/viewer-polling.test.ts. The viewer marks a poll connected after observation and decoding complete and its poll error clears. A pending next frame therefore retains the prior disconnected state and visible capture error; healthy manual polling still recovers without requesting a frame. The genuine unchanged-old regression failed its assertion, while current polling passed all eleven cases with 44 assertions. Product UI passed thirteen English/Arabic cases. Related callers passed eleven cases with one existing Windows-only skip. The full local suite reported 918 pass, 49 skip, zero fail, 967 cases and 6061 assertions in 297.39 seconds. Original raw stderr SHA256 is `0a04476f2a9d3c911482102b65fa540180f2bbca364912aad19c3566d0a8660f`.

Both fresh specification and standards reviews passed. The corrected audit retained the actual successful caller child and its legitimate skip after the original wrapper rejected an incorrect zero-skip expectation. Seven new parser controls and thirteen source-bound retained execution audits passed. Delegated local acceptance completed before commit; publication continuity confirmed unchanged checkout source bytes. This does not claim another full-suite invocation. Git/ref and provider identity require downstream rebinding. [PR run 37681318320](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37681318320) completed with eight successful jobs and one failed Windows suite. All nine actual checkouts were synthetic merge `774326828aa1cbe0e1099c845340d799a903138d`, merging successor `215d59d` into main `bbfb6b5`. Linux reported 871 pass, 95 skip, zero fail; macOS reported 661 pass, 305 skip, zero fail; Windows reported 648 pass, 317 skip, one fail. The Windows workspace-presence test failed at tests/workspace-presence.test.ts:13 during initial loopback fixture navigation with `DEADLINE_EXCEEDED`, before presence, pointer or privacy assertions. The original browser timeout details and fixture request traces are absent, so the underlying navigation cause is `not measured`. The full log archive SHA256 is `d29f667242cdc3eb6d1db65a22613bf22ddbc34e15b80b8ae9dd50e2735245b8`; all 112 members passed CRC verification. These terminal observations do not establish full provider acceptance. Native activation, skipped scope and final main remain open.

The prior documentation head `b7c513aea79d2020e8de3c11262d6f6052a1ec14` had a separate [run 37673060886](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37673060886): eight jobs succeeded and macOS failed its Arabic connection-state assertion. All nine checkout logs identify PR merge `f5116d4a09288f1dbb12b761c68645c46090a725`. The authenticated 502909-byte archive SHA256 is `fa3d209b59a6efee08f8d8eeffd0e53f461b7ca65db44e6b038fa1e81d60ca5c`; all 112 members passed CRC validation. macOS raw SHA256 is `d68b7960777eaa5488b03027bde67e492c1c73a5ca1329418d197c9e15eb3f4e`, with 651 pass, 305 skip, one fail and 4340 assertions across 957 cases in 366.64 seconds. This is additional baseline evidence, not a repaired successor result.

Managed lifecycle XML candidate V10 remains unaccepted. Its twenty-six prerequisite gates passed, including genuine old malformed-XML failures and four current XML cases with 536 assertions. Its full-suite child reported 979 pass, 52 skip, zero fail and 6813 assertions across 1031 cases in 321.91 seconds, but the required source-stable gate rejected 36 newly generated Python cache entries with gate exit 82. Both fresh reviews failed on that missing valid full-suite gate. Original full stderr SHA256 is `1731000df967f2c1ea48c822aa35f099fa3f33184295a135a043dea92737e0ba`. The passing child result does not replace the rejected gate. A separate bytecode-isolated successor requires fresh evidence; I3, I4, I5, provider and final-main closure remain open.
