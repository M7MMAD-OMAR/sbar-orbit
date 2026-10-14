# Desktop guide and local application pilot

Recorded 14 October 2026 on one Fedora 44 and Hyprland 0.56.2 workstation.
Tier: **Limited, owner-authorized demonstration**. This is separate from Orbit
session acceptance and does not release the [native handoff hold](native-handoff-incident.md).

## What was observed

The owner explicitly requested opening real installed applications on workspace 2
and capturing their visible state. A direct, ordinary compositor launch opened
Kitty, GNOME Text Editor, GNOME Calculator and Nautilus. Their windows and pixels
were inspected. Text was entered and saved in the editor, and the resulting file
was read from disk. A separate Kitty command generated a small results file,
which appeared in Nautilus. These operations were outside Orbit's session API.

The first pointer demonstration moved the owner's real pointer. The owner
rejected that behavior, and global pointer and keyboard operations were stopped.
That attempt is a failure of the independent-pointer requirement.

A later demonstration used application accessibility actions for the calculator
buttons C, 7, multiply, 9 and equals. The result 63 was read from the application
and inspected in a screenshot. Sampled owner pointer coordinates and active
window identity matched before and after that sequence. A separate, click-through
overlay drew a cyan pointer labeled Codex above the intended button. The overlay
is a visual guide; it does not deliver pointer events or establish an independent
input device. Accessibility behavior in other applications is not measured.

The owner requested simpler styling. The approved preview uses a compact Orbit
badge, a smaller arrow and rounded Codex pill, and a softer monitor border.
Private desktop screenshots and raw state remain local and are not release assets.

## Preserved failures

- Opening Telegram through `orbit_open` returned `UNSUPPORTED` with
  `Native opening is not configured`. No window opened through that attempt.
- One existing Google Chrome window was identified on workspace 4. The connected
  Codex Chrome adapter failed while loading its browser request-header policy.
  Existing-tab control was not completed. No substitute Chrome window was opened.
- Generic control of every application, profile, path, interface or operating
  system is not measured. Successful native application opening does not prove it.

## Reusable visual preview

`desktop/guide.py` retains the approved visual design. It only renders overlays.
It imports no pointer injection, accessibility control or browser automation.
It does not start or claim applications and does not activate the native plugin.

The owner must explicitly request this on their display. Agents normally use
Orbit's private display, and this preview grants no authority over owner input.
The Linux entry point requires Orbit's shared resource budget. The workstation
also needs Python GI, Cairo, GTK3, GTK layer shell and a supporting Wayland display.
Missing prerequisites are reported; they are not installed by this script.

Create a mode 0600 regular state file owned by the current user, with exactly
integer `x` and `y` fields. Coordinates are logical pixels inside the chosen
monitor. Replace the file atomically when changing the displayed guide position.
Unknown fields, shared permissions, links and out-of-bounds coordinates are refused.
A state file that becomes invalid hides the guide until the preview exits.

From an installed or extracted source directory:

```sh
bun run scripts/limited.ts python3 desktop/guide.py \
  --state /absolute/private/position.json \
  --monitor 'EXACT GDK MONITOR MODEL' --seconds 300
```

The monitor model must match exactly one connected output. A missing or ambiguous
match refuses rather than selecting an arbitrary screen. The preview closes
after 1 to 600 seconds, or on SIGTERM. It does not start automatically with Orbit
and is not a broker or MCP capability. Performance and native plugin parity
remain not measured.

State-file contract checks:

```sh
python3 -m unittest discover -s tests -p desktop_guide_test.py -v
```

These checks exercise state validation without a display. They do not certify
rendering, toolkit coverage or application automation.
