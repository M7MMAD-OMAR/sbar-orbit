# Original application contract

For ordinary web tasks, prefer the AI host's built-in browser or its normal web
tools. Orbit provides native desktop application control, not a browser-specific
session backend. Use Orbit for original installed desktop application tasks. Use
the owner's normal browser or personal profile through Orbit only when the owner
explicitly requests that browser or profile. Original browser and terminal
registrations remain supported; this routing preference is not a category ban.
Never copy profiles or create a hidden substitute desktop.

Orbit opens original installed applications on an explicit visible numbered
Hyprland workspace on Linux, preserving their registered launcher, HOME,
configuration and normal process lifetime. Browser and terminal registrations
are accepted. Hidden substitute desktops, copied profiles and browser viewers
are absent. Caller-supplied arbitrary commands are outside the registered API.

Discover an exact applicationId, then open with workspace, requestId and optional
window dimensions. The window is requested floating and centered, default 960 by
640 logical pixels, fitted to the monitor work area. Return actual geometry,
including bounded toolkit adjustments. Newly instantiated workspaces are measured
against their actual monitor. A snapshot does not prove continuous placement.

A launch acknowledgement includes address, stableId and PID bound to its launch
receipt. Detached wrappers and single-instance forwarding can open a real window
without retaining that ancestry. Such outcomes remain uncertain; inspect exact
candidates before retrying. Never substitute another profile to obtain a success.

Explicit handoff selects an original Wayland client by exact window identity and
requires a prepared native plugin matching current source and running compositor
ABI. Native sessions default to autonomous actions with all local action classes
allowed. The owner selects full or protected action settings. Actual OS permissions
and target identity remain real prerequisites. Session stop returns control and
leaves the application running.

Observe actual application effects after redraw. A successful protocol reply does
not prove an edit, save, menu operation, account state or visible cursor. Root
window captures may not establish child dialog or popup behavior. Each complete
workflow needs application-state evidence. Historical incidents are diagnostic
records, not permanent category bans.

Respect explicit conversation off and preserve other owner work. Test only exact
newly created windows at bounded floating sizes and close them normally afterward.
Do not force-discard existing unsaved work or kill a shared application process.
Other Linux compositors, XWayland input, Windows and macOS native control need
separate adapters and real acceptance. Discovery and installation are not control.

Native application handoff uses the ordinary shared system clipboard and PRIMARY
selection. Copying can replace the person's current selection, just as normal
application use does. There is no private clipboard namespace or clipboard-owner
category refusal. This is cooperative same-user control, not a security sandbox.

The shared clipboard is bidirectional. Active leased clients receive the current
clipboard and PRIMARY selection, including later owner copies or text highlights,
even while unfocused. Their Copy actions can replace those same owner selections.
Pause stops agent actions, new lease broadcasts and the lease's unfocused
selection-write exception. Resume refreshes the current shared selections.
Pause does not revoke ordinary OS clipboard access or previously offered data;
this is not a clipboard privacy boundary.

## After the compositor restarts

A host plan and a loaded plugin belong to one compositor instance, so a Hyprland
restart makes them stale. `sbar-orbit native-refresh` renews both: it re-stages the
recorded plugin build when the compositor ABI, commit and version still match, loads it,
and swaps the `current` plan atomically. The owner's control directory, with its mode
and action log, is kept and never rewritten. A changed ABI stops with a rebuild
instruction instead of loading a mismatched binary. Record the build once with
`native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON`; the autostart entry then runs
`native-refresh --if-configured` at each desktop start, and every new worker binds the
plan `current` points to, so a running broker needs no restart.
