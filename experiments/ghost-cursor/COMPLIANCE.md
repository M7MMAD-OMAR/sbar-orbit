# Ghost cursor compliance and acceptance

Reviewed 3 October 2026. Scope: isolated background application input, visible
agent cursors, owner-selected autonomy modes and measured interference.

## Sources

- Official Wayland pointer protocol, reviewed 3 October 2026:
  https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_pointer
  axis_discrete precedes its paired axis event for clients below version 8;
  axis_value120 replaces it from version 8. Events remain grouped in a frame.
- Official Qt client implementation matching installed Qt 6.11.2:
  https://github.com/qt/qtbase/blob/v6.11.2/src/plugins/platforms/wayland/qwaylandinputdevice.cpp
  Reviewed 3 October 2026. pointer_frame compresses fast adjacent frames;
  pointer_leave invalidates focus and flushScrollEvent needs a focus target.
  Grouped wheel input is verified through Dolphin scroll coordinates and pixels.
- Official GTK input implementation matching installed GTK 4.22.5:
  https://github.com/GNOME/gtk/blob/4.22.5/gdk/wayland/gdkseat-wayland.c
  Reviewed 3 October 2026. A frame with a pending motion event delivers that
  event instead of flushing scroll. Motion and wheel therefore use separate
  frames, and the target client's synthetic pointer focus is retained until
  explicit ghost-release or a later pointer action. This does not move the
  global seat pointer or alter its focus. Unload cleanup skips the client's
  resource when that client currently holds actual seat pointer focus.

- Official Hyprland IPC event reference, reviewed 3 October 2026:
  https://wiki.hypr.land/IPC/
  Updated 26 August 2026. Both screencast and screencastv2 report screencopy
  client state, not a workspace, focus or stacking change. The live watcher
  produces these observation events; other unknown events still fail B4.

- Official Hyprland plugin development guide:
  https://wiki.hypr.land/Plugins/Development/Getting-Started/
  Technical constraint: plugin API and compiled headers must match the running
  compositor. Use the existing extracted development RPMs, without sudo.
- Official advanced plugin guide, reviewed 3 October 2026:
  https://wiki.hypr.land/Plugins/Development/Advanced/
  Documents private-member access. The primary-selection guard uses this
  version-specific pattern for existing target devices and restores their
  original callbacks on unload. No compatibility with other ABIs is claimed.
- Hyprland primary-selection implementation at the running commit:
  https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/protocols/PrimarySelection.cpp
  Reviewed 3 October 2026. Native selection can update the global primary
  selection even when the client lacks the person's focus. This was observed
  by the person's client in the unfixed GTK4 test, not merely inferred.
- BAR.md: owner acceptance criteria B1 through B10, including client-observed
  focus and input, raw background input, visible click-through cursor and two
  agents. Unrun requirements remain not measured.
- AGENTS.md: owner constraints, Bun commands, private displays, resource bounds,
  English repository text, no long dashes and no interference with the live seat.
- Official wlr virtual pointer protocol:
  https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml
  Technical reference for the simulated person's click-through test. The XML
  retains its permissive copyright notice in the ignored local dependency tree.
  The helper refuses display sockets outside /tmp/gl-* and never opens uinput.

## Current checks and scope

Reviewed 3 October 2026. This is a private-lab research prototype, excluded from
the normal runtime and package. No owner desktop integration is delivered.

- Mixed-client input: the old plugin accepted a target whose client also owned
  a window outside the agent workspace. The new plugin refuses that exact case
  before input delivery. The same fixture proved failure before and success
  after the correction.
- Compositor process cleanup: the old harness passed while a compositor-launched
  fixture remained alive. The updated B12 gate detects that fixture, reports
  failure and terminates it using its process identity. Cleanup never changes
  the failed measurement to a pass.
- Failed launch cleanup: a no-window command times out as expected. Its owned
  process and temporary markers are absent afterward.
- Concurrent clipboard regression: two native GTK3 clients copied and pasted
  distinct text with a measured overlap of 0.952 seconds. B1, B2, B3, B4 and B12
  passed while all 171 simulated-person characters arrived.
- A fresh GTK4 editor also passed multiline text readback, selection,
  deselection and scrolling with B1, B2, B3, B4 and B12 passing.
- The plugin built and loaded against the matching Hyprland ABI. Ordinary and
  primary selection guards share installation and restoration mechanics.
- The cached antialiased cursor passed a current-build click-through check:
  a real private-lab pointer click inside its arrow reached the underlying
  canvas. Its private screenshot was inspected. The complete visual matrix and
  reference comparison remain not measured.

Exact local source hashes, reports, screenshots and failed attempts are retained
in ignored evidence storage. They are not distributed as raw workstation data.
These results cover the isolated Fedora Hyprland lab only. Existing lab copies
of the owner's input settings do not establish live-session acceptance.

## Acceptance and outstanding requirements

Project diagnostics passed: typecheck and the full bounded suite, 571 passed,
45 skipped, zero failed. The skips do not establish native coverage.

To reproduce project diagnostics, run `bun run scripts/limited.ts bun run typecheck`, then
`bun run verify`. These checks do not establish native release acceptance.
Use `lab.py run LAB -- /usr/bin/python3 harness.py --agent COMMAND` for a bounded
private-lab task measurement. The full native acceptance runner remains pending.

Not measured or incomplete: actual owner-session integration and theme matching,
protected/full system settings, durable action journal, complete toolkit matrix,
owner-focus clipboard transitions, primary middle-button paste, pending-input
unload, XWayland and a comparative performance benchmark. Writer bulk input
previously crashed; paced input passed, but a general backend fix is pending.
No zero-cost or faster-than-current-runtime claim is made. A failed, missing or
stale required check prevents release acceptance. This change can be reviewed
as experimental source without being presented as a completed product release.

## Source binding

- `plugin/ghostinput.cpp`: `3ebaa36827ca7ee559fb7b3715e58545deb81add231442bfc3e0f21d8beb82ce`
- `ghost.py`: `4d2bb02cb92ec3bbe4021c1cfd788b532b6ad05ac817efa782a5c4a48aebb840`
- `harness.py`: `cd3ecefa7ba1477cad380d7b8a7d0e446aa43c2ec3aa7c9acb84a3c00cd868c0`
- `process_scope.py`: `6e2282149954a64741cb62f7b7fa8962808955a86ba51872301731ddc3e48afa`
- `agent_launch.py`: `93d2cec4df05d3858e6b91a7856e3ab6d5d6c3f611ce6339cef8680c3ae0faa4`
- `clipboard_task.py`: `4a90cf44e7ec9fedf07df912eeff77ec97621a3aac4743bae9031ce52af20b6f`
- `native_fresh_task.py`: `96d2f01f32794501c50b8ae1ff670a4f1ab8bd06c0e67977e2f4bef11428d69a`
