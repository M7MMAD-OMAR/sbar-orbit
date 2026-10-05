# Background computer use completion plan

Owner requirement: use native applications in the owner's Hyprland session,
with the owner's theme and a separate visible cursor. A browser viewer or
private desktop is a development aid and does not satisfy final acceptance.

BAR.md remains the acceptance contract. Unknown checks stay not measured.
Development uses a private lab and does not send input to the owner's seat.

## Current progress

- Matching-ABI plugin builds and loads in the lab.
- Native background text, clicks and wheel input have partial toolkit evidence.
- An antialiased cursor and private visual demonstration are implemented.
- Mixed-client targeting is refused before input delivery.
- Compositor-launched leaks are detected by B12 and cleaned by process identity.
- Failed launches clean up their owned processes and temporary markers.
- Concurrent native GTK3 clients preserve distinct clipboard text.
- Viewer fullscreen and independent command/polling error recovery are tested.
- Two fresh raw canvases pass independent text, click and wheel checks with
  matched journal outcomes and no surviving processes.
- Shared raw requests now use the controller; concurrent clipboard workers
  have matched success records, and Qt/Writer request intervals overlap.
- CLI launch and accessibility now use the controller, with real protected
  denial, approval, readback and journal-failure evidence.
- Native controller decisions and durable intent/outcome records are measured
  on a real GTK3 target, including failure before input when the journal fails.
- Native GTK4 owner settings public CLI is measured in the lab, including one-use
  approval, damaged journal refusal and closing while storage is locked.
- Chromium 153 on Wayland passes native state, press, English/Arabic text,
  selection and scroll with matched action outcomes and background pixels.
- Launch ownership now retains the root PID and start time when an application's
  launch environment tag is not observable. Failed untagged-root launch cleanup
  is measured, without widening the private-lab process scope.
- Prepared endpoint binding now lives in the runtime source tree. A journaled
  native transport checks compositor identity before sending plugin actions and
  supports scoped pre-exec enrollment. Its private pre-map integration test
  measures protected approval, exact membership and revoked-target refusal.
  This is a transport component, not owner-session activation.
- A persistent native session worker now retains generated application/window
  handles, checks guarded stable identity and scope inside the plugin, captures
  only its own targets, and deduplicates uncertain requests. Ten private checks
  passed, including sticky capture revocation and protected EOF cleanup. See
  `NATIVE-SESSION.md`. The public broker and live GTK routing are measured in
  `NATIVE-BROKER.md` and `NATIVE-LIVE-VIEW.md`; owner activation remains open.

## Remaining acceptance work

Current LibreOffice26.2 acceptance is a measured failure, not historical support
promotion. The shipped NativeSession path registers oosplash, while the actual
Wayland Writer window belongs to soffice.bin in the same retained scope. Target
admission refuses that unregistered child. Explicit child registration in a
private diagnostic passes ownership admission. A separate controlled diagnostic
now establishes that the owned Welcome dialog blocks Writer response: scoped
Escape closes it, then Bold, exact English/Arabic text, selection and wheel
readback pass. The same-lab control without dismissal still fails Bold readback.
This is application-response diagnosis, not shipped multiprocess acceptance.
Before acceptance,
implement and test child admission against the exact retained scope before
client selection/input access, preserving PID identity, directory identity,
root/scope lifetime and owner-client refusal. Child placement must remain safe
after the launch root exits and through static-rule rechecks and dynamic-rule
updates. Keep client selection isolation sticky until its Wayland connection
ends, including selection devices created after membership revocation.
The current guard now retains a classified private connection when either
selection protection is installed or its first selection request is observed.
Actual callback/resource-lifetime regressions and the current private GTK3
clipboard pair pass. Automatic child classification and pre-map protection
remain unimplemented; this prerequisite does not close child acceptance.
Post-map manual enrollment is not a production fix.
The next client classifier must derive its pidfd from the Wayland socket with
SO_PEERPIDFD, without a numeric pidfd_open fallback. A bounded private UNIX
socket probe on kernel7.2.8 retained a live peer identity, then reaped that peer
while retaining a transferred socket. Both the retained descriptor and a new
SO_PEERPIDFD request reported the original dead peer, despite the socket still
transferring data. Evidence: `.private/native-loader-readiness/peer-pidfd-proof.json`,
probe source SHA2568217a413c94fe3b58b0669fa9027508308b1bc718a2431af3d1a3545e42149e1.
This proves the local kernel mechanism, not integrated child admission or PID
reuse acceptance. Reject unsupported peer identity acquisition before admission.
A private fixed-ABI candidate now compiles the optional socket-bound identity
constructor and compares its scope directory with the original retained scope
descriptor. Candidate source SHA256c35b046e507389f11434816e64917eec742b65ec82adf1a856c3a11fe2c878c4.
It has not been loaded. Subsequent private edits wire client classification and
four fixed-ABI rule/map hooks, but that stage has not been compiled and loading
is explicitly disabled. Review identified admission error containment and hook
rollback/override failure paths that must be resolved before enabling it.
The fixed-ABI map path also releases mouse buttons before reading static rules
when layer-shell focus is retained. Guard that state before the original map
entry, then test a held owner button in the private lab. Static-rule hooks alone
do not prove zero owner input disturbance.
See the current failure evidence in the root COMPLIANCE.md.

Prepared owner replacement also exposed GNU_UNIQUE DSO retention after unload.
The corrected build uses -fno-gnu-unique. The guarded native_reload_probe.py
reproduces the old retained mapping and verifies two sequential exact prepared
load/unload cycles with no remaining mappings for the new build. A fresh owner
Hyprland session is still required to clear already pinned old artifacts before
recovery; keep the strict mapping guard and current control settings intact.

