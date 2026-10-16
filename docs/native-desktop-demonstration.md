# Earlier native desktop demonstration

The conversation "تحقق من دعم تطبيقات سطح المكتب"
(`01a13ab3-f686-7583-900b-ecd54079a602`) records a working native accessibility
demonstration. It must not be conflated with the separate compositor plugin
handoff incident.

## What the recorded demonstration did

The command in turn `01a13ab9-51c9-7ff3-9618-a68aabe0e35f` selected
GNOME Calculator through `pyatspi`, invoked its accessible buttons
`C`, `7`, `×`, `9`, `=`, and checked that an accessible label contained `63`.
It recorded system cursor position and active window identity before and after.
The conversation reported both unchanged. A separate visual overlay displayed
the agent pointer; its coordinates did not deliver application input.

This is historical demonstration evidence, not a fresh execution. The temporary
report `/tmp/orbit-desktop-demo/independent-action-report.json` was unavailable
when checked on 16 October 2026. The retained conversation contains the command;
the missing report must not be presented as a currently verified artifact.

The demonstration used native accessibility actions, not browser DOM actions,
browser profile copying, or the compositor plugin's existing-window claim.
It therefore establishes a useful implementation direction without proving that
the plugin handoff is safe or that every application supports the same actions.

## Connection to the current product

`experiments/ghost-cursor/atspi_tool.py` already implements experimental native
tree inspection, accessible button actions and editable text operations. It is
not a public session adapter. Its name matching and first matching button rules
are probe conveniences, not a sufficient production target identity contract.

The remaining integration must use acknowledged process and element identities,
respect session pause and lifetime, and verify behavior on owned applications in
an isolated desktop. Acceptance must check the resulting application state and
preservation of the stand-in user's pointer and focus. A successful button action
does not establish arbitrary keyboard, drag, window move or account handoff
support. Unsupported native operations must remain explicit failures, without a
browser automation fallback.

The existing owner handoff [release hold](native-handoff-incident.md) remains in
effect. This historical demonstration does not authorize bypassing that hold or
running probes against the person's current applications.
