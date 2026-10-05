# Existing application handoff

This path borrows an already-open application on the configured Hyprland display.
It preserves the running process, current page, and unsaved document. Stopping
the Orbit session hands control back; it does not close the application.

The grant covers an entire Wayland client. A browser's separate windows can
belong to the same client, even when they occupy different workspaces. A workspace
selects a candidate; it is not an isolation boundary. Use a different application
while the agent controls the handed-off client.

## Select and hand off

The owner must first configure the native backend with the exact prepared
compositor and plugin. Handoff does not load an arbitrary plugin or change those
settings. Native protected/full controls still apply, as does session policy.

List candidates without capturing their contents:

```sh
sbar-orbit native-candidates 8
```

For a workspace with exactly one candidate:

```sh
sbar-orbit session handoff '{"workspace":8,"policy":{"mode":"autonomous","origins":"any","allow":["read","write"]}}'
```

If several candidates exist, include the exact `address` and `stableId` returned
by the candidate listing. The claim validates the live window again. The response
returns `handoff.appId`, the whole-client scope, and the included window handles.
Native `windows`, `text`, `key`, `click`, `scroll`, and observation actions use those
generated `appId` and `windowId` values. Actor actions cannot select a different
compositor or change global native controls.

Observation returns the current committed application frame. An input response
does not acknowledge that the application has finished painting its result.
Observe again until the intended visual state appears; `capturedAt` is the
capture time, not a promise that all earlier inputs have been painted.

The MCP equivalents are `orbit_handoff_candidates` and `orbit_handoff`. Existing
`orbit_act`, `orbit_observe`, `orbit_pause`, `orbit_resume`, and `orbit_stop` operate
on the returned session. Omitting policy keeps the normal session policy.

## Lifecycle

Pause waits for admitted actions and pauses the compositor lease. Resume must
successfully restore that lease before the session accepts actions. Returning
to the application with the person's physical input ends its agent lease before
normal input enters the application. Start a new explicit handoff to continue
after that return.

The controller retains its lease identity before requesting the compositor claim.
If a response is lost, cleanup uses that identity to hand back the application.
Cleanup errors keep private diagnostics instead of pretending the application
was returned successfully.

In protected mode, approval binds the selected workspace and exact window
identity. Retrying after approval can use a new recovery identity without
granting a replacement window that happens to occupy the same workspace.

## Support evidence

Owner-session acceptance: **not measured**. Universal application support:
**not measured**. This document describes the endpoint under development and
does not make installation a passing measurement.

XWayland applications, active grabs or drags, existing data-control devices, and
applications owning the person's global selection source are rejected by the
initial claim. Independently connected helper windows are outside the grant.
Toolkit and popup behavior must be reported at the tier actually measured.
