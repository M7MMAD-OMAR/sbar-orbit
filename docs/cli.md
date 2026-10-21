# Native application CLI

Use `./bin/sbar-orbit` from this checkout or the installed `sbar-orbit` launcher.
Only original native application opening is supported. Browser launching and
private desktop sessions were removed. See [the contract](desktop-only.md).

```sh
sbar-orbit applications
sbar-orbit applications Calculator
sbar-orbit native-open '{"workspace":2,"applicationId":"org.gnome.Calculator.desktop"}'
sbar-orbit native-open @/absolute/path/open.json
sbar-orbit native-candidates 2
sbar-orbit session list
```

Use an exact discovered registration ID. Opening keeps the normal owner profile,
leaves the application open, and requests silent workspace placement with no initial
focus. Continuous focus preservation is not established; see [the live report](native-opening.md).
`ORBIT_REQUEST_ID` binds retries to one opening request. After uncertain delivery,
inspect candidates before retrying. Discovery and opening do not prove signed-in
state. `session create`, browser previews, cloned profiles and account snapshots
are unavailable. No hidden-session setting exists.

The managed broker needs `ORBIT_NATIVE_PLAN` and `ORBIT_NATIVE_CONTROL` configured
from `native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY`. The directory holds
owner-only transport metadata, not an application profile or desktop session.
Preparation starts no applications and grants no input authority. Protected mode
requires approval for the exact opening action. Native settings do not release
the [compositor crash hold](native-handoff-incident.md).

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
a browser. The panel shows native status without a substitute desktop viewer.

Existing application handoff is experimental and currently held. Once released,
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
bounds before reporting success. A tiled or clipped acknowledgement is not success.
Close only newly opened test windows after their inspection, using their exact
acknowledged identity. Preserve pre-existing windows and unsaved content prompts.
