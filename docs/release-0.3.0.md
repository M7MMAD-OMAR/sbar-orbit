# Orbit 0.3.0

Original installed applications use their registered launchers, ordinary user
state and visible numbered Linux workspaces. Browser, terminal, interpreter and
vendor-wrapper categories no longer have a separate prohibition. Private
desktops, copied browser profiles and the retired browser viewer stay absent.

Native handoff uses the ordinary shared system clipboard and PRIMARY selection,
as explicitly chosen by the owner. Copy can replace the system clipboard just
like a person copying in that application. Ordinary handoff enrolls client
windows. A cross-client parented dialog enrolls only its selected dialog family,
while clipboard and seat protocol authority remains client-wide. If any surface
of that client is receiving owner keyboard or pointer input, handoff returns
`OWNER_BUSY` before enrollment or lease mutation. It preserves owner focus and
physical pointer coordinates. Existing owner work must be preserved.

The historical compositor incident is retained as evidence. It is no longer a
permanent static native-control ban. A claim still verifies the actual plugin
source and running compositor ABI. The registry package now includes the source
needed for that verification. This is cooperative application control, not an
OS security sandbox or a way to bypass OS permissions.

The opener reports actual floating geometry when a toolkit negotiates another
bounded size, checks the actual workspace monitor and waits for cold toolkit
startup. A unique startup activation token correlates a forwarded Wayland window with
its actual request. Owner-lifetime launch scopes supplement launcher ancestry
for applications that detach. Registered D-Bus credentials alone produce only
an unmodified candidate; a shared process cannot prove which action made a
window. Existing windows are
excluded from new-window attribution. An uncertain opening is never blindly
replayed. Reuse the same requestId and inspect candidates.


Opening requests silent placement, no initial focus and disabled focus-on-activation.
An existing activation server can activate its application before request
attribution. Orbit does not dispatch owner refocus or warp the physical pointer
back. If a new exact candidate already has owner focus, it returns `opened:false`
with `candidateReason:owner-input`, without post-map placement. Inspect that
candidate without taking owner input. A focus race after earlier placement
returns opening uncertainty rather than claiming no placement happened. These
checks do not prove that arbitrary applications never activate themselves.

Atomic post-map placement of activation-token and launch-scope windows currently
requires Hyprland's Lua config manager (`eval`). With a non-Lua configuration,
ordinary exec-rule opening can use the existing dispatch fallback, but forwarded
placement returns `OPENING_UNCERTAIN` rather than inventing success or switching
focus. That non-Lua forwarded path has no live acceptance on this host. Inspect
the mapped candidate before doing anything further; never blindly relaunch it.

