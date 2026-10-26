# See original native applications

For ordinary web tasks, prefer the AI host's built-in browser or its normal web
tools. Orbit provides native desktop application control, not a browser-specific
session backend. Use Orbit for original installed desktop application tasks. Use
the owner's normal browser or personal profile through Orbit only when the owner
explicitly requests that browser or profile. Original browser and terminal
registrations remain supported; this routing preference is not a category ban.
Never copy profiles or create a hidden substitute desktop.

Choose a numbered workspace, for example 2, and open a discovered native
application there through Orbit. Opening does not make a hidden workspace visible
or select a monitor automatically. Use the explicit presentation step below, or
view the numbered workspace yourself. Orbit requests silent placement with no initial
focus. The live report does not establish continuous focus preservation. The window
keeps its normal owner configuration and stays open.


Opening requests silent placement, no initial focus and disabled focus-on-activation.
An existing activation server can activate its application before request
attribution. Orbit does not dispatch owner refocus or warp the physical pointer
back. If a new exact candidate already has owner focus, it returns `opened:false`
with `candidateReason:owner-input`, without post-map placement. Inspect that
candidate without taking owner input. A focus race after earlier placement
returns opening uncertainty rather than claiming no placement happened. These
checks do not prove that arbitrary applications never activate themselves.

The panel reports native state. There is no substitute desktop viewer, browser
viewer, private session or profile copy. Opening an app does not establish input
support. Visible agent pointer and native input require the loaded plugin source and
compositor ABI to match. See [current actual acceptance](acceptance.md).
A shared D-Bus activation process yields an unmodified candidate, not a claimed
launch identity. Inspect that candidate before selecting an exact handoff.

During native control, the original soft edge glow marks the monitor displaying
the controlled workspace. It retains Orbit blue (`#255fce`) by default, the
original gradient and eased breathing rather than a solid border. The numbered
workspace label and render-only agent pointer identify where Orbit is working.
The pointer is separate from the owner's physical mouse. A short ring marks
actual clicks. Pause hides the activity cues; resume restores the enabled cues.

The existing panel settings `frameColor`, `framePulse` and `frame` are read at
handoff. Changes are not live-applied to an existing lease. `accent` resolves
supported user GTK CSS colour definitions when available; the complete running
GTK theme is not evaluated. An unresolved accent uses the original Orbit blue
fallback and records that limitation in the worker log. A disabled `frame`
setting keeps the edge glow disabled.

Read `orbit_monitors` before selecting a presentation output. It returns connected
monitor names, their displayed workspaces and focus, without owner window titles.
For example, only if the returned output `HDMI-A-5` is unfocused:

```json
{"requestId":"show-calculator-workspace-2","workspace":2,"monitor":"HDMI-A-5"}
```

Send that object to `orbit_present` after the original application's workspace
exists. The tool requires a matching source/ABI native plugin and presents the
workspace directly on the chosen unfocused monitor. It never chooses an output
automatically. If no unfocused output is available, leave the owner's active
output alone; the person can choose when to view the numbered workspace.

Presentation does not use focus-then-return, cursor warps or global focus-setting
changes. It refuses to replace the owner's focused output, hide a special
workspace or move a workspace already displayed on another monitor. Success
reports `ownerFocusPreserved: "during-presentation"` and
`sampled: "compositor-acknowledgement"`. This is the compositor's bounded check,
not a continuous future guarantee or screenshot proof. Verify actual visibility
with the displayed monitor/workspace and a full desktop capture.

Reuse the same `requestId` after an uncertain response and inspect monitors.
`PRESENTATION_NOT_READY` is a pre-mutation refusal; retry unchanged parameters
with the same identity only after the condition clears.
`PRESENTATION_UNCONFIRMED` can follow mutation and stays cached; never repeat it
blindly with a new identity. Deduplication lasts for
the current broker process. After a broker restart, inspect the actual state.
Application opening and handoff remain separate from presentation. Other
compositor adapters need their own implementation and acceptance.

Use [the CLI](cli.md). Report an unsupported app rather than substituting another
application instance or profile. Never infer signed-in status from process or
window metadata.

Original application windows open floating and centered, default 960 by 640 logical
pixels. Optional `window: {width, height}` sets a custom size. The opener fits it to
the target monitor's scaled work area and verifies floating state, actual size and
bounds before reporting success. A tiled or clipped acknowledgement is not success.
Close only newly opened test windows after their inspection, using their exact
acknowledged identity. Preserve pre-existing windows and unsaved content prompts.

Terminal-hosted registrations (`Terminal=true`) first use xdg-terminal-exec. If
it is absent, the resolver can use an installed original Ptyxis, Konsole or
GNOME Terminal registration. The command and literal arguments run in that
terminal's ordinary owner state. Without any supported terminal host the error
names that missing dependency. Terminal emulator registrations themselves do not
need this dispatcher.
