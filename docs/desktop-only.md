# Orbit native application contract

Orbit opens the person's original installed native applications on an explicitly
selected numbered Linux workspace. It preserves their normal HOME, configuration
and application lifetime. It never creates a substitute desktop or application
profile. Browser launch, browser automation, copied profiles, private desktops,
hidden desktops and browser-based viewers have been removed.

Use application discovery, then `native-open` with the exact `applicationId` and
workspace. Arbitrary commands and caller-supplied executable arguments are not
accepted. Browser and terminal registrations, profile overrides, shell expressions
and unsupported activation wrappers are refused. Failed opening has no fallback.
The application stays open after the opening worker exits. Opening does not switch
the person's workspace or take focus. Inspect its returned workspace and exact
window identity. An acknowledged open is not evidence of account state or input.

Input and capture of an already-open owner application remain under the compositor
crash release hold. The native handoff route must retain that hold until both its
isolated and live acceptance evidence pass. No private desktop or fresh profile may
replace a failed handoff. Current owner input acceptance is not measured.

Only this task's actions are authorized. Respect conversation off. Do not open a
browser, control the host pointer, switch the person's workspace, copy profiles,
or remove another task's work to recover from a failure. Report the actual limit.

Original application windows open floating and centered, default 960 by 640 logical
pixels. Optional `window: {width, height}` sets a custom size. The opener fits it to
the target monitor's scaled work area and verifies floating state, actual size and
bounds before reporting success. A tiled or clipped acknowledgement is not success.
Close only newly opened test windows after their inspection, using their exact
acknowledged identity. Preserve pre-existing windows and unsaved content prompts.
