# Orbit 0.4.0

Released 29 October 2026. Linux (Hyprland) is the platform with native control. Every number below
was measured on one Fedora 44 Hyprland machine, and each links to the document that records its
method. Where something was not measured, it says so.

## Faster loops

- **Action batching.** `orbit_act` accepts `actions`, a list of click, text, key and move actions run
  in order, stopping at the first failure, each judged by the same policy, lease and target checks as
  a single action.
- **Settled capture.** `capture` returns a screenshot taken after the window stops changing, so the
  agent never receives a stale frame. In the recorded Calculator flow, one batched call replaced four
  tool calls and stale frames fell from 15 of 15 to 0 of 15; Orbit's own wall time rose by about 335 ms
  because it waits for the window to settle. A later change removed the pause between frames and
  shortened the quiet period: median settle time fell from 1006 to 678 ms on Chromium and from 432 to
  261 ms on Text Editor, with no stale frames. Only those two applications were re-measured. See
  [native input reliability](native-input-reliability.md).
- **Capture and input share one origin.** The capture is cropped to the window geometry, so a point read
  off an image is the point a click lands on. Firefox, which draws client side margins, previously
  missed small links by 24 by 21 logical pixels. Proved on Firefox, Chromium and Text Editor; Firefox
  keeps a margin strip that the compositor does not expose.
- **Text observation.** `orbit_observe` takes `format` of `image`, `text` or `both`. Text comes from the
  accessibility tree (AT-SPI) with roles, names, states and boxes in click coordinates, and falls back to
  the screenshot when an application exposes no tree. On a Chrome form page the text was 27 to 68 times
  smaller than the image and 1.6 to 2.3 times slower to produce. GTK4 and web content box offsets are
  corrected and measured on Chrome, Dolphin, Nautilus and Text Editor.

## More of the web works

- **Hover persists.** Menus and tooltips opened by hovering stay open until the next action, with a
  15 second limit, and never move the owner's physical pointer.
- **Press, hold, release and drag.** `mouse-down`, `mouse-up` and `drag` through the same lease and
  cleanup rules; a held button is always released on stop, error, timeout or owner input. Text
  selection by dragging works in Chromium, Firefox and Text Editor.
- **Human timed pointer.** The agent cursor travels on curved eased paths with a small overshoot and a
  few pixels of idle drift that stops at the next action. It is a render only pointer.
- **Typing that does not drop characters.** Text without a usable key mapping is pasted through the
  shared clipboard with the previous contents restored; text that cannot be delivered is refused
  definitely rather than half typed. A click waits for focus before typing.
- **Forwarded windows** (a second browser window of a running browser) are placed on the requested
  workspace.

A forty action campaign on Chromium and Firefox is recorded in [web flows](web-flows-campaign.md),
including what still fails.

## Several agents at once

[The design](multi-agent-sessions-plan.md) is implemented in the broker:

- Every session records the connection that created it. A call on another agent's session is refused
  with `SESSION_NOT_OWNED`, naming the owner and its state. Other agents see a short summary of your
  sessions, and the person sees everything in the panel.
- When an agent's connection ends, its sessions pause at once and stop after 60 seconds
  (`orbit.session.graceSeconds`). Applications stay open and leases are released.
- `orbit_stop` with `scope: "mine"` stops your own sessions and lists exactly what it stopped.
- `APPLICATION_BUSY` names the lease holder and whether its worker is alive. A lease whose worker is gone
  is reaped, and `sbar-orbit native-leases` lists leases and releases only those with a dead owner.
- `orbit_open` without a workspace picks a free numbered workspace.

## The panel is a control surface again

Session cards have Pause, Resume, Stop (asks once) and Remove, and open a detail view with the recent
actions. **About** shows the version, loaded plugin source and compositor ABI match, broker health and
the managed update flow, which refuses while sessions are active and names them. **Settings** renders
from the single settings schema with search in English and Arabic and says whether a change applies now
or at the next handoff. Cards keep a stable order, so a click cannot land on a different session.

## Limits, stated plainly

- **Windows and macOS have no native control.** What Windows has is the shared layers (launcher,
  installer, broker, MCP, autostart, resource limits), now with three Windows only defects fixed and
  runner evidence recorded. Nothing was measured on a Windows desktop. See
  [the Windows plan](windows-compatibility-plan.md).
- HTML5 drag and drop is not delivered: Wayland drives it from the seat pointer, which is the owner's
  physical pointer. Pointer event drags work.
- Tooltips and other popup surfaces are not in the capture.
- Chromium family browsers publish an accessibility tree only after the two switches on
  `chrome://accessibility` are enabled in a window the agent opened, which affects that browser process
  until it exits. Orbit does not change the owner's settings by itself.
- The managed update apply path is covered by tests with a fake feed; no real update was applied.
- Settled capture timings above come from two applications, not a full application matrix.

## Upgrade

```sh
bun add -g https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/v0.4.0/sbar-orbit-0.4.0.tgz
sbar-orbit install --connect auto
```

Restart the broker and the panel, and reload the native plugin, only when no session is active:
the plugin source changed, and an old plugin answers handoff with `NATIVE_INCOMPATIBLE`. Reload the
host's MCP connection so it sees the new `actions`, `capture`, `format` and `scope` fields.