The native GTK target viewer now visibly renders acknowledged cursor positions
from session frames, with logical-to-image scaling and source EOF cleanup. Six
pixel/validation checks and the actual private GTK probe passed, see
`NATIVE-VIEW.md`. Public broker integration is measured in `NATIVE-LIVE-VIEW.md`.
Owner activation remains open.

- Complete the current-build toolkit, clipboard and cursor regression matrix,
  including Firefox and XWayland. Chromium fixture evidence is not a universal
  browser/toolkit guarantee.
- Finish owner-session launch supervision, activation and theme inheritance.
  Prepared-host transport and the generic supervised launcher are implemented.
  Private GTK3 launch, paired input and lifecycle checks passed, see
  `NATIVE-LAUNCH.md`. Public owner settings are measured in
  `NATIVE-SETTINGS-RUNTIME.md`. Managed production activation remains incomplete.
- Integrate the tested protected/full controller into every agent entry point
  beyond the measured public native controls and owner settings UI.
- Extend auditing to remaining imported accessibility actions and broker
  lifecycle operations. CLI launch/accessibility and shared raw requests are
  controlled; direct experimental IPC remains outside the cooperative API.
- Compare total CPU, memory and latency with the previous runtime.
- Prepare the final owner-session acceptance required by BAR.md.
- Finish project gates and record exact source-bound acceptance evidence.

Publication of this research source does not close these requirements. Raw
workstation evidence is retained locally in ignored storage.

## Latest scoped Firefox evidence, 4 October 2026

The explicit official accessibility launcher now enables Firefox157 AT-SPI
readback without a forced accessibility preference. Current scoped task evidence
at .private/native-firefox-1926117 measured one native press,926 English/Arabic
characters, selection/reset, one wheel event,222-pixel scroll and matched text
readback. All11 direct source hashes and32 successful action pairs were verified.
The target captures use fixture-specific painted-marker coordinates because
Firefox's background accessibility extents remain invalid. Target-only captures
do not prove the separate cursor overlay. Portal warnings, complete interference
checks, clipboard and owner-session acceptance remain open. XWayland needs a
separate owned-client design: the current plugin resolves Wayland surface-client
credentials and a client seat, so a shared XWayland server must not be admitted
as though it were the scoped application. No XWayland capability is claimed.

The existing cleanup test fixture currently fails during preparation on /tmp;
a diagnostic run exposed an actual quota error in supervisor journal writes.
Full local gates remain blocked. No owner or foreign-agent data is removed to
turn this into a pass. Source publication remains a draft research update.

## Latest scoped concurrency and compositor cursor evidence,4October2026

Two labelled scoped Firefox157 tasks now have independent936-character readbacks,
distinct application units/window handles and4 measured native request-interval
overlaps under the experimental memfd person typist. The unchanged interference
harness passed B1/B2/B3/B4/B12 with1,140 concurrent person characters. This is
cooperative request overlap, not simultaneous compositor event execution.

A separate current-build native compositor experiment verifies the actual arrow
pixel at the person-click point, receives exactly one underlying canvas click,
and observes the pixel change after hiding the overlay. The actually mapped
plugin/source sidecar is checked before/after. A no-overlay negative control
rejects absent-arrow evidence, and all owned experiment processes were cleaned.
The image and reports remain ignored private evidence; no owner display was
activated. B9 reference comparison, two visible agent cursors in the concurrent
Firefox measurement, the complete toolkit matrix and final owner acceptance
remain incomplete. See COMPLIANCE.md for exact source bindings and failures.

## Current paired compositor cursor evidence, 4 October 2026

A current private paired Firefox run now combines distinct936-character native
task readbacks, one actual request-interval overlap, two visible compositor
cursors and passing unchanged B1/B2/B3/B4/B12 person interference checks. Both
arrow interior pixels appear in the same real frame. Hiding each cursor through
its own native session changes only that cursor pixel, providing independent
negative controls. Source/plugin bindings and exact PID/start cleanup are verified.
See COMPLIANCE.md and local `.private/native-cursor-pair/verification.json`.

This closes the missing two-visible-cursor evidence for this private cooperative
Firefox run. It does not close owner activation, labels-off OpenAI comparison,
comparative performance or full current toolkit/clipboard acceptance. The
current X11 selection proxy is still experimental and not integrated into the
production scoped native route. The required local project suite remains
failed/incomplete on the recorded quota errors.

## Current scoped raw acceptance, 5 October 2026

The current NativeSession raw DrawingArea task now measures actual pixel clicks,
English/Arabic text, BackSpace and wheel input without an editable accessibility
path. Two source-bound owned tasks pass under the unchanged person harness, with
exact independent text and overlapping native request intervals. Fully opaque
changed text-region pixels exclude cursor movement from the repaint assertion.
Stale/frozen/transparent image controls and setup/storage/recovery regressions
are refused. Exact reports and independently verified cleanup are in COMPLIANCE.md
and NATIVE-RAW.md. This updates the raw-input slice of private acceptance only.

The committed color-preference integration at3a06637 passes653 full-suite tests
with48 configured skips and0 failures, replacing the historical quota-blocked
status above. The raw addition passes654 current full-suite tests with48 configured skips
and0 failures; publication checks are recorded in COMPLIANCE.md.
Owner activation, full matrix/clipboard/XWayland, reference cursor comparison,
full theme assets and total performance acceptance remain incomplete.