Keyboard preparation retains the target client's own focus between shortcuts.
An unrelated later size/configuration acknowledgement does not invalidate a
completed focus handshake. Both target capture and desktop rendering account for client decoration
geometry and preserve viewporter source coordinates. Native pointer positions
use that same geometry. The original soft gradient glow is retained at the monitor
edges, with the numbered workspace label and a separate render-only agent cursor.
The default is the original Orbit blue (#255fce), with a 120 pixel wash and
2600 ms eased breathing. The gradient opacity stops remain .80, .45, .20, .07
and 0 at positions 0, .18, .4, .68 and 1. The activity cues hide on pause and
return on resume according to the enabled frame settings. A brief ring marks clicks at the actual input location. Only the latest interaction pointer is drawn per monitor. New windows created by an
actively controlled client receive the selected floating size request and workspace rule; verify actual toolkit geometry. These changes have actual
editor and Calculator evidence, not only protocol fixtures. New cross-client portal dialogs follow a verified compositor parent to the same workspace before mapping. Their input still requires a separate exact handoff. A terminal control-ended response also closes the backend so broker status cannot keep advertising a running actor.

`close-window` requests normal closure of one exact acknowledged window. Verify
its disappearance and handle unsaved prompts. It never kills the application
process. `stop` and legacy `close-application` hand control back and leave the
application open; their replies now make that distinction explicit.

Generated host registrations carry the adapter version so configuration watchers
can distinguish an upgrade even when the stable launcher path stays the same.
An already running host may still need its supported MCP refresh operation.

See [current native acceptance](native-acceptance-0.3.0.md) and the
[platform matrix](support-tiers.md). Other Linux compositors, Windows and macOS
have no implemented native opening/control adapter. Real compatibility is stated
per application and operation. This release does not certify every application,
account, operating system or future compositor update.

The shared clipboard is bidirectional. Active leased clients receive the current
clipboard and PRIMARY selection, including later owner copies or text highlights,
even while unfocused. Their Copy actions can replace those same owner selections.
Pause stops agent actions, new lease broadcasts and the lease's unfocused
selection-write exception. Resume refreshes the current shared selections.
Pause does not revoke ordinary OS clipboard access or previously offered data;
this is not a clipboard privacy boundary.

`orbit_monitors` and `orbit_present`, with CLI equivalents `native-monitors`
and `native-present`, expose explicit monitor selection. Opening never presents
a workspace automatically. Presentation checks the matching native build, avoids
focus-then-return and reports focus preservation only during its compositor call.
Uncertain replies are cached by request identity within the broker process;
inspect the actual displayed workspace before further work.

Native handoff reads existing `frameColor`, `framePulse` and `frame` panel
preferences at handoff. Existing leases do not reload those preferences live.
The accent resolver supports explicit user GTK CSS definitions, not the entire
running theme; unresolved accent reports the original Orbit blue fallback.


The latest [real acceptance evidence](native-acceptance-0.3.0.md) separately
records a shared portal client's unrelated dialog excluded while two original
applications kept their dialogs on distinct numbered workspaces, and an actual
public `NATIVE_INCOMPATIBLE` handoff error with actionable rebuild guidance.
Neither a fixture nor a shared service PID is treated as application acceptance.

Privately inspected settled full-desktop captures with loaded plugin source
`0d0f6e51e862ffbe090e8e7e41becbc34b0346a67382303e8fe224e9be71fd25`
showed original Calculator throughout active, paused and resumed states. The
restored blue gradient, workspace 7 label and agent pointer appeared active and
resumed, and disappeared paused. The laptop remained focused on workspace 1 in
all three metadata samples. Stills do not certify exact breathing timing or
continuous interference freedom. This run retained `OPENING_UNCERTAIN`, followed
by separate exact candidate inspection and handoff without relaunch; it is not
reported as a clean opening pass.

A real public broker presentation then changed the explicit unfocused external
output from workspace 7 to 4. Before and after monitor reads kept the laptop
output focused on workspace 1. The reply limits focus preservation to the
compositor presentation call. The exact test Calculator was normally closed,
workspace 7 was verified empty and its session stopped. These earlier Linux results do
not establish Windows native control or a current-source external application
workflow. Later measurements retain their own source identities below. Private owner desktop images and identifiers are not
included in the public repository.


Cold application startup now has a 60 second discovery interval with matching
outer worker and IPC bounds, after an actual Calculator took about 33 seconds
to map. Native indicators honor custom HOME and XDG_CONFIG_HOME settings roots.
A fresh external agent received the public monitor/presentation tools and
completed real Calculator, shared clipboard and Arabic Save operations on plugin
source `59bd03af9d90`. This is historical evidence, not a current-source pass. Its shortcut mistake changed a restored tab grouping; the
coordinator restored the original grouping and verified unchanged file bytes
before normal closure. This intervention is disclosed in the acceptance record,
rather than reporting the run as an uninterrupted preservation pass.

The public native key action also accepts enter as an alias for Return, including
modified chords. Original XKB key names remain supported.

The later plugin source `e018e8b8e987` has full physical display measurements for
the original gradient, label, pointer and pause/resume states. Its fresh external
MCP process received current tools but saw only one owner-focused output and
stopped before opening or input. The current-source external application
workflow remains unmeasured. See [the acceptance record](native-acceptance-0.3.0.md).
