# Product interface evidence

## Accepted combined integration

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

Fresh local UI review covered English and Arabic at 1440x1000 and 390x844,
all 20 lifecycle cells, eight settled optional cells, four visibly held capture
errors and actual recovery, with matching interaction receipts. These private
fixtures do not measure physical devices, assistive technology, owner accounts
or participant acceptance. Provider synthetic nine-case child reports passed
separately from the actual private-browser parent reports: 320x240, one page
and nonempty image bytes. Their child stdout and parent JPEG bytes are not
separately archived, so report metadata cannot establish image-content review.
Faithful settings wording intentionally changes the abbreviated baseline layout.
New lifecycle states use the interaction contract without old-state pixel references.
Mobile saved/refused framing scrolls the focused switch offscreen; the focus
claim comes from executed DOM assertions and receipts, not a visible focus ring.
No accessibility scanner or assistive-technology acceptance is claimed.

## Historical combined integration before acceptance



The current integration combines prior product source
`bdfa5ec0463920912a66c3623ca3866e9a81f514` with official main
`c98dce1f05a8b2fe47dcb5403f04715fe6ba47e3` through a normal merge. It preserves
the accepted pipe diagnostics and the product interaction and capture changes.
A preparatory typecheck passed. Fresh validation of this combined source,
including its private UI captures and independent reviews, remains pending.
The combined product checkpoint is not accepted.

The prior product draft PR15 passed all nine CI jobs in run `37606331848`,
using source tree `6b60be801ffc394cc417bbdb96ce736669cf13f3`. That run predates
this combined integration and does not certify the newly combined source.
Its separate child controls and actual private-browser parent capture remain
historical evidence for that exact prior source.

The current plan preserves all nine product checks and adds fresh pipe receipt,
controlled timeout, five semantic negative and original observe/list checks.
The typecheck and complete suite cover both workstreams. The combined local
suite projection is 958 parent cases, with the same 49 explicit skip cases and
909 executed cases. This projection must match actual named cases before it
can become a measured result. Fresh English and Arabic captures, all 20
lifecycle cells, eight settled optional cells, four visibly held capture errors
and actual recovery, current Linux/Windows/macOS CI, and independent UI,
specification and standards reviews are required before acceptance.

The historical Windows exit 143 cause, full cleanup, browser executable
identity, participant acceptance and native activation remain unmeasured.
The native compositor crash hold remains unconditional.

## Historical snapshot before the combined integration

The following snapshot and all earlier records are preserved as history for
their original source. Statements about pending checks, publication or image
counts below describe those earlier snapshots.

## Historical integration and evidence limits before PR 15

The latest verified local runtime integration is
`eea17c15c9b8590acd41fb451e7c656d90951bd8`. It combines the product changes
and the reviewed controlled JPEG publication registration with official main
`85051a46f409052ce9a95de06a973e111ede8f9d` through a normal merge. A bounded
TypeScript check against that local integration exited zero. The product
integration has not been published or accepted. The current merged source has
987 influence files and 29 owned task paths.

Fresh product checks against the merged source remain pending. They must include
the focused interaction tests, the isolated nine-case cross-contract child and
its separate real private-browser parent control, both 32-case admission routes,
the 12 semantic mutants, the stopping case, verified historical discriminators
and the full suite. Full-suite totals projected from the source are not measured
results. The current integration also needs 66 fresh images with matching
interaction receipts, all 20 lifecycle state cells, eight settled optional-viewer
cells, four visibly held capture-error cells and the subsequent actual recovery.
Fresh independent UI, specification and standards reviews must use the current
source and plan. Literal P7 still requires actual fresh Linux, Windows and macOS
CI before acceptance; an earlier CI run or local pass cannot satisfy it.

Two retained local histories explain why earlier passes cannot certify this
integration. Source `0890533` passed its eight planned gates, but its later full
suite actually recorded 860 pass, 49 skip and 13 fail. The process-global
cross-contract launcher mock affected ordinary private-browser factories. The
successor isolated the unchanged nine cases in an owned child and added a real
parent capture control. The later source `366dcf9` epoch passed types, build,
focused, cross, admission and mutant checks. Its stopping command exited zero
but emitted no pass/fail/Ran summary, so the gate correctly failed at revision
81. That failure remains retained; its cause is unknown. Integrating main's
framed trace retention does not itself prove that failure repaired. The prior
full-suite failure and this later stopping failure are separate observations.

The earlier 49-image review and its error-state screenshot claims below are
superseded historical records. Later review found that early lifecycle/error
images did not prove the state claimed at capture time. Those earlier images
and table entries cannot establish the current visible state, current review
approval or acceptance. Later held-error and framing corrections have their
own retained evidence, but fresh merged-source captures and reviews remain
required. The historical snapshot is preserved to show what was recorded,
including claims that were subsequently rejected, rather than erase them.

The native hold and external participant/device acceptance gates remain open.
No private fixture result establishes the person's settings, account lifecycle,
assistive-technology behavior, published-package behavior or participant
acceptance. The [product contract](product-contract.md) identifies the actual
owners and limits; [completion status](completion-status.md) records the wider
closure work.

## Historical product workstream snapshot

