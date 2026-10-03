# Ghost cursor: background computer use on Hyprland

Goal: an agent operates real native applications on the person's own Hyprland session, with a
second visible cursor of its own, while the person keeps working. Nothing the agent does may move
the person's pointer, change what has their keyboard focus, raise or hide their windows, switch
their workspace, or let a keystroke cross between the two of them. Not a browser.

## The bar

**Named reference:** Codex Computer Use on macOS (OpenAI, April 2026), as documented by OpenAI and
described by MacStories: the agent reads the accessibility hierarchy of any window, sees and acts
with its own cursor, runs in the background without bringing apps to the foreground, and several
agents can run in parallel.

It cannot be run on this machine, so the bar is a **spec bar** derived from it, written before any
building. Each line is checkable and has a number.

| ID | Criterion | How it is measured |
|---|---|---|
| B1 | Zero pointer movement caused by the agent | Person's cursor position sampled every 5 ms during a run; any change not caused by the person's own simulated input fails |
| B2 | Zero keyboard or pointer focus change seen **by the person's application** | The person's stand-in app runs under `WAYLAND_DEBUG=client`; count of `wl_keyboard.enter/leave` and `wl_pointer.enter/leave` during the run must be 0. `hyprctl activewindow` alone is not evidence |
| B3 | Zero keystroke leakage in either direction | The stand-in types a known text continuously while the agent types another known text; each app must end with exactly its own text |
| B4 | No raise, workspace switch, or stacking change on the person's monitors | Client list, workspace and active workspace per monitor snapshotted before and after, plus `activewindowv2`/`workspace` events; must be identical |
| B5 | Agent windows never take focus on spawn | Launching a target app during a run satisfies B2 and B4 |
| B6 | The agent sees its target while the person cannot | Accessibility tree read and fresh pixels (`grim -T`) of a target that is not on any visible workspace; pixels must change after an action |
| B7 | A fixed task list passes across the toolkit matrix | GTK4, GTK3, Qt, Chromium or Electron, Firefox, LibreOffice, one XWayland app; per toolkit: read state, press, type text, select, scroll, read result |
| B8 | Raw input where no accessibility path exists | A click and a key at pixel coordinates inside a background canvas app land in that app and satisfy B1 to B4 |
| B9 | The second cursor is visible and never intercepts input | An overlay cursor drawn where the agent acts; the person's clicks at the same spot reach the window beneath (click-through measured, not assumed) |
| B10 | Two agents at once | Two agents on two targets, each with its own cursor, while the person types: B1 to B4 hold |

B9 also has a fetchable reference: OpenAI's demo footage of the Codex cursor. That slice gets a
labels-off visual comparison against it.

## Rules for the evidence

- The harness must first **catch deliberate violations**: a `focuswindow`, a real click, a stray
  keystroke. A zero from a harness that has never failed is not a measurement.
- An unrun criterion is `not measured`, never a pass.
- Development happens only in the lab (`lab.py`): headless KWin hosting a nested Hyprland with its
  own bus, accessibility bus, runtime and XDG directories. Nothing reaches the person's screen.
- No `ydotool` or other uinput tool, ever: the kernel device is the person's session.
- Acceptance on the person's live desktop is one consented step at the end.
