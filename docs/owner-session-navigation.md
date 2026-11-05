# Owner-directed session navigation

Owner requirement, 5 November 2026: background work and screenshots must not
switch the desktop or focus a window. Clicking a session card should navigate
to that session's exact retained native window.

## Separation

- Background agent `native.present` requests are refused. The monitor read and
  background observation paths remain read-only and do not call navigation.
- A focused opening candidate is never treated as temporary map focus based on
  its age or a stationary pointer. Before placement it is returned as owner-input;
  after prior placement it stays uncertain. No automatic owner refocus or warp-back
  is attempted. This removes the known active-window relocation exemption, not
  arbitrary application activation behavior.
- Only the explicit card clicked handler calls `select_session`, which sends one
  owner-credentialed `session.reveal` request. Polling, reconnect, presence, capture
  and detail refresh do not invoke it. Detail refresh no longer grabs GTK focus.
- The broker accepts only a verified owner and a session ID. The panel cannot
  supply an address or workspace, and no reveal model tool is added.
- The worker resolves the retained application/window identity and atomically
  checks mapped state, stable ID and PID in Lua before focusing that exact window.
  It checks the dispatcher result and resulting active identity/workspace. There
  is no address-only fallback or automatic navigation retry. Closed or replaced
  windows refuse rather than navigating to a different target.

## API evidence and limits

The focus binding was checked against [Hyprland v0.57.1 dispatcher source](https://github.com/hyprwm/Hyprland/blob/v0.57.1/src/config/lua/bindings/LuaBindingsDispatchers.cpp).
The [window binding](https://github.com/hyprwm/Hyprland/blob/v0.57.1/src/config/lua/objects/LuaWindow.cpp)
exports stable_id as a hexadecimal string and pid as an integer. The supported
shape is `hl.dispatch(hl.dsp.focus({window=selector}))`, whose result has `ok`.
This deliberate owner focus action may switch workspace and move the physical
pointer as part of compositor behavior; it is not background input.

Pure panel, fake transport and broker boundary fixtures qualify the code paths,
not live desktop behavior. No actual focus, workspace navigation, screenshot or
original application launch was executed for these tests. A compatible Lua
configuration is required; unavailable support refuses. Running broker/panel
instances do not update merely because source changes. Never restart shared
services while another task is active. No live performance benchmark is claimed.

## Verification and current rollout

The targeted owner-navigation, presentation-authority and opening suites passed.
An exact staged-source export passed strict TypeScript checking; its full run
passed 1131 tests, skipped 5 and failed one diagnostic-code allowlist test. The
missing APPROVAL_REQUIRED code was then registered and that suite passed. A
second full run was deferred while host available memory was below 5 GiB and
full memory PSI exceeded the permitted test gate. After capacity recovered, the
complete staged-source verifier passed 1132 tests, skipped 5 and failed 0 across
118 files in 84.54 seconds. After preserving the concurrent opening changes in
5739edd, a fresh integrated staged export also passed strict typing and the full
verifier: 1133 passed, 5 skipped, 0 failed across 119 files in 84.94 seconds.
Tests were not weakened.

A read-only broker listing found one paused native session and the rest closed.
No session was ended and no shared service restarted for rollout. Source changes
are not evidence that the running broker or panel has adopted the new behavior.
