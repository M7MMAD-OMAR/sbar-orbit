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

## Remaining acceptance work

- Complete the current-build toolkit, clipboard and cursor regression matrix.
- Implement owner-session integration and owner theme inheritance.
- Implement protected/full settings outside conversation text.
- Add a durable action journal covering every action.
- Compare total CPU, memory and latency with the previous runtime.
- Prepare the final owner-session acceptance required by BAR.md.
- Finish project gates and record exact source-bound acceptance evidence.

Publication of this research source does not close these requirements. Raw
workstation evidence is retained locally in ignored storage.
