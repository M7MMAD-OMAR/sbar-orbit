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
