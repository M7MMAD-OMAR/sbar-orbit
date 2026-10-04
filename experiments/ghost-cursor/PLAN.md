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
- Native GTK4 owner settings preview is measured in the lab, including one-use
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
  `NATIVE-SESSION.md`; public broker and UI routing remain incomplete.

## Remaining acceptance work

- Complete the current-build toolkit, clipboard and cursor regression matrix,
  including Firefox and XWayland. Chromium fixture evidence is not a universal
  browser/toolkit guarantee.
- Finish owner-session launch supervision, activation and theme inheritance.
  Prepared-host transport and the generic supervised launcher are implemented.
  Private GTK3 launch, paired input and lifecycle checks passed, see
  `NATIVE-LAUNCH.md`. Production broker and owner settings wiring remain incomplete.
- Integrate the tested protected/full controller into every agent entry point
  and the owner settings UI.
- Extend auditing to remaining imported accessibility actions and broker
  lifecycle operations. CLI launch/accessibility and shared raw requests are
  controlled; direct experimental IPC remains outside the cooperative API.
- Compare total CPU, memory and latency with the previous runtime.
- Prepare the final owner-session acceptance required by BAR.md.
- Finish project gates and record exact source-bound acceptance evidence.

Publication of this research source does not close these requirements. Raw
workstation evidence is retained locally in ignored storage.