The remainder preserves an earlier scoped workstream record. Its source hashes,
test counts, image counts and recorded states describe that earlier snapshot.
They are not the latest integrated evidence or current acceptance. In particular,
`Fixture passed` in the table is a historical recorded label, not a renewed claim
that an early screenshot faithfully demonstrated its stated lifecycle/error state.

Workstream base: `56fd8f318c5ec2aaded827a8be89387bf54579f1`. This is a scoped
product repair and audit, not official integration, publication or participant
acceptance. The [product contract](product-contract.md) names the actual owners
and boundaries. The [platform closure contract](platform-closure.md) retains the
complete objective and unconditional native hold.

## Baseline source and defects

The preserved detached checkout of [baseline 56fd8f3](https://github.com/M7MMAD-OMAR/sbar-orbit/commit/56fd8f318c5ec2aaded827a8be89387bf54579f1)
contained that commit's production source plus new tests. On October 6, 2026,
the authorized bounded run of `tests/product-ui.test.ts` and
`website/tests/locale.test.tsx` executed 17 tests in 29.00 seconds: 8 pass,
9 fail, zero skip. Failures caught missing settings names, settings save focus
loss, absent radio arrow-key interaction and page-selection focus loss in both
languages, plus the universal Linux socket export in public guidance. Failure
logs include the actual controls, expected focus and missing behavior.

The baseline public page rendered in English and Arabic at 1440x1000 and
390x844 with no horizontal overflow. Skip-link, mobile menu/Escape and copy
status checks passed. Passing presentation checks did not make the incorrect
platform commands or support copy acceptable.

The coordinator's private evidence archive retains the complete log, SHA256
source/test manifests and captures. `baseline.log`, `focused-wrapper.log` and
`baseline-settled-source.json` distinguish the regression source from the final
interaction checks and corrected reference captures.

## Historical architecture and interaction matrix

Before this documentation update, the source-bound focused run passed 40 tests
with no failures or skips in 62.98 seconds. TypeScript and the website build
exited zero. Independent source and UI reviewers inspected the interaction
receipts and 49 images. The recorded working-tree scope hash is
`9bcc09eb32b27d50765c3ffe90bfb023a547fbe63de7c226a09a5a493971ca9c`;
it is not a Git commit or a published-artifact measurement. Documentation changes
require fresh gate binding before integration.

`Fixture passed` means the specified disposable fixture ran. It does not establish
actual platform settings, account lifecycle or participant acceptance. Stable old
settings references and retained guide references support the matched comparison;
no old lifecycle pixel comparison is claimed.

| Deliverable | Real owner and interaction evidence | Baseline | Historical recorded state |
| --- | --- | --- | --- |
| Entry points and first task | Installer selector, `connector-config`, managed socket default and optional `preview`; public guide stays readable without JS | Public rendered checks pass; universal Linux socket guidance fails | Fixture passed: platform choice, Windows command, common preview and Limited copy; no-JS Windows selection not measured |
| Task/session/account hierarchy | Broker session ID and supplied identity labels; one rail; account save is explicit while paused | Existing contract/source retained | Owner map reviewed; actual account lifecycle not measured |
| English/Arabic and responsive hierarchy | Actual prerendered website and viewer assets inside private Orbit browsers at 1440x1000 and 390x844; RTL image coordinates remain LTR | Both public layouts render; both settings layouts captured | Fixture passed; stable settings and guide references reviewed |
| Keyboard settings | Localized control names/descriptions, one radio Tab stop, arrows and save/refusal focus | Six discriminating failures across two languages | Fixture passed: names, focus restoration and radio keys |
| Settings error recovery | Failed disposable schema load followed by keyboard retry; no real owner's config touched | Newly expanded fixture | Fixture passed: visible reason and keyboard retry |
| Browser lifecycle and navigation | Private broker session, keyboard takeover/resume, manual text, agent paused refusal, page selection, readback and stop | Page-selection focus fails in both languages | Fixture passed; final empty/running/takeover/error/finished frames and broker receipts reviewed |
| Busy and capture recovery | Delayed pause request disables controls; one injected capture error recovers on next successful poll | Retained existing viewer-layout contract | Fixture passed: scoped live state checks |
| Optional viewer | Preview link opens nothing; viewer navigation/close leaves the same private session usable | Retained preview contract | Fixture passed: exact readback before and after viewer close |
| Workspace image and pointer geometry | Existing preview coordinate readback and viewer-layout aspect/RTL checks | Existing source contracts retained | Existing geometry fixtures passed against fixed source |
| Non-Linux mark settings boundary | Disposable subprocess simulates darwin/win32 and traps every interpreter spawn | Both old-source controls failed | Fixture passed: UNSUPPORTED before spawn; real OS settings not measured |
| Independent architecture/UI review | Fresh reviewer inspects actual current source, contracts, captures and interaction receipts | Independent source audit identified concrete defects | Scoped source and UI reviews passed before this documentation update; full architecture acceptance remains open |
| Participants and external devices | U1/T1 through U12/T12 and failure gates | Not measured by this workstream | Open; automation does not certify acceptance |

No native preparation, plugin load, borrowed input or owner-desktop action is part
of these checks. Simulated operating-system refusal is not a real macOS/Windows
UI measurement. Private fixture results cannot establish published-package,
account, assistive-technology or participant acceptance. The complete product
objective remains subject to the external gates in [completion-status.md](completion-status.md).
