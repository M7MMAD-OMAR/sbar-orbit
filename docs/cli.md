# Native application CLI

Use `./bin/sbar-orbit` from this checkout or the installed `sbar-orbit` launcher.
Original installed applications, including browser and terminal registrations,
use visible numbered workspaces. Private desktop sessions are absent. See [the contract](desktop-only.md).

```sh
sbar-orbit applications
sbar-orbit applications Calculator
sbar-orbit native-monitors
sbar-orbit native-open '{"workspace":2,"applicationId":"org.gnome.Calculator.desktop"}'
sbar-orbit native-open @/absolute/path/open.json
sbar-orbit native-candidates 2
sbar-orbit session list
```

Use an exact discovered registration ID. Opening keeps the normal owner profile,
leaves the application open, and requests silent workspace placement with no initial
focus. Continuous focus preservation is not established; see [the live report](native-opening.md).

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

`ORBIT_REQUEST_ID` binds retries to one opening request. After uncertain delivery,
inspect candidates before retrying. Discovery and opening do not prove signed-in
state. `session create`, browser previews, cloned profiles and account snapshots
are unavailable. No hidden-session setting exists.

`native-monitors` reads connected output names, displayed workspaces and focus,
without window titles or capture. After opening an application, choose one of
the returned unfocused outputs explicitly. Opening never presents automatically.
For example, if `HDMI-A-5` is connected and unfocused:

```sh
sbar-orbit native-present '{"requestId":"show-calculator-workspace-2","workspace":2,"monitor":"HDMI-A-5"}'
sbar-orbit native-present @/absolute/path/presentation.json
```

`native-present JSON|@FILE|-` also accepts standard input. Supply a stable
`requestId` in the document, or set `ORBIT_REQUEST_ID`; otherwise the CLI generates
one. Reuse the identity after an uncertain reply. The broker rejects a conflicting
workspace or monitor for an existing identity, and does not replay an uncertain
mutation. This cache lasts for the current broker process. Inspect actual monitors
before further work after a restart. `PRESENTATION_NOT_READY` means the operation
was refused before mutation, including worker startup or compositor readiness. After the condition clears, retry the same requestId
with unchanged parameters; a changed payload still conflicts.
`PRESENTATION_UNCONFIRMED` can follow a mutation and stays cached, so an uncertain
acknowledgement does not prove the display stayed unchanged.

Presentation uses the compatible native plugin on an explicit unfocused monitor.
It does not focus the agent workspace then restore the owner, move the physical
pointer, or choose another output. A successful reply confirms visibility and
owner focus preservation during that compositor call only. Read monitor metadata
and capture the full desktop to check actual visibility. A person with no free
unfocused output can choose when to view the numbered workspace themselves.

The managed broker needs `ORBIT_NATIVE_PLAN` and `ORBIT_NATIVE_CONTROL` configured
from `native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY`. The directory holds
owner-only transport metadata, not an application profile or desktop session.
Preparation starts no applications. Owner settings select protected mode with
exact action approval, or full mode using standing owner authorization. Native
control needs a prepared, loaded plugin matching current source and compositor ABI.
A historical acceptance file is not a runtime permission switch.

```sh
sbar-orbit status
sbar-orbit doctor
sbar-orbit doctor --report
sbar-orbit diagnostics
sbar-orbit config list
sbar-orbit config search WORD
sbar-orbit usage off CONVERSATION_ID
sbar-orbit usage on CONVERSATION_ID
```

`native-settings` opens the native control settings. `settings` shows the native
configuration notice, `config` edits supported panel settings. No command opens
a browser viewer. Original browser registrations use native-open. The panel shows
native status without a substitute desktop viewer.

Existing application handoff is experimental. With the compatible plugin loaded,
`session handoff JSON|@FILE|-`, `act ID JSON|@FILE|-`, and session pause, resume,
observe, journal and stop act only on acknowledged native targets. Stop returns
a handed-off application without closing it. Never claim these operations work
on the owner compositor from unit fixtures alone.

Installation uses `./install.sh --dry-run --json` and `./install.sh --json`.
The removed private runtime cannot be installed with `--native`. Staging or
publishing does not activate a running broker. Never restart a shared service
while another task has active work.

Original application windows open floating and centered, default 960 by 640 logical
pixels. Optional `window: {width, height}` sets a custom size. The opener fits it to
the target monitor's scaled work area and verifies floating state, actual size and
bounds before reporting success. Toolkit size constraints return actual geometry and
windowAdjustment metadata. A tiled or clipped acknowledgement is not success.
Close only newly opened test windows after their inspection, using their exact
acknowledged identity. Preserve pre-existing windows and unsaved content prompts.

The opener waits up to 60 seconds for cold toolkit startup and window mapping.
Its framed worker allows 75 seconds, the IPC client 80 seconds and the broker
90 seconds for that operation. Opening identity tickets last 90 seconds. Other
exchanges retain their shorter bounds. An uncertain opening retains its receipt and does not kill
the original app. Inspect candidates before retrying the same request identity.
