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
- CLI launch and accessibility now use the controller, with real protected
  denial, approval, readback and journal-failure evidence.
- Native controller decisions and durable intent/outcome records are measured
  on a real GTK3 target, including failure before input when the journal fails.

## Remaining acceptance work

- Complete the current-build toolkit, clipboard and cursor regression matrix.
- Implement owner-session integration and owner theme inheritance.
- Integrate the tested protected/full controller into every agent entry point
  and the owner settings UI.
- Extend the synchronized journal to direct raw input and imported helpers.
  CLI launch and accessibility are now controlled; direct experimental IPC
  currently bypasses the controller.
- Compare total CPU, memory and latency with the previous runtime.
- Prepare the final owner-session acceptance required by BAR.md.
- Finish project gates and record exact source-bound acceptance evidence.

Publication of this research source does not close these requirements. Raw
workstation evidence is retained locally in ignored storage.
