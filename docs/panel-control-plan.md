# Panel control plan

Written 29 October 2026. Status: plan, nothing built yet.

## The problem

The owner can see active sessions in the panel and can do nothing with them: no stop,
no pause or resume, no version, no update, no customization, no feature surface. Every one
of those exists in the broker or the CLI. None of it is reachable from the desktop.

## Cause, from the code and git history

This is our regression, not a GTK or platform limit.

1. Until 13 September 2026 the desktop had a real control surface: a viewer (`viewer/`, a web
   page with a session rail, filters, session tools, an Arabic and English switch, a settings
   view, session removal) and a native `desktop/session_window.py`. `docs/viewer-design.md`
   at `189c377^` describes it.
2. Commit `189c377` "Remove browser and private sessions" deleted the viewer and the session
   window, because they were built for browser and private desktop sessions. The control
   surface was collateral: it served native sessions too, but it was bundled with what was
   removed.
3. What replaced it is three stubs in `desktop/panel.py`. `watch_sessions`, `open_viewer` and
   `open_settings` each only call `set_expanded(True)`. A session card (`Panel.card`) is a flat
   button whose click expands the panel and nothing else.
4. The backend is intact. The broker already answers `session.stop`, `session.pause`,
   `session.resume`, `session.forget`, `session.journal`, `session.control`. The CLI has
   `status`, `doctor`, `diagnostics`, `config`, `usage`. `desktop/orbit_settings.py` is still the single
   schema and validator, searchable in English and Arabic. `src/native/settings.py` has a GTK
   window, but it controls the action journal and approval mode only, not the panel.
5. Updates are designed (`docs/updates.md`: idle lease, serialized activation, health check)
   but have no desktop entry point, and the app version (`package.json` 0.3.3) is shown nowhere.

So: backend complete, front end removed, panel reduced to a status mark.

## Design principles

- One surface, native GTK4 (the contract in `docs/desktop-only.md` forbids a browser viewer
  and hidden substitute desktops, so the old web viewer is not restored).
- The mark stays a mark. Controls live in the expanded panel and in one window opened from it.
- The broker stays the owner of state. The panel calls `session.*` over the existing owner-only
  socket through `desktop/panel_broker.py`; it never writes state itself.
- Every destructive or interrupting control asks once in place (the pattern the old viewer used
  for removing a session), and says what happens: "Stop returns control and leaves the
  application open" is the real contract and must be written on the control.
- Arabic and English, right to left handled with logical properties, Western digits, 12-hour
  time, no guillemets, as in the rest of the project.
- Colour and shape carry state together (working, paused, idle, offline), reusing the panel
  palette and `SURFACE_CSS`, which must keep loading above user priority.

## Scope, in build order

### 1. Session controls on each card (smallest, highest value)

Each card gets: Pause or Resume, Stop, and for a closed session Remove from list. A card
shows agent, task, app and window title, workspace number, state chip, last activity time,
and the lease holder. Stop asks once. Uses `session.pause`, `session.resume`, `session.stop`,
`session.forget`. Refused states (`SESSION_OPEN`) show their message, not a failure.
Tests: a fake broker over a Unix socket for `panel_broker.py`, plus an Orbit display run for
the widgets (an import check passes while a widget still fails, see the panel split notes).

### 2. Session detail and journal

Selecting a card opens a detail view: recent actions from `session.journal` with result and
time, current target window, handoff scope, clipboard mode, and a Copy report button that uses
`doctor --report` data without the metadata the diagnostics rule excludes. This is the
"what is the agent doing and did it work" view the owner cannot get today.

### 3. About, version and updates

A footer row: Orbit version, loaded plugin source and compositor ABI match (the same check
handoff does), broker uptime, and whether an update is available. An Update button runs the
managed update from `docs/updates.md`, which already refuses while a session is active or
starting. When it refuses, the panel says which sessions block it and offers Stop all idle.
It never restarts a shared broker with active work.

### 4. Settings inside the panel

A native settings page rendered from `desktop/orbit_settings.py` `SCHEMA`: groups, search in
both languages, per-setting reset, live preview where the setting is live. Settings read at
handoff (frame colour, pulse, frame) say so on the row instead of silently not applying.
Autostart toggle uses `sbar-orbit autostart`. No second schema: the CLI and the page stay one
owner.

### 5. Features worth adding once the surface exists

- Hover and drag status in the panel (from the cursor work: held button indicator, release now).
- Per session action policy: protected or full mode, switchable from the card.
- Workspace switcher: show which numbered workspace a session works on and present it on an
  unfocused monitor through `native-present` with an explicit monitor choice.
- Conversation and project names on cards (`session.create` already accepts them).
- Latency readout per session from the settled capture fields (`waitedMs`, `settled`), so the
  speed work is visible instead of claimed.
- Notifications: finished, blocked, needs owner input.

## Order and ownership

Items 1 and 2 touch `desktop/panel.py` and `desktop/panel_broker.py`; items 3 and 4 add new
modules (`desktop/panel_about.py`, `desktop/panel_settings.py`) so they can be built in
parallel without sharing files. One session per file set. Every change is checked in an
Orbit display by rendered frames, with screenshots attached, not by test counts.

## Acceptance

- From the panel alone: pause, resume and stop a live session and see the state change within
  one poll interval, with the application left open.
- A blocked update explains itself and names the blocking sessions.
- The version, plugin and ABI status are visible without a terminal.
- Every setting reachable by `sbar-orbit config` is reachable in the panel, in Arabic and English.
- No new browser surface, no hidden desktop, no second settings schema.
- `bun run verify` passes and the panel is demonstrated live after broker and panel restart.
