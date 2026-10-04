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

### Native prepared-host transport

Reviewed 4 October 2026. Native endpoint preparation now lives in
`src/native/host.py`; the experimental command remains a compatibility wrapper.
The transport binds journaled plugin actions to that prepared process, socket
identity and compositor ABI. Linux peer credentials follow the
[unix(7) specification](https://man7.org/linux/man-pages/man7/unix.7.html).
The request framing follows the
[versioned Hyprland IPC implementation](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/debug/HyprCtl.cpp).
These are technical compatibility constraints. Private ownership, durable
intent/outcome records, protected approval and no owner-seat interference are
owner requirements. The transport remains cooperative same-user code.
It does not install the plugin, enable owner-session use or replace the final
BAR.md acceptance. Current checks and remaining integration work are recorded in
`experiments/ghost-cursor/NATIVE-TRANSPORT.md`.

### Native application launcher integration

Component implemented and privately measured, reviewed 4 October 2026. See
`experiments/ghost-cursor/NATIVE-LAUNCH.md` for source-bound evidence and limits.
The launcher uses the existing Linux
child supervisor and a generated exact native scope. Subreaper behavior follows
[Linux man-pages 6.19](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).
Application buses must start after scope attachment, and application exec must
follow token enrollment. The public launch entry point must honor protected/full
admission and durable intent before creating application processes. Owned cleanup
must still run if its journal cannot be written. Owner-display activation,
appearance acceptance and comparative performance remain unmeasured; passing
launcher checks will not close those requirements.

### Native session routing integration

Component implemented and privately measured, reviewed 4 October 2026. See
`experiments/ghost-cursor/NATIVE-SESSION.md` for evidence and limits. It owns its admitted application handles and expose only generated application and
window identifiers. Foreign compositor windows must be filtered before returning
metadata, and target identity and exact scope must be rechecked before delivery.
Capture must require an owned stable window ID with no whole-display fallback.
Agent requests must not configure protected/full mode or choose a compositor.
The pinned Hyprland IPC implementation above remains the compatibility source.
Private routing evidence does not authorize owner-session activation or close
BAR.md, appearance or performance acceptance.

### Native target viewer integration

Component implemented and privately measured, reviewed 4 October 2026. See
`experiments/ghost-cursor/NATIVE-VIEW.md` for current evidence and limits. The
GTK 3.24 drawing API follows the official
[DrawingArea documentation](https://docs.gtk.org/gtk3/class.DrawingArea.html).
This is a technical API reference, not a platform permission requirement.
The viewer displays only supplied target frames and draws the acknowledged agent
cursor at logical surface coordinates. It has no capture or input delivery path.
Updates are event-driven, queued frames are coalesced, image dimensions are
bounded, and source EOF closes the view after its final draw. Public broker
wiring, live owner activation, theme acceptance and comparative performance
remain unaccepted.

### Public native broker integration

Component implemented and privately measured, reviewed 4 October 2026. See
`experiments/ghost-cursor/NATIVE-BROKER.md` for source hashes, reproduction,
failed attempts and explicit limits. Native backend activation must use a
fixed prepared plan and control directory supplied by the owner at broker startup,
never paths or mode changes from agent session requests. The broker adapter must
preserve exact target ownership, protected/full admission, durable native outcomes,
bounded framing and mandatory cleanup on worker or broker death. The public
protocol will expose explicit native target handles and capabilities without
changing the existing private-display alias. Development runs use a separate
broker inside the lab. Owner activation, complete matrix and performance remain
unaccepted until their source-bound checks run.

Official technical references reviewed 4 October 2026:

- https://nodejs.org/api/child_process.html: Node.js 26.10.0 framing, stream and child close API reference.
- https://bun.sh/docs/runtime/nodejs-compat: Bun runtime compatibility reference, currently 1.4.2. The actual measured runtime is Bun 1.3.14; compatibility is established only by the checks run here.

No dependency or externally sourced asset was added. The public broker private
proof passed seven checks and the native view EOF proof. Owner activation and
comparative performance remain not measured. Native bounded network origins are
explicitly unsupported and refused at creation and narrowing. The lifecycle
negative control failed both checks before restoration; the fixed worker passed
seven tests with 22 assertions. Current typecheck passed. The bounded full suite passed: 594 passed, 46 skipped,
zero failures, 3,820 assertions across 640 tests in 140 files in 185.93 seconds.
Platform and opt-in skips retain their original scope limits. The staged public
audit checked 852 files with no findings. Final staged secret validation is
recorded below. Both review axes report no remaining actionable component
findings. The managed service was not restarted, and the private lab and owned
short disk workspaces were removed after the final successful proof.

Final staged Gitleaks validation found no leaks. Publication is an authorized
draft source update, not installation, owner-session acceptance or release.

### Live GTK broker view and bounded capture replay

Work in progress, reviewed 4 October 2026. Owner request requires a visible native
agent cursor and live application viewing, with explicit cleanup and measured
performance. Add an explicit CLI native view path backed by target-only broker
observation. Keep one in-flight capture/frame and wait for actual GTK draw before
sampling again. Window closure must stop new capture requests and release the
owned viewer without stopping another session. Avoid retaining every image in the
worker reply cache; expire older image replay explicitly while preserving request
fingerprints and mutation replay. Verify current protocol, actual GTK rendering,
window/EOF cleanup and a negative cache-growth control inside the private lab.

Technical references: https://nodejs.org/api/globals.html#static-method-abortsignalanysignals
and https://nodejs.org/api/child_process.html, reviewed 4 October 2026. GTK 3.24
DrawingArea documentation remains the rendering reference. Abort of a client
request does not promise cancellation of an already admitted broker capture;
server capture cleanup retains its existing bound. No owner-display activation,
zero-overhead or comparative-performance claim follows from this component.

Current private proof passed eight public broker checks, including three actual
GTK draws with changed fractional cursor positions, then owned process cleanup.
Five client/cache wrapper tests passed with 20 assertions. The direct cache
helper passed two tests; the saved unfixed worker fails its later-capture and
mutation check after exhausting the image cache. Source hashes, failed attempts
and remaining acceptance limits are in
`experiments/ghost-cursor/NATIVE-LIVE-VIEW.md`. Current typecheck passed. Full
suite and exact staged publication validation are pending below. No owner
desktop activation or managed service restart was performed.

### Visible session cleanup failure and Windows transient locks

Reviewed 4 October 2026 before implementation. GitHub run 37173758353 on
revision dc16174009cd4de8e0427a620762f4ca6e703ba4 passed eight jobs but failed
the Windows suite's owned-profile removal check: session.stop returned while
profile-lYdQ7A remained. Existing removal paths suppress filesystem errors.
Use the supported bounded fs.rm transient-lock retries on Windows, propagate
persistent removal failure from stop, and retain failure diagnostics on unexpected
exit. Do not lengthen the test's assertion timeout or exclude the check.
https://nodejs.org/api/fs.html#fspromisesrmpath-options is the technical reference,
Node.js 26.10.0, reviewed 4 October 2026. Remote Windows remeasurement is required;
a passing Linux check cannot certify Windows handle-release behavior.

The first live-view full suite also failed the diagnostic-code completeness
check because the new bounded client throws BROKER_ERROR explicitly. Add that
real code to the diagnostic allowlist rather than bypassing its check.

The final cleanup checks include removal-only failure and simultaneous owned
clone-release/profile-removal failure. The saved unfixed session source fails
both intended assertions; the fixed source preserves the original release
error and EACCES in AggregateError. The combined current cleanup/client/cache
checks passed 11 tests with 82 assertions. The final source-bound private broker
proof passed eight checks and normal/immediate GTK source EOF. Both review axes
have no remaining scoped actionable findings. All lab processes and owned short
workspaces were removed. Windows CI verification remains pending until the
updated source is published and measured remotely.

Final current local validation: typecheck passed. The bounded full suite passed
601 tests, skipped 46, failed zero, with 3836 assertions across 647 tests in
142 files in 190.73 seconds. Platform and explicit opt-in skips retain their
scope limits. This replaces the earlier failed diagnostic-completeness run;
that failure is retained and documented above. No comparative performance or
owner-display acceptance follows from the suite. Exact staged publication
audits are recorded after they run below.

The staged publication audit checked 858 index files with zero findings.
Staged Gitleaks found no leaks. Graft was refreshed deterministically after
the code changes. Publication remains an authorized draft source update,
not owner-session activation, complete BAR.md acceptance or a release.

### Cross-platform CI failure diagnosis on a7673ad

Reviewed 4 October 2026 before further changes. GitHub run 37175889848
completed with seven jobs passing, macOS suite failing one viewer-layout
timeout, and Windows suite failing browser navigation timeout and two EBUSY
profile deletions. Those failures remain retained in private logs and are not
certified as fixed. Add boundary/timing-only diagnostics to the viewer layout
check without changing its 60-second bound, assertions or test coverage.

The Windows runner uses Bun 1.4.2+744846f84. Its exact upstream source
https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/node/node_fs.rs
parses maxRetries/retryDelay but recursive rm invokes zig_delete_tree once and
returns its error. Its fs.promises wrapper forwards directly:
https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/js/node/fs.promises.ts .
The runtime documentation https://bun.com/reference/node/fs/promises/rm
describes Node retry semantics; that declaration does not establish Bun's
actual implementation. CI deletion checks ended before the requested 3.6-second
backoff could elapse. Replace the ineffective option with an explicit bounded
Windows transient-error loop, preserving permanent failure and both cleanup
errors. Add a real Windows locked-directory negative control and verify release
while the loop waits, with persistent failure still refused. No ownership,
profile, policy, operation deadline or production support scope is broadened.
Remote Windows and macOS measurement remains required.

The root/dependent file actually holding the Windows lock is not identified:
Bun attaches the supplied root path to recursive child deletion errors too.
The existing Windows browser stop waits for the root process, not an explicit
all-descendants exit measurement, and that lifecycle evidence gap remains open.
The retry test covers an owned directory held as a disposable child cwd; it
does not attribute the Chrome lock. Its teardown waits after forced kill,
attempts independent cleanup and aggregates proof/cleanup failures.

Current local targeted validation passed eight tests, skipped the two Windows
lock cases, failed zero, with 123 assertions. The current private native broker
proof passed its eight checks and both source EOF paths again after the retry
change. Windows lock behavior and macOS timeout location are still not measured
on the updated source until the next remote run.

Current retry/diagnostic revision: typecheck passed; full bounded local suite
601 passed, 48 skipped, zero failed, 3836 assertions across 649 tests in 143
files in 181.20 seconds. The two additional skips are explicitly Windows-only
lock cases, not successful Windows measurements. Source-bound native viewing
passed again and its lab/short workspaces were removed. Staged publication
validation and replacement remote CI results are required below.

Publication audit checked 859 staged files with zero findings. Staged Gitleaks
found no leaks, and Graft was refreshed. The exact final index is checked again
by the commit hook. This is an authorized diagnostic/runtime draft update,
not a release or cross-platform acceptance.

### Native owner controls runtime entry

Reviewed 4 October 2026 before implementation. Promote the measured GTK4
settings preview into runtime source and expose an explicit native-settings
owner CLI. Require the same fixed absolute ORBIT_NATIVE_CONTROL and
ORBIT_NATIVE_PLAN configuration as the native broker; refuse unconfigured,
relative or non-private control storage before opening the UI. Configuration
paths and protected/full choice remain absent from agent RPC capabilities.
Use the existing shared resource budget and durable ActionControl journal,
one-use exact approval, visible storage errors and cancellation on window close.
The guarded experimental preview becomes a thin adapter to the same runtime UI.
Measure the public CLI in the private lab through accessibility with mode
roundtrip, exact approval replay refusal, corrupted journal refusal and close
while the lock is held. Owner activation remains the final consented acceptance
step; no owner display or service is touched during development.

Official references reviewed: GTK API 4.0, documentation library 4.23.4:
https://docs.gtk.org/gtk4/class.ApplicationWindow.html and
https://docs.gtk.org/gtk4/class.CheckButton.html . Main-thread updates use
https://docs.gtk.org/glib/func.idle_add.html . Installed GTK version and
source-bound results will be recorded after measurement. No asset or dependency
is added. UI Skills routing selected the Rams checklist for labels, native
keyboard navigation, text status, disabled/error states and layout; its web
checks are heuristics adapted to GTK, not a claim of complete WCAG certification.

Previous source revision 9a82eeb37cdffd5b8399d5fdce6adf4e1088e858 passed all
nine GitHub jobs in run 37176817702. Windows real lock controls passed both
release and persistent refusal cases; original rm retry options rejected in
zero measured milliseconds. The previous macOS viewer timeout did not recur,
but its original cause remains unidentified. This does not certify owner
activation, theme matching, full Windows descendant-exit cleanup or performance.


Runtime native owner controls measurement: the actual public CLI passed exact
one-use approval/replay refusal, protected/full roundtrip, damaged journal
refusal, exclusion of settings as an agent target and close under lock. GTK
4.22.5 and system Python 3.14.7 were used in the private lab. The target-only
screenshot was visually inspected. Source hashes and limits are recorded in
experiments/ghost-cursor/NATIVE-SETTINGS-RUNTIME.md. Owner activation and theme
acceptance remain not measured.

The initial three CLI refusal tests failed because they read stdout instead of
stderr. After repairing the tests, all three pass with nine assertions. Review
also identified root-only probe cleanup that could leave the GTK child when Bun
is killed first. A forced-parent-death fixture passes with unique launch-tag
and retained process identity cleanup. Restoring root-only termination in a
temporary source copy reproduces the surviving-child failure. Lab shutdown
removed that negative-control child; both new labs and temporary source were
removed. The diagnostic log closes independently of cleanup errors.

Typecheck passed. Staged public audit checked 863 files with zero findings;
Gitleaks found no leaks. Graft was refreshed. Full local suite and publication
results follow when their commands reach terminal status.

Final local runtime-owner-controls suite: 604 passed, 48 skipped, zero failed,
3846 assertions across 652 tests in 144 files, 183.27 seconds. The platform
and opt-in skips are not measurements of their skipped capabilities. Remote
checks on the published revision remain pending until observed terminal.

### Native live cursor recording

Reviewed 4 October 2026 before implementation. Extend the private public-broker
probe with an optional target-only recording of its actual GTK live view. Keep
its existing behavioral checks unchanged, bound capture count and subprocess
deadlines, and record real capture timestamps rather than calling a sampled
preview input latency. No owner display capture, input or activation is allowed.
The recording shows the acknowledged cursor drawn in the native GTK view; it
does not establish the compositor overlay's owner-display click-through.
Official recording reference: https://ffmpeg.org/ffmpeg-formats.html#image2
reviewed 4 October 2026, locally installed FFmpeg 8.1.2. PNG-frame encoding is
used only in the private evidence producer, not the installed runtime. Preserve
the captures, inspect decoded motion and retain errors before claiming evidence.

Recording results: current source-bound public broker proof passed all eight
checks plus normal/immediate view EOF supervision. Its 11-frame APNG retains
identical decoded RGBA captures, and its isolated teal marker moves between
the acknowledged positions. The old whole-image motion check accepted a
no-motion fixture because unrelated repainting changed pixels; the replacement
marker check rejects it. The old RGB comparison also ignored alpha-only
changes; exact RGBA bytes now reject those. Both review findings are fixed.
Final-path recording is published only after validation.

Initial lab startup omitted virtual input devices and failed before viewing.
Its generic worker error was retained, but cleanup removed the detailed worker
log. The updated probe preserves the lab control journal, and the next run
identified target has no pointer resource. Adding only the private lab devices
resolved that precondition, and the final recording passed. The lab and its
processes and temporary negative sources were removed. Owner activation,
compositor click-through acceptance and performance remain not measured.

### Renderer crash diagnosis

The current full bounded suite failed four browser viewer cases with Target
crashed/Page crashed, and one isolated browser-scroll case reproduces the crash.
Slice OOM and pids-max counters did not change during the isolated run; memory
high events increased. High shared usage is observed, but an OOM or pids limit
cause is not proven. Two foreign Hukm sessions remain open. Permission to stop
these specific current sessions is pending; the previous five-session stop
authorization is not reused for them.

Before implementation: retain the existing bounded Chrome stderr diagnostic
when a renderer page crashes while its browser stays running. Watch existing
and later owned pages through the supported Playwright crash event, record no
page URL or document data, change no assertions or deadlines, and do not retry
or suppress the failed action. Official Page crash event reference reviewed
4 October 2026: https://playwright.dev/docs/api/class-page#page-event-crash ,
installed Playwright 1.63.0. This is diagnosis, not a claimed crash fix.

The added renderer observer was tried in one isolated run. The owned browser
instead exited with code 0 before the observer could attribute a renderer crash;
its retained stderr tail contains SSL handshake errors, not an identified
crash cause. The diagnostic patch was reverted and retained privately. No
production renderer change or resolved-cause claim is included. The failed
full suite and isolated runs remain recorded. Publication of this increment
is pending these failures and pending resource permission.

The recording at probe hash 88896c3f is verified. A subsequent private-evidence
retention change aggregates artifact-copy errors with the original proof error
rather than masking it. That additional cleanup-error path is implemented but
not yet exercised, so the recording's earlier source binding remains historical
for that change. Fresh proof and final gates are required before publication.

Further browser diagnosis, 4 October 2026: source remains unchanged. A private
copy of the failing browser-scroll fixture will request Chrome's supported
per-profile log file for its own headless viewer, retain that log before
cleanup and keep all original assertions. This observes only a newly created
private profile. It does not touch foreign sessions or the owner's browser.
Current slice memory is about 7.2 GB; launching remains subject to its existing
headroom admission and bounded resource limits. The earlier resource request
is still pending, not permission to stop the current Hukm sessions.

The private diagnostic fixture's first invocation matched no Bun tests because
its path lacked the explicit ./ prefix. The corrected explicit path ran and
failed navigation with net::ERR_INSUFFICIENT_RESOURCES. Logging references were
checked against https://www.chromium.org/for-testers/enable-logging/ on
4 October 2026. Only newly created private profile logs were read, and logs
remain private. This is a resource refusal result, not proof of which resource
failed. Slice usage remained around 7.2 GB with unchanged task-limit/OOM counters.

The lower-footprint native lab proof remains useful independently of browser
acceptance. Next run exercises the final recording/error-retention source,
including an injected evidence-copy failure combined with a no-motion proof
failure, and then removes that private lab. It does not waive the failed
browser gate or imply permission to stop foreign sessions.

### Owned Linux Chrome temporary storage

Before implementation, 4 October 2026: tmpfs user quota is at its 12715 MiB
hard limit although df reports free blocks. A fresh native probe failed to
write host.json with EDQUOT. The unchanged browser-scroll fixture fails with
the default temporary path, fails with Chrome's explicit SingletonSocket
path-length diagnostic under a long private TMPDIR, and passes all 12 assertions
with a short private disk-backed TMPDIR. No resource limit or foreign session
was changed. This provides a concrete temporary-storage diagnosis.

Linux Chrome currently passes --disable-dev-shm-usage. Chromium's official
file_util_posix.cc GetShmemTempDir falls back to GetTempDir under that switch;
GetTempDir reads TMPDIR before /tmp. Reviewed 4 October 2026 at main blob
3c9b141c66da18cd56bb2384597366d2a6914a91:
https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/files/file_util_posix.cc
Linux tmpfs quota reference, reviewed 4 October 2026:
https://docs.kernel.org/filesystems/tmpfs.html . usrquota enforces a per-user
block limit distinct from total free blocks. No quota, mount or memory limit
will be changed.

Create one short private disk-backed temporary workspace per Linux Chrome
launch using the existing validated workspace allocator. Pass only that owned
path as its TMPDIR, and remove it after owned process shutdown or failed
startup. Preserve both startup and cleanup errors. macOS/Windows paths remain
unchanged. Verify inherited long TMPDIR refusal on unfixed code, actual child
path/permissions on fixed code, cleanup on success/failure and the previously
failed browser cases. This is a quota/path-length correctness fix, not measured
performance improvement.


### Owned Linux Chrome temporary storage, verification on 4 October 2026

The original four-file browser regression group passed unchanged with a short disk-backed TMPDIR: 6 tests, 114 assertions, no failures. The default fixture TMPDIR remained quota-exhausted: account persistence and monitors.json writes reported EDQUOT. This environment change selects temporary storage only; slice limits, quota, mounts, browser assertions and deadlines were not changed.

Two new process-level tests failed against the unchanged published Chrome launcher, then passed against the new launcher. They cover failed startup cleanup and actual Chrome rendering despite an inherited path longer than the Unix socket limit. A third test forces EACCES on temporary deletion after an automatic browser exit and verifies close listeners still run, explicit close retains the error, and automatic cleanup logs the failure. The review identified and corrected that notification ordering before release.

Scope: this change owns the Linux launch supervisor's temporary directory. The network namespace wrapper still deliberately sets its own isolated TMPDIR to /tmp; its filesystem and isolation policy are unchanged. Disk storage uses the existing private, owner-validated allocator. No performance improvement is claimed from these tests.

The fresh native recording attempt failed with EDQUOT in private GTK/dconf/icon-loader runtime files. Evidence retained in native-broker-3380681.log and .private/native-recording-current.log. The previous recording is historical; current recording and injected retention-failure proof remain not measured. The lab is being shut down. The five older sessions authorized for stopping were verified closed; two newer Hukm sessions remain untouched.

The first full suite run with a globally relocated TMPDIR failed: 602 passed, 48 skipped, 5 failed, 655 tests. Sway socket transport and two GTK mount-policy fixtures require /tmp paths, while two restore fixtures require a non-btrfs temporary filesystem. A globally changed test filesystem violates those fixture assumptions. This diagnostic run is retained and is not acceptance evidence. After the task-owned lab shutdown freed a small amount of tmpfs quota, the unchanged default verification command is being run against the scoped Chrome fix.

Default verification completed successfully: `bun run verify`, 607 passed, 48 skipped, 0 failed, 3859 assertions, 655 tests across 145 files, 182.28 seconds. Evidence: `.private/chrome-owned-temp-default-verify.log`. Native display checks remain outside this default command. Typecheck passed. The private lab was confirmed absent after shutdown; only the exact task-owned diagnostic browser profile was removed after its recorded browser PID exited. No newer foreign session was stopped.

Source binding for this scoped Chrome correction:
- `src/chrome.ts`: `9bc34e61bdf66c93c1a00468fe3e0dc1de0211602073632bdf0579c3f16bb125`.
- `tests/chrome-temporary-storage.test.ts`: `25cca6ef79c785a9062fb6eee86e2fa315bc450fe92b12a9e3264ac2c7f9852c`.

Scoped publication checks: public index audit inspected 864 files with no findings; staged Gitleaks found no leaks; git diff whitespace checks passed; Graft was refreshed. Both read-only review axes confirmed the temporary-removal notification fix with no remaining actionable findings in this scope. This is a draft source publication, not owner desktop acceptance.


### Recording marker variant correction, 4 October 2026

The fresh native lab was prepared and the pinned plugin loaded. Two setup attempts failed because the private pointer helper was invoked without its documented numeric arguments and hold mode; retained native journals reported target has no pointer resource. The helper source at person_pointer.c:37-117 defines four numeric arguments and optional hold, with the Wayland socket supplied through guarded lab environment. Correct setup then reached real live recording and failed the marker assertion. Visual inspection shows a blue agent marker, not the teal marker assumed by the probe. NativeSession deliberately chooses variant 0 or 1 from the target address, and the GTK renderer draws each variant with a different fixed accent.

Before implementation: bind the marker detector to the actual initial view-frame cursorVariant, require the valid variant, retain the isolated-marker size bound and all movement/RGBA checks. Do not accept arbitrary page repainting or weaken the no-motion requirement. The next proof must include no-motion rejection and combined primary/retention failure preservation. This changes private evidence tooling only; owner activation and performance remain not measured.

Variant-aware native recording passed on the c32efa3 runtime checkout with probe SHA256 4b189157b8bc7d0b227ebace569225271ec30fadef6f1778b0516be0550a5d1e: eight actual broker checks, three acknowledged GTK draws, 11 actual target captures, 24569-byte APNG, exact decoded RGBA equality, blue variant 1, isolated marker movement from (549.5, 100) to (703, 167). Real capture timestamps are retained. The APNG first and last frames were visually inspected; the Codex artifact preview was queued. Native cursor full projected-vector magnitude and owner activation remain not measured.

The fresh no-motion plus injected control-evidence collision test exited nonzero and retained both the movement assertion and FileExistsError in one ExceptionGroup. Alpha-only mutation of an actual decoded recording frame preserves RGB bytes but fails exact RGBA equality. Logs are retained in .private/native-recording-no-motion-retention.log and .private/native-recording-alpha-control.log. NATIVE-LIVE-VIEW.md has been corrected to the current variant, byte size and source binding identified by both review axes.

The fresh lab /tmp/gl-4l67pfey was stopped by the bounded down command and its directory was confirmed absent. Temporary negative source copies, the exact empty injected collision directory and the integrity-check script were removed. The retained private recording remains available for review. No owner window, display or device was touched.


### Disk-backed registry staging, planned 4 October 2026

The native-recording full default suite failed one packaging check: 606 passed, 48 skipped, 1 failed. The unchanged registry builder stages its archive and expanded package under tmpdir, and tar reported EDQUOT across package files. Evidence: .private/native-recording-final-verify.log. This is an actual source-package acceptance failure, not a cursor failure.

Before implementation: use the existing private, owner-validated disk workspace allocator for registry staging on all supported platforms, preserve exclusive final artifact creation and cleanup, and retain the same package-selection and frozen-lock assertions. The destination remains caller-selected and unchanged. No quota, mount, slice, assertion, deadline or source-file exclusion changes. The original failing packaging test is the regression check. Official Bun `bun pm pack --destination` documentation reviewed 4 October 2026: https://bun.com/docs/pm/cli/pm#pack, scope package generation and configurable output destination. The disk allocation is an owner resource policy, not a Bun platform requirement.

The initial standalone documentation URL was inaccessible. The official bun pm documentation was found through its current index and explicitly documents --destination; no claim relies on the inaccessible page. The original packaging regression now passes all three tests with 24 assertions, using unchanged archive-content, lockfile and platform-entry assertions. Typecheck passed. The complete default suite is being rerun after this new staging change.

The complete suite after disk-backed registry staging was not accepted: 496 passed, 48 skipped, 111 failed, 3274 assertions, 655 tests, 161.80 seconds. Evidence: .private/native-recording-package-final-verify.log. The user tmpfs quota reached its 12715 MiB hard limit again. The new staging succeeded, but the unchanged caller-selected packaging fixture destination /tmp/orbit-pack-0ec1QZ refused copyfile with EDQUOT; subsequent fixture writes failed across service/publication tests. An owned Chrome fixture profile under tmpdir also reported quota failure. The isolated original packaging regression had passed before quota saturation. No failed test was skipped or assertion relaxed. The draft source update will receive independent fresh platform CI; the local failure remains a project acceptance limitation and is not silently superseded.

Current scoped evidence supports the private native recording and isolated packaging correction. It does not support local full-suite acceptance in a quota-saturated environment, owner activation, exact owner theme matching or comparative performance. Both read-only review axes have no remaining actionable source finding after the documentation correction.


### Owner appearance preparation, 4 October 2026

Before preparatory read: use the existing stageNativeAppearance helper to copy only its fixed allowlist of literal GTK3, GTK4 and KDE visual settings from the owner's configuration directory into a new private disk directory. This is a read-only preference snapshot, not application launch or owner acceptance. No owner screen, pointer, window, session bus, CSS, arbitrary config or account file is read. The helper's themeMatch remains not measured; style assets, GSettings and color-scheme portals remain outstanding. Record copied/absent file metadata without printing raw personal settings. The current native launch and preview paths do not yet automatically consume this snapshot.

Owner appearance preparation copied the three allowed files: gtk-3.0/settings.ini, gtk-4.0/settings.ini and kdeglobals. No source file was absent or empty after filtering. The private snapshot and per-file byte sizes, permission modes and SHA256 bindings are retained in .private/native-owner-appearance-stage.json and .private/native-owner-appearance-binding.json. This is preparation only; native application/preview integration, CSS/assets, GSettings/portal color scheme and visual comparison remain open. The snapshot is retained for the next scoped implementation and is not published.

### Explicit disk-backed private lab, planned 4 October 2026

Before implementation: add an explicit lab up --disk option using a short private /var/tmp/gl-* directory and private TMPDIR. Keep the default /tmp lab and all resource budgets. Validate canonical owner-only lab/runtime directories, exact same-lab bus address and a non-symlink owned Wayland socket. Scoped broker fixtures may use either lab root; the plugin's legacy registration exemption remains unchanged and disk labs require scoped enrollment. This enables fresh cursor experiments under the measured full /tmp quota without touching foreign sessions or owner devices. Verify guards against malformed paths, socket symlinks and cross-lab buses before and after the correction, then run a real scoped proof and clean the owned lab. Full owner theme, owner acceptance and comparative performance remain unmeasured.

Official sources reviewed 4 October 2026: https://docs.python.org/3/library/tempfile.html#tempfile.mkdtemp documents secure owner-only directory creation, explicit directory selection and manual cleanup. https://specifications.freedesktop.org/basedir/latest/ requires owner-only runtime access and absolute XDG paths. Using a private disk lab is a local experiment resource policy, not an XDG guarantee about filesystem performance. No quotas, mounts, acceptance assertions or test deadlines are changed.

The valid disk-lab guard regression failed before the correction and all six guard tests passed afterward. The negative guard checks were already refused on disk by the old prefix-only guard; their baseline does not prove detection of those malformed cases on the old /tmp path. Evidence: .private/lab-guard-before.log and .private/lab-guard-after.log. The small pointer helper first failed compilation with EDQUOT under /tmp, then compiled successfully with private disk TMPDIR. Neither result was hidden.

Fresh lab /var/tmp/gl-nmdu8dl9 started with its own buses, headless compositors and held virtual pointer/keyboard. The unchanged scoped plugin loaded successfully. The public broker --record proof passed all eight contract checks, including two real GTK targets, three acknowledged native-view draws with changed agent cursor, pause/narrowing, capture/replay and sibling preservation. Evidence: .private/disk-native-broker-proof.log. The fresh APNG contains 10 decoded-identical frames at nominal 5 fps; its blue cursor marker moved from (549.5, 100) to (703, 167). The nominal recording rate is not input latency or comparative performance. The source-bound proof and .private/disk-lab-source.sha256 identify the implementations used. The lab down command exited zero and the exact lab directory was confirmed absent. Typecheck and diff whitespace checks passed. Full local-suite acceptance remains blocked by the previously measured /tmp quota; owner theme matching, live owner activation and comparative performance remain not measured. This is a private native experiment, not completion of the owner desktop goal.


### Native launch appearance integration, planned 4 October 2026

Before implementation: add an owner-fixed optional ORBIT_NATIVE_APPEARANCE directory to native broker startup. Read only the staged GTK3, GTK4 and KDE allowlist from canonical private owned directories and bounded unlinked owner-only regular files, re-filter literal visual keys, and retain an immutable launch default snapshot. Merge existing explicit per-application configuration over these defaults before the unchanged worker validates and hashes the complete launch for protected approval. An agent action cannot select an owner source path. Refuse malformed, linked, changed or oversized snapshots without launching resources. No owner display, session bus or live application is inspected. Exact theme matching, CSS/assets, color-scheme portal and preview chrome inheritance remain outstanding.

Official GTK3 3.24 documentation reviewed 4 October 2026: https://docs.gtk.org/gtk3/class.Settings.html describes settings.ini in XDG_CONFIG_HOME and the Settings section, and the dark preference property. This supports literal settings delivery, not an exact visual match claim. Owner preference copying is owner policy. Check strict snapshot refusal and startup option behavior, then verify the delivered settings in an actual private application.

The targeted integration tests passed 3 tests with 10 assertions, and typecheck passed. These new unit tests have not been run against the previous source and do not claim demonstrated regression detection. Evidence: .private/native-appearance-integration-tests.log and .private/native-appearance-integration-typecheck.log. Two read-only review axes found no actionable source issue.

The first real appearance broker proof delivered settings but failed its post-run process check because a new app-prefixed appearance report was included in the existing app process-report glob. The failure is retained in .private/native-appearance-broker-proof.log. Report names were corrected without narrowing the process-exit assertion. The corrected actual proof passed all nine checks, including exact SHA256 equality of all three filtered settings files in both private application configuration directories. Both live GTK applications reported gtk-application-prefer-dark-theme true. The captured native target is visibly dark while the viewer chrome remains light, as the preview has not yet inherited these settings. Evidence: .private/native-appearance-broker-proof-corrected.log and the refreshed native-live-cursor-motion.png/json. Source SHA256 bindings include the loader, backend, worker options and fixture. The recording contains 11 actual frames with exact RGBA preservation and moving teal marker variant 0.

The owned lab /var/tmp/gl-0m27kpsi was stopped by the bounded down command, which exited zero, and its exact directory was confirmed absent. Full local quota-saturated suite acceptance, exact owner theme/assets, viewer inheritance, owner display acceptance and comparative performance remain unresolved. No owner application or bus was inspected.


### Native viewer appearance integration, planned 4 October 2026

Before implementation: native-view may consume the same fixed owner ORBIT_NATIVE_APPEARANCE snapshot from its startup environment, validate and re-filter it through loadNativeAppearance, write fresh private literal settings into a bounded disk workspace, and supply that directory as its child XDG_CONFIG_HOME. Never point GTK at the raw owner configuration or write into the snapshot. Preserve display/bus selection, actual draw acknowledgements, capture cadence and cancellation. Remove the viewer configuration only after child closure; retain primary and cleanup failures independently. Official GTK3 3.24 Settings documentation reviewed again 4 October 2026, https://docs.gtk.org/gtk3/class.Settings.html, confirms settings.ini discovery in XDG_CONFIG_HOME and dark preference behavior. This delivers native GTK preferences, not CSS/assets or a complete owner theme guarantee. Check snapshot/environment propagation and cleanup, then capture a real dark viewer and moving cursor in the private lab.

The viewer-specific propagation and cleanup test failed against the unchanged viewer: its consumer had no supplied GTK settings.ini. The same test passed after fresh filtered configuration delivery. Before/after logs: .private/native-preview-appearance-before.log and .private/native-preview-appearance-after.log. Both static review axes found no actionable issue. Typecheck and diff checks passed.

Fresh scoped broker proof passed all nine checks with actual GTK draws and owner-settings equality in both applications. The recorded viewer header and surrounding GTK area are now visibly dark. A fixed header patch mean RGB changed from the retained historical light capture (221.74, 218.26, 214.78) to (40.67, 40.67, 40.67), with image hashes and scope in .private/native-viewer-appearance-color-proof.json. This is a localized dark preference check, not a complete color/font/theme match. Eleven actual recorded RGBA-identical frames retain moving blue cursor variant 1. Proof: .private/native-viewer-appearance-proof.log and the refreshed animation metadata. The owned /var/tmp/gl-bw4xu58z lab down command exited zero and its exact directory was confirmed absent. No owner display/input was used.

The original native-preview lifecycle and IPC-cancellation tests and the two appearance test files were run together with TMPDIR=/var/tmp solely for their private filesystem fixtures, whose assertions do not depend on /tmp or RAM filesystem semantics. No full-suite TMPDIR substitution, assertion/deadline change or quota adjustment was used. Full local-suite acceptance under the saturated quota, exact owner assets/theme, complete toolkit/simultaneous-input matrix, owner activation and comparative performance remain outstanding.

The combined scoped run passed 8 tests, 34 assertions, zero failures in 2.92 seconds. Evidence: .private/native-viewer-final-tests.log. The preceding aa57b70 independent platform CI completed successfully, but does not validate this newer viewer source.


### Scoped native cursor performance measurement, planned 4 October 2026

Before implementation: measure two real scoped GTK targets on the private nested compositor with a simulated person window, preserving focus and geometry. Alternate idle, static-cursor, read-only state IPC and moving-cursor phases in forward/reverse order, record requested versus actual cadence, controller response durations, compositor/probe CPU ticks and per-process resident memory. Pin process identities and exact plugin/source hashes. Use native guarded session execution and durable action logs, never the plugin's legacy unscoped exemption. Retain the report and logs and close every owned application/device/lab. These are nested lab costs and guarded response times, not display/input latency, whole-system owner overhead or proof of superiority over the old system. Cadence misses are data, not silently retried samples. Linux procfs stat accounting documentation will be checked for tick/RSS interpretation before implementation.

Official Linux procfs documentation reviewed 4 October 2026, https://docs.kernel.org/filesystems/proc.html, identifies user/system tick accounting, process start times and resident memory pages. RSS is asynchronous and approximate, includes shared mappings, and is not unique physical memory. CPU percentages below are percentages of one core.

Both review axes caught a controller-lifetime bug before the first runtime attempt: cleanup originally followed the closed ActionControl context. ExitStack now keeps it alive through session.close. Review also corrected bounded StandIn KILL/reap fallback and aggregation of report-write errors. The first run failed before application launch due to a missing private apps directory; the next failed before sampling because hide-cursor requires an existing cursor. Initialization was corrected without changing the native action contract. An intervening indentation error prevented execution and was fixed. All four attempt logs are retained under .private/native-cursor-cost*.log; no failed attempt is measurement evidence. Both review axes found no remaining actionable issue after their requested lifetime/error-path corrections.

The final source-bound actual measurement completed all eight six-second samples, with unchanged simulated owner focus and fixture geometry, stable compositor identities and exact O0 plugin binding. Evidence: .private/native-cursor-cost-762947/report.json and diagnostics/control/actions.jsonl, plus .private/native-cursor-cost-summary.json. No control lock or journal was created in the repository CWD. Cleanup closed scoped applications and the simulated owner window while control remained live; the bounded lab down command exited zero and /var/tmp/gl-n_gxkigx was confirmed absent.

Two guarded cursor responses have median40.43 ms and p9549.03 ms at requested20 request pairs per second. Forward/reverse actual mean rates were19.9996/19.9998 pairs per second, but0/10 scheduled pair deadlines were exceeded and are retained. Moving phase probe CPU was14.67/16.17 percent of one core; Hyprland4.33/5.00 percent and outer KWin2.00/2.83 percent. Read-only state pairs had median40.91 ms and p9547.51 ms, probe CPU15.33/17.33 percent, with2/14 deadline misses. Static cursor Hyprland CPU rounded to zero ticks in both six-second samples, not proof of zero cost. Scope excludes applications/helper CPU, public broker and capture/viewer work; targets remain in their pre-map scoped workspace. Whole-system, old-system comparison and display/input latency remain not measured. This identifies guarded action overhead for further profiling; it does not satisfy the owner's complete performance acceptance requirement.


### Guarded native action profiling, planned 4 October 2026

Before profiling: run the unchanged source-bound native_cursor_cost_probe through the system Python cProfile module in a fresh private disk lab, preserve the exact plugin, action guards, logs and cleanup. Retain the profile independently from the prior uninstrumented benchmark. Use cumulative call costs to find bottlenecks; instrumented times are not replacement performance acceptance data. Do not remove checks or cache ownership decisions merely because they are expensive. Only scoped application, simulated-person and compositor processes are observed.

Official Python 3.14 profiling documentation reviewed 4 October 2026: https://docs.python.org/3/library/profile.html describes deterministic cProfile call statistics and explicitly warns that profiling is not benchmarking because instrumentation adds overhead. The profile is retained as .private/native-cursor-cost.profile, with native function totals in .private/native-cursor-profile-summary.json.

The actual instrumented probe exited zero, completed 8 source-bound samples and retained no errors in .private/native-cursor-cost-880266/report.json. All 15 source bindings were independently rechecked. The controller journal is in its private diagnostics directory; no actions.jsonl or lock was created in repository CWD. The owned lab down command exited zero and /var/tmp/gl-1llhpity was confirmed absent. Raw instrumented response times are not replacement benchmarks.

Profile root cause: native session execute cumulative 20.820 seconds across 984calls; unit_properties cumulative 14.374 seconds across 2962calls, with subprocess.run cumulative 14.201 seconds for 2962calls. Lease verify cumulative 14.663 seconds; transport exchange cumulative 3.075 seconds and host revalidation cumulative 2.378 seconds. Durable journal record cumulative 1.557 seconds. Cumulative parent/child times overlap and must not be added as independent work. These identify fresh systemctl process queries as the primary guarded-action bottleneck. No guard, validation, journal or runtime source was changed in this profiling step.

The rendered official systemd manual URL returned403. The official systemd source manual at https://raw.githubusercontent.com/systemd/systemd/main/man/org.freedesktop.systemd1.xml was successfully reviewed 4 October 2026, main-branch documentation scope. It documents the Manager GetUnit lookup and unit D-Bus interfaces. A direct fresh manager query is the next candidate optimization; it is not implemented, not measured and not yet validated against installed manager/runtime dependencies. Invocation, active-state, cgroup identity and bounded failure checks must remain intact. Full owner acceptance and comparative performance remain outstanding.

### Fresh native manager D-Bus reads, planned 4 October 2026

Before implementation: replace repeated systemctl processes with fresh GIO D-Bus connections for generated native unit queries when the system Python provides GIO. Keep the existing subprocess path only when the optional Python binding is absent, not after a failed query. Resolve the exact generated unit through GetUnit, read typed InvocationID and ActiveState on Unit and ControlGroup on Service or Scope, validate bounded replies, and close the connection. A three-second cancellation deadline covers connection and reads; cleanup has its own bounded cancellation. No unit state or ownership decision is cached. Existing invocation, canonical cgroup, member identity, action guards and journal checks remain unchanged. Verify mocked stale/malformed replies and real owned units before measuring unchanged cursor workloads. Cold import and optional-binding fallback remain separate measurement scopes.

Official GIO documentation reviewed 4 October 2026: https://docs.gtk.org/gio/ctor.DBusConnection.new_for_address_sync.html and https://docs.gtk.org/gio/method.DBusConnection.call_sync.html document cancellable connection establishment, typed replies, closed-connection errors and per-call timeouts. Both APIs date to GLib 2.26; installed system bindings report GLib 2.88.3. Official systemd source manual https://raw.githubusercontent.com/systemd/systemd/main/man/org.freedesktop.systemd1.xml documents GetUnit and the Unit/type-specific property interfaces; installed systemd is 259.9-1.fc44. This is a supported read-only protocol optimization, not proof of whole-system performance or owner acceptance.

Fresh manager implementation passed the eight existing lease identity tests and four new typed-protocol/fresh-connection/error-cleanup tests. The new tests have not been run against the old systemctl-only implementation and do not claim demonstrated regression detection. Typecheck and diff checks passed. Both read-only review axes found no actionable issue in the scoped change.

A real owned sleep-only service in the shared slice returned exactly the same three properties through both methods across two alternating 50-query rounds per method. D-Bus median read times were 1.25/1.63 ms versus systemctl 4.83/5.09 ms. After bounded stop, recorded member identities were absent and a fresh read refused the stopped unit. The first attempt completed these assertions but failed JSON report serialization of a set; that failed log is retained as .private/native-manager-live.log. The corrected proof is .private/native-manager-live.json and .private/native-manager-live-corrected.log, bound to lease.py SHA256. Cold import, missing-binding fallback and Scope-specific integration are not measured by this service-only proof.

The unchanged actual cursor workload completed all eight samples with no report errors at .private/native-cursor-cost-1103093/report.json; all fifteen source hashes were independently checked. Guarded moving-pair median decreased from 40.43 ms in the retained prior run to 20.71 ms, with zero scheduled deadline misses in both new moving samples. Probe-process CPU increased from 14.67/16.17 percent of one core to 25.83/25.67 percent. This is not a total CPU regression or improvement measurement: previous procfs accounting excluded the systemctl child processes, while GIO work occurs inside the measured controller. Add child-process CPU accounting and repeat the original and new paths before claiming overall efficiency. Existing whole-system/capture/input latency exclusions still apply. The owned disk lab down command exited zero and /var/tmp/gl-l034hlgl was confirmed absent. No owner display or application was used. This candidate is not full performance acceptance.

### Controller and reaped-child CPU comparison, planned 4 October 2026

Before implementation: extend only the private native cursor cost probe with getrusage SELF and CHILDREN deltas, measured immediately around the existing six-second phases. Keep procfs compositor measurements and all original workload, cadence, guards and cleanup. CHILDREN covers terminated children already waited for, including each synchronous systemctl query; it excludes live GTK/helper applications and manager/compositor work outside the probe. Add an experiment-only --manager-read systemctl option that makes the optional gi.repository binding unavailable in this probe process, exercising the unchanged checked subprocess fallback. Child applications do not inherit Python module state. No runtime selection option is added to NativeSession or the public broker. Compare fresh forward/reverse full samples for both paths, retaining exact source bindings and path selection. This proves only controller plus waited-child costs, not whole-machine costs or cold import latency.

Official Python 3.14 documentation reviewed 4 October 2026: https://docs.python.org/3/library/resource.html documents SELF as the calling process including all threads and CHILDREN as terminated and waited-for children. Use ru_utime plus ru_stime in seconds, without adjusting any limits. Legacy procfs values remain independently reported, and missing child accounting invalidates the expanded comparison.

Spec review found that requested auto selection alone did not prove the actual backend. Added per-phase invocation counters around the unchanged manager readers; the reviewer confirmed this resolved the ambiguity. Retained the preliminary source snapshot and report, then repeated both complete eight-phase runs against identical source and plugin bindings. Both runs exited zero without report errors. Actual active phases counted exactly 720 systemctl queries and zero D-Bus queries in the forced fallback, and exactly 720 D-Bus queries with zero systemctl in the automatic path. Evidence: .private/native-cursor-cost-1235447/report.json and .private/native-cursor-cost-1259797/report.json, derived .private/native-cursor-cpu-comparison.json. All fifteen hashes matched current source in both reports before publication.

Moving-pair median was 39.30 ms in systemctl and 20.51 ms in D-Bus. Controller plus waited-child CPU was 43.03/42.59 percent of one core versus 25.62/26.77 percent. Moving scheduled deadline misses were 40/18 versus 0/0, despite both mean cadences remaining near20 pairs per second. Read-only state-pair median was 38.25 versus 21.25 ms; state scheduled misses were 0/0 versus 0/6 and are retained, not treated as a perfect-deadline pass. State CPU was 43.17/43.80 versus 26.12/26.47 percent. These separate runs are same-source/path-selection component comparisons, not a whole-system, app CPU, manager daemon CPU, capture/viewer or cold-start measurement. Both review axes found no remaining actionable issue. Bounded down exited zero and /var/tmp/gl-5kosn9qn was independently confirmed absent. Full owner activation and the BAR toolkit/simultaneous-input matrix remain outstanding.

### Missing Firefox toolkit preparation, planned 4 October 2026

Before preparation: Firefox is absent from the host PATH and its native task matrix remains not measured. Download an official Mozilla Linux archive into ignored private disk storage, retain the resolved URL and SHA256, and extract only to a fresh owned private directory. Do not change system packages, owner browser profiles, defaults or shortcuts. Any browser execution with UI will use the guarded private lab, fresh profile and isolated application bus. The purpose is real Firefox native state/press/text/selection/scroll evidence, not headless WebDriver input. Preserve current scoped launch and controller guards; preparation alone is not a capability pass.

Official Firefox releases listing reviewed 4 October 2026: https://www.mozilla.org/en-US/firefox/releases/ redirects to https://www.firefox.com/en-US/releases/. Record the delivered immutable archive version rather than assuming the listing's newest entry is installed. Mozilla source documentation https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html describes explicit profile selection for automation; no geckodriver input is used in this native-input test. The attempted source-doc Wayland URL returned an error and is not relied on. Browser command options and backend behavior require validation against the actual downloaded version before launching. Artifact source/license and dependency evidence remain preparatory until the private runtime is checked.

The first official download ended with timeout28 after 60 seconds and retained43,299,930 bytes. Its result and log are retained; a separate explicit HTTP range continuation completed successfully. The resolved immutable artifact is Mozilla Firefox157.0, linux-x86_64/en-US, 88,566,620 bytes. Its SHA512 matched the exact path in Mozilla's HTTPS SHA512SUMS; this is a checksum comparison, not an independent signing-key verification. SHA256 is42f2c62a562316982ef5a796738c57602bf84a984f5c616e80bcff4627f78fff. The private extraction used Python's data filter, a fresh owner-only directory, a10,000-member limit and1GiB expanded-size limit; it contains51 members and334,491,019 expanded bytes. Binaries are not published or installed globally. Metadata is .private/firefox-preparation/metadata.json. Firefox --version exited zero, reported157.0 and produced no stderr; this metadata-only invocation does not open UI.

Official command documentation https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html and version157 system requirements https://www.firefox.com/en-US/firefox/157.0/system-requirements/ were reviewed 4 October 2026. Explicit --profile and --no-remote isolate instance/profile selection; --kiosk is a documented display option. The source accessibility architecture https://firefox-source-docs.mozilla.org/accessible/Architecture.html describes parent-process accessibility handling; actual AT-SPI readback remains not measured.

A fresh disk-lab smoke run launched that exact binary through NativeSession's scoped supervisor, obtained an owned generated window handle, acknowledged a cursor position and returned a target capture/state response. The command exited zero, but inspection of the first retained frame found only zero RGBA pixels (fully transparent, rendered black by the preview). This is not successful browser content/cursor visual evidence or B7 acceptance. The probe lacked a fixture-readiness wait, so initial painting versus a persistent rendering failure is unresolved. Retained report/image/log and private probe hash: .private/firefox-preparation/native-firefox-smoke.json/png/log. Runtime source hashes were independently checked. NativeSession closed its application while the controller was open; bounded lab down exited zero and /var/tmp/gl-6wrvs080 was independently confirmed absent. Firefox text, selection, button, wheel, accessibility and fresh post-action pixels remain not measured. Next work must establish page readiness, retain private startup diagnostics and reject black/unloaded frames before running task checks. No owner application/display was used.

### Firefox readiness and native task checks, planned 4 October 2026

Before implementation: add an isolated Firefox task probe with the downloaded fixed-version binary supplied explicitly, a fresh private browser profile, ephemeral loopback fixture server and existing guarded NativeSession actions. Wait for the fixture's load report and independently reject empty/transparent frames before asserting visual readiness. Measure native button, English/Arabic text, selection and wheel results through the local fixture observer and private AT-SPI reads where available; do not use DOM/WebDriver to perform actions. All launch/input/capture requests stay under the existing action controller. Copy private worker diagnostics before cleanup, retain failures separately and stop only owned application/lab resources. Unknown accessibility/toolkit/interference checks stay not measured. Mozilla157 command and accessibility architecture documentation reviewed in the previous preparation remains applicable; Firefox preparation and the zero-RGBA first capture are not readiness evidence. No owner desktop acceptance occurs in this step.

Initial readiness run failed its exact red-marker check, retained as .private/native-firefox-1547301/report.json and native-firefox-task.log. Unlike the earlier smoke frame, the image is opaque and shows the fixture behind Firefox's welcome/terms modal. It is not a rendering failure. Private worker diagnostics also retain org.a11y.Bus activation permission warnings and portal fallback/PipeWire warnings. These remain runtime integration blockers, not silently suppressed passes.

The task-only fresh profile now uses Mozilla's documented termsofuse.bypassNotification test preference, without setting acceptedDate or acceptedVersion. Official preference documentation reviewed 4 October 2026: https://firefox-source-docs.mozilla.org/toolkit/components/telemetry/internals/preferences.html. It also explicitly enables accessibility for this test with accessibility.force_disabled=-1; Mozilla's current all.js source at https://searchfox.org/firefox-main/source/modules/libpref/init/all.js documents -1 always on, 1 off and 0 automatic. The current-source scope is recorded; this does not establish automatic accessibility integration. The second run reached actual AT-SPI text readback but failed coordinate validation because Firefox returned extent[-1,-1,-1,-1] for the background field. Its report/log are retained at .private/native-firefox-1612696 and native-firefox-task-preferences.log. No runtime coordinate guard was weakened.

The fixture now measures a unique painted40x40 red marker bounding box against its local observer geometry to derive surface-local task coordinates. It retains invalid native accessibility geometry; this is fixture-specific pixel targeting, not generic accessible coordinate support. Both review axes corrected partial-server cleanup, independent cleanup/report-write error aggregation, and a potentially false wheel image comparison. The pre-wheel text region must paint stably with the red unselected marker; the post-wheel image must contain the green scrolled marker and changed text rows. Both axes found no remaining actionable issue after these corrections.

Final actual source-bound task exited zero with no report errors: .private/native-firefox-1636790/report.json, private worker diagnostics, ready/before-wheel/after-wheel PNGs, controller journal and native-firefox-task-pixels.log. It measured one native button press, exactly926 characters including English and Arabic through native key delivery, selection/reset, one wheel event and222 pixels of textarea scroll. Private AT-SPI text matched initially and after typing/scrolling. All32 controller intents had matching successful outcomes, including cleanup; all11 direct source bindings were independently rechecked. The final after-wheel image was inspected. This proves the fixed Firefox157 task on a prepared isolated profile; it does not prove B1 to B4 interference, generic geometry, automatic a11y readiness, clipboard, click-through, two-agent execution, owner activation or complete B7 matrix acceptance. Known bus/portal warnings remain unresolved and prevent full release acceptance. NativeSession closed its owned application before controller closure; bounded lab down exited zero and /var/tmp/gl-y7a_or3i was independently confirmed absent.
