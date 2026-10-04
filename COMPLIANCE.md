# Viewer compliance and acceptance

Scope: viewer fullscreen, navigation and capture-error recovery. Reviewed 3 October 2026.
Source revision: working tree based on HEAD; evidence applies only to the scoped files tested.

## Sources and applicability

| Source | Type | Scope and constraint |
|---|---|---|
| https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API | Technical reference, reviewed 3 October 2026 | Use native fullscreen with a user gesture, handle rejection and browser exit. |
| https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:fullscreen | Technical reference, reviewed 3 October 2026 | Fullscreen layout must fill the viewport without stretching the captured image. |
| AGENTS.md and owner request | Owner acceptance | Do not stop the running broker or touch the person's browser. Keep navigation available. |

## Requirement register

| Requirement | Check | Status |
|---|---|---|
| Fullscreen viewport, transient controls, accessible sidebar, restored layout | Private Chromium viewer regression | Passed in the current layout regression |
| Transient capture error clears on recovery, preserves command errors | Private Chromium viewer regression | Passed in the current layout regression |
| Diagnostics and existing behavior | `bun run typecheck` and `bun run verify` | Typecheck passed; full suite 571 passed, 45 skipped, zero failed |
| Arabic and English, mobile and desktop | Viewer layout tests | Passed in private Chromium |
| Existing service continuity | No service stop/restart commands | Required throughout |
| Dependency and asset rights | No dependency or external asset additions | Not applicable to this change |
| Distribution, payments, jurisdictions | No distribution or payment change | Not applicable to this change |
| Other browser engines and native displays | Not measured | Release coverage limit |

## Acceptance command

`bun run typecheck && bun run verify`

Nonzero failures prevent scoped acceptance. Missing browser/native evidence remains not measured and prevents claiming those tiers. This command does not establish project-wide release readiness. No release or service restart is part of this task.

## Evidence, 3 October 2026

The command-error regression failed on the unfixed viewer: capture recovery hid
an unresolved command error. With separate command and polling notices, the
same private Chromium test passed with 53 assertions. Fullscreen, sidebar,
Arabic navigation and mobile layout remain in this regression.

Earlier affected tests passed, but their source hashes changed. Current typecheck passed. The complete bounded suite passed: 571 passed,
45 skipped, zero failed, 3730 assertions across 129 files. Skips retain their
original opt-in or platform requirements and are not native release evidence.
The redirect-failure negative test logged an expected server timeout and refused
the failed navigation. Previous full-suite Chrome startup failures are retained
locally; this current run completed without that failure.
Raw screenshots and local reports remain private and are not distributed.
Native displays and browser engines beyond Chromium remain not measured.

## Source binding

- `viewer/viewer.js`: `480cb7ae05ac347de7daede99b46357b3b5a4b8a4fb459438574d7f6d73233c5`
- `viewer/style.css`: `8a941bac02bea8ab4ad1629ad4333fb477a96affd50421e80a50cd09ac03e28b`
- `tests/viewer-layout.test.ts`: `4a56e32b9d04ff3a1791c981e239c696b5f2070a88009fcf46b3c48bae78b755`

## CI repair scope, 4 October 2026

Scope: the failing Ubuntu cleanup fixture, Windows viewer command interception,
and the navigation fixture's asynchronous image request. Existing viewer evidence
above is historical and does not certify these changes.

Sources reviewed 4 October 2026:

- https://playwright.dev/docs/actionability: technical reference for waiting on actual completion.
- https://docs.python.org/3/library/unittest.mock.html: technical reference for replacing display dependencies in an isolated cleanup fixture.
- AGENTS.md: owner requirements for bounded verification, private displays and honest evidence.

Acceptance: `bun run typecheck && bun run verify`, followed by all nine GitHub
Actions jobs on the exact pushed revision. No failed checks may be excluded.
Local evidence: typecheck passed. The viewer race failed before the fix with a
100 ms control-request delay, reproducing the Windows tab timeout. The
standard-library-only cleanup fixture failed before dependency isolation with
`ModuleNotFoundError: PIL`; its original cleanup negative control still fails
both assertions after isolation. Cleanup and navigation now pass locally.
The post-fix viewer run was blocked twice by RESOURCE_EXHAUSTED because other
Orbit sessions occupied the shared task budget. This is retained as blocked
evidence, not a passing viewer result. Remote run 37160046987 passed all nine jobs for revision
`78010a1ae24dcdfdb770e78f21f7f49c7e40a7c0`: Ubuntu 537 passed and 91 skipped;
Windows 408 passed and 220 skipped; macOS 418 passed and 210 skipped. Each
platform reported zero failures. Both installation and host registration
passed on all three platforms. These skips retain opt-in or platform coverage
limits and do not certify native owner-session displays.

Run: https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37160046987

The final production cold-start result will be recorded in the local
`output/ci-repair-acceptance.json` with exact source hashes and run URLs.
That report is generated only after all final-revision jobs have completed. Native display coverage remains not measured
unless its opt-in checks run. No deployment workflow exists in this repository.

### macOS cold-start workflow scope

The manual scheduling experiment reproduced a failure of the discarded
darwin-background policy on 4 October 2026. Production uses utility QoS.
The cold-start workflow will verify the current policy by default; an explicit
legacy comparison input preserves both old-policy arms, their deadlines and
nonzero exit on any failure. Legacy comparison evidence is historical research,
not current production acceptance. It must not be reported as passing or removed.
Production-only mode requires three successful real browser launches, navigation,
read and capture with verified non-background ownership. Its report explicitly
identifies its scope and contains no measured background ratio.

### Existing scoped prototype changes included for upload

The owner requested uploading all project changes. The existing launcher,
plugin and scoped enrollment probe were reviewed together. The bounded
`scoped_process_probe.py` passed against plugin SHA-256
`592f62e843466404365608419a7ca82ffa88cc8adf23be5c2fcbb55b45f0419e`.
It verified policy refusal, exact membership, process death, migration,
permanent revocation and cleanup. It opened no owner-desktop application.
The prototype's limits and prior private-compositor evidence remain in
`experiments/ghost-cursor/SCOPED-ENROLLMENT.md`. This upload does not claim
production native-display acceptance.

### Private native output readiness follow-up

Reviewed 4 October 2026 against KWin 6.7.5. The optional render-only device
selection uses the supported `KWIN_RENDER_NODES` setting documented in the
[versioned implementation](https://github.com/KDE/kwin/blob/v6.7.5/src/core/gpumanager.cpp).
It affects only the outer private compositor child. The lab now requires its
expected live output before reporting startup success and attempts cleanup even
if storing failure evidence fails. The standalone `lab_output_test.py` catches
the old evidence-storage cleanup failure and passes the fixed path.
Private GTK4 and Dolphin cursor recording and source-bound pre-map checks passed;
details and failed attempts remain in `experiments/ghost-cursor/PRE-MAP-PLACEMENT.md`.
Owner-display operation and comparative performance remain unaccepted and
unmeasured. This follow-up does not change production native support tiers.
