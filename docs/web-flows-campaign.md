# Web flows campaign

Date: 29 October 2026. Host: Fedora 44, Hyprland 0.56.2, Wayland. Real MCP tools
(`orbit_open`, `orbit_handoff`, `orbit_act` with `capture`, `orbit_observe`) driving
original installed Chromium and Firefox windows opened as NEW windows on
numbered workspace 7, which no monitor was showing when the run started. The owner's
other Chromium window and every other window were left alone. Each browser window
was closed with `ctrl+w` and its session stopped. No logins, no credentials, no
purchases, no CAPTCHAs, nothing submitted to a third party.

Local fixture: `experiments/web-flows/` (`bun run experiments/web-flows/server.ts`, serves
`127.0.0.1:8765` only). Public read-only pages: Wikipedia (Linux, search), MDN
(`<dialog>`), BBC News front page.

Coordinates in `orbit_act` are surface logical pixels. Capture images are scaled
(1.333x on the laptop panel, 1.5x on the external monitor), so divide image pixels by
the scale before clicking. One scroll tick moved the page by 120 logical pixels.

## Results

Calls count `orbit_act` and `orbit_observe` invocations for that flow, not the
open and handoff steps. Time is the capture settle time Orbit reported for the last
call of the flow. A frame is "stale" when the capture did not settle or reported
`changed: false` although the action should have changed the page.

| Flow | Chromium | Firefox | Calls (C / F) | Settle ms (C / F) | Stale frames |
| --- | --- | --- | --- | --- | --- |
| Open window on workspace 7 | FAIL, see F1 | pass | 3 + manual move / 1 | n/a | 0 |
| Address bar: ctrl+l, URL, Return (localhost) | pass | pass | 1 / 2 | 2393 / 872 | 0 |
| Text, textarea, select by letter, checkbox, radio, Tab, Enter submit (14 actions) | pass, exact values | pass, exact values | 1 / 1 | 444 / 299 | 0 |
| Scroll page (5 ticks) | pass | pass | 1 / 1 | 482 / 631 | 0 |
| Modal: open, Escape, reopen, close button | pass | pass | 2 / 2 | 325 / 309 | 0 |
| Hover menu | FAIL, see F2 | FAIL, see F2 | 2 / 1 | 223, 344 / 320 | 1 (changed false) |
| Tooltip | not reachable (needs hover) | not reachable | 0 / 0 | n/a | 0 |
| Infinite list, wheel inside list | pass, 20 to 40 rows | not run | 2 / 0 | 421 / n/a | 0 |
| Sticky header anchor links | pass | not run | 1 / 0 | 334 / n/a | 0 |
| ctrl+f find | pass (1/1 match) | pass | 1 / 1 | 540 / 759 | 0 |
| Drag and drop | unsupported, see F3 | unsupported | 0 / 0 | n/a | 0 |
| File input opened and cancelled | pass, "file cancelled" seen | not run | 3 | 1228, then see F4 | 0 |
| Iframe field and button | pass | not run | 2 (1 mis-aimed by me) | 662 / n/a | 0 |
| Slow lazy content on scroll | pass | not run | 0 extra | n/a | 0 |
| Wikipedia: open, link, back, site search | pass | open pass | 3 / 3 | 3115, 3142 / 3054 | 3 (settled false while loading) |
| MDN open (redirects) | pass on retry | not run | 2 | 3067 | 1 |
| BBC front page | loaded, no cookie banner within 3 s | not run | 1 | 3000 | 1 |
| Unicode: Arabic, symbols, newline, tab | not run | pass for Arabic and symbols; FAIL for e-acute and euro, see F5 | 0 / 2 | n/a / 629 | 0 |
| ctrl+w closes only the new window | pass | pass | 1 / 1 | n/a | 0 |

Totals: Chromium 26 tool calls, Firefox 14 tool calls, about 40 input actions in
batches of up to 14. A whole form fill took one call and under half a second.

## Failures and causes

**F1. Forwarded launch ignores the workspace (Chromium).** `orbit_open` returned
`opened:false`, `candidate-only`, `candidateReason: owner-input`, `placementChanged:
false`. The new window of the single-instance Chromium mapped on workspace 4, the
workspace the owner was working on, tiled at 1267 by 1396. Cause: a forwarded launch
is placed only after map, and `place_new_window` refuses a window that already holds
seat focus ("Opening target is receiving owner input"). The new window took focus on
map, so Orbit could not tell map focus from owner typing. This is deliberate and
covered by `test_new_active_launch_bound_candidate_is_returned_without_placement`, so
it was not changed. Firefox (a separate process with `launch-ancestry` proof) opened
floating at 1200 by 800 on workspace 7 directly. I moved the Chromium window with the
same Lua placement call Orbit uses (float, move without follow, resize, center) and
then handed it off. Owner area: `src/native/owner_open.py`, needs a design decision.

**F2. Hover never persists (both browsers).** `move` returned ok and the pointer
position was recorded, but `:hover` menus and tooltips never opened. Cause:
`pointerCmd` in `experiments/ghost-cursor/plugin/ghostinput.cpp` sends enter, motion,
frame and then `returnClientPointer`, which sends leave to the client in the same
call, so the page sees the pointer arrive and leave. Hover needs the synthetic
pointer to stay on the surface until the next action. Owned by the ghost-cursor
session; not changed.

**F3. No drag.** There is no button press, hold or release primitive, only a
whole click. Drag and drop, text selection by dragging and sliders are impossible.
Plugin and protocol work, not done.

**F4. Opaque error after the target disappears.** After `Escape` closed the file
dialog, the capture that followed returned `NATIVE_FAILED: Native request failed;
inspect its private worker journal`. The key itself was acknowledged ok. Capture path,
owned by the settled capture session.

**F5. Text with a character that has no key in the seat keymap.** The seat layouts
are `us,ara`. `café €5` failed as a whole with `NATIVE_FAILED` and status
`uncertain` in the batch, which told the agent to inspect before retrying. The
plugin builds all strokes before sending the first, so nothing is typed and the
failure is definite. Fixed, see below.

**F6. Lost reply on handoff.** One `orbit_handoff` of the file dialog returned
`BROKER_UNAVAILABLE` although the handoff had succeeded (the session existed and the
retry returned `APPLICATION_BUSY` because of it). `status` showed the new session.
Not reproduced, cause not found; the MCP adapter maps every non-Orbit exception to
`BROKER_UNAVAILABLE`. Agents should check `orbit_status` before retrying a handoff.

**F7. One batch lost its final navigation (Chromium), one lost it in Firefox.** A
batch of click, scroll, ctrl+l, URL text, Return left the search page in place with
no navigation. A later batch ending ctrl+l, URL, Return, ctrl+f, text, Return in
Firefox left the URL typed but not committed. The same sequence in separate calls
worked both times. Not reproduced on demand; both followed a navigation that was
still loading, and Firefox lost the Return before a following shortcut. Treat the
Return after a typed URL as needing its own verification capture.

**F8. Window geometry drifted mid run.** The Chromium window was reported as 1200 by
800, then as 1916 by 1166 with `fullscreen: 1` (maximized) after about two minutes,
with eDP-1 switching to workspace 7 and back. I did not cause it with any action
Orbit sent; the owner may have switched workspaces. The surface size in each capture
is authoritative, so recompute coordinates from `surfaceWidth` and `surfaceHeight`
after every capture.

**F9 (second round). Firefox does not activate links or the file Browse button.** Five link
clicks failed in Firefox (three header anchors in the fixture, two Wikipedia body links,
one of them after a separate move call), and the file input Browse click opened no dialog.
Buttons, text fields, the form submit button and the modal button in the same Firefox window
click correctly, and the same links work in Chromium. The press and release reach the page
for some targets but not for link activation. Suspects: press and release in one millisecond
with no frame between them, or the pointer leave sent right after the release. Owned by the
plugin (reported to the natural-cursor session). Not fixed.

**F10 (second round). Text after a click into a Firefox iframe is lost.** In one batch (click
the iframe field, type, Tab, Return) the field stayed empty and the space in the text scrolled the
iframe. The same text typed in a separate call afterwards landed. Cause: focus moves into the
out of process iframe a moment after the click, and keys sent immediately reach the old focus.
Mitigation shipped: a batch now waits 200 ms between a click and a following text or key
action (`src/session.ts`). The value is not yet measured live because the broker needs a
restart to load it.

**F11 (second round). Premature settle.** Captures reported `settled: true` while the page
was not ready: Firefox showed the previous page after a Return that was loading Wikipedia
(`waitedMs` 1433), the first capture after a hover move in Chromium missed the menu that the
next capture showed, and Firefox list scrolling was mid animation. Settle code is owned by
another session.

**Not failures:** page scroll ticks are 120 px and my scroll past the list was my
aim; Firefox shows a first run profiles modal over the owner's profile that blocks
typing until dismissed with its close button; capture images of Firefox include 24
logical pixels of client decoration offset, and clicks map correctly through it
(verified by the form fill).

## Second round (after the plugin with hover and drag was loaded)

Chromium and Firefox again, new windows on workspace 7, plugin source c8337d16, workers on
the new Python code. The broker was not restarted by me, so `session.ts` and `native-worker.ts`
changes were not live.

| Check | Chromium | Firefox |
| --- | --- | --- |
| Forwarded launch placement (F1) | pass: `opened:true`, activation-token, floating 1200 by 800 on workspace 7 | n/a (separate process, launch-ancestry, already passed) |
| Text with Arabic, e-acute, euro, emoji in a field, newline in a textarea, submitted (F5) | pass, submitted JSON exact (`"name":"مرحبا café €5 😀"`, `"notes":"ligne un é\nligne deux €"`), receipts `ok paste 15 characters` and `ok paste 23 characters` | pass, same exact values |
| Hover menu opens and an item can be picked | pass: menu appeared after the second move, `picked A` after move and click | pass: menu appeared after two moves |
| Menu closes when the pointer leaves | pass | not run |
| Tooltip | no tooltip in the window capture 300 ms and 4 s after the move; native tooltips are separate popup surfaces | not run |
| Drag and drop | not run: the host session's `orbit_act` schema has no `drag` action yet (`Invalid input at action`) | not run |
| Infinite list wheel | passed in round one | list reached row 16 of 20 after three scrolls of 5, then loaded more, count not read back |
| Page scroll to file input, iframe, lazy content | passed in round one | pass: lazy content "arrived", iframe visible |
| Iframe field, type, Tab, Return | passed in round one | fail in one batch, pass with separate calls (F10) |
| Header anchor and body link clicks | pass | fail (F9) |
| File input Browse opened | pass in round one | fail: no dialog (F9) |
| Wikipedia open | pass | pass, first capture stale (F11) |
| MDN open | pass on retry | pass, 27 captures, `settled:false` |
| BBC front page | loaded | loaded, no cookie banner appeared in 3 s |
| ctrl+w closes only the new window | pass | pass |

The clipboard held other content before the F5 runs; nothing in the fixture reads it back, and
the unit tests and a real `wl-copy` round trip with 21 characters of mixed text confirmed
the previous text is restored.

## Fixes made

**F1 (`src/native/owner_open.py`, `src/native/window_placement.py`).** A launch-bound window
that holds seat focus is now placed when focus came from mapping: no owner pointer movement
since the request (compositor `j/cursorpos` before and after) and the window first seen
within 0.5 s. Pointer movement, an unreadable pointer, or a window that held focus longer keep
the old refusal (`owner-input`, no placement). A keyboard has no compositor record, so the
keyboard half is bounded by time, not recorded. After such a placement, later pointer movement
reports uncertain delivery. Tests: `tests/native_open_test.py` (33 tests, four new).

**F4 (`src/native/host.py`, `transport.py`, `keyboard.py`, `session.py`, `session_worker.py`,
`src/native-worker.ts`).** `no such window`, a changed stable identity or a missing surface now
raises `TargetClosed`, reported as `TARGET_CLOSED` with an actionable message and status `failed`.
The previous generic `NATIVE_FAILED` was treated as uncertain. Tests:
`tests/native_text_refusal_test.py`.

**F5 (`src/native/paste.py`, `session.py`).** Text refused for lack of a key is pasted through
the shared clipboard (ctrl+v), then the previous clipboard text is restored, also when the
paste key fails. A non text clipboard is never replaced. The text field check the lead asked for
is not implemented: no tree in `a11y.py` reports the focused element, so the paste goes to the
focused element exactly as typing does. Tests: `tests/native_paste_test.py`.

**F10 mitigation (`src/session.ts`).** 200 ms wait between a click and a following text or key
in a batch. Tests: `tests/session-click-focus.test.ts`.

## First fix made

`src/native/keyboard.py`, `src/native/host.py`, `src/native/session_worker.py`,
`src/native-worker.ts`: a text commit that the plugin refuses with `no key for
U+XXXX in the seat keymap` now raises `UnsupportedText`, reported as
`TEXT_UNSUPPORTED` with an actionable message, status `failed` (not `uncertain`) and
without naming the typed character. Later actions in the batch report `PRIOR_FAILED`.
The commit is still never resent. Regression test:
`tests/native_text_refusal_test.py` through `tests/native-text-refusal.test.ts`; two
of its four cases fail against the previous `keyboard.py`.

Remaining limitation: characters outside the active layouts still cannot be typed.
The plugin does not install a temporary keymap, so the workaround is the shared
clipboard.

## Remaining failures, plainly

1. Fixed and verified live: F1 (Chromium forwarded launch) and F5 (untypeable text via clipboard).
2. Fixed in code, not yet live (broker restart needed): F4 error message, F10 click to key wait.
3. Hover works in both browsers; tooltips do not show in the window capture; tooltip popups are
   separate surfaces.
4. Drag and drop is untested from a website: the host MCP session predates the `drag` schema.
   Natural-cursor reports HTML5 drag and drop as unsupported.
5. Firefox does not activate links or the file Browse button (F9), plugin side.
6. Premature settle on loading pages and after hover (F11), settle side.
7. Rare lost handoff reply and a lost final Return after a loading navigation (F6, F7).
8. The text field condition for paste is not enforced (see F5 above).
9. Not verified: clicking the sticky page target button in Chromium, the Firefox infinite list
   count, cookie banners (none appeared).

## F2 and F3 fixed: persistent hover, press, hold, release and drag (29 October 2026)

Tested plugin build: source sha256 `f11203c0f74487f901fe42c0bf9c8800a0a00265c5d248080a729e5f00c3f911`
(`ghostinput.cpp`; the committed source adds one marker comment, sha256 `c8337d16d03832fa9ab3700bba474088711f87973d2ecdeddd3322b1ea92e90a`). Run in a private nested Hyprland 0.56.2 (headless output, its own
plugin load, its own broker in full mode, its own XDG directories), never on the owner's
compositor, because six other leases were active there and loading a plugin ends them.
Windows were opened in that nested compositor: Chromium with a throwaway profile, a
GTK4 probe that logs every pointer event, and Text Editor. The owner's physical pointer
is not part of that compositor.

What changed:

- **Hover persists.** Every pointer command (`move`, `click`, `scroll`, and the new
  ones) now keeps the synthetic pointer on the target surface. It ends at the next
  pointer action, `ghost-release`, owner button, wheel or key input, handback or stop,
  plugin unload, or a timeout of 15 s with no button held. Nothing moves the owner's
  physical pointer or keyboard focus.
- **New actions** `mouse-down`, `mouse-up` (both `x`, `y`, optional `button`) and `drag`
  (`x`, `y`, `toX`, `toY`, optional `button`). They pass the same lease, guard and policy
  checks as `click` and classify as `write`. A second `mouse-down` of a held button is
  refused; `mouse-up` of a button that is not held is refused.
- **Held moves are real motion.** While a button is held, a `move`, a `mouse-up` and a
  `drag` send pointer motion to the application every 8 ms along the same curved path
  the cursor is drawn on, with no overshoot and no idle drift. `mouse-up` releases at the
  exact target point. `drag` presses at the first point, travels, and releases at the
  second; `ghost-state` reports `motion_active` and the session waits for it.
- **A held button is always released.** On the next owner button, wheel or key input, on
  handback and session stop, on `ghost-release`, on plugin unload, and after 30 s since
  the last motion.

Measured (Chromium, GTK probe, Text Editor; times from the probe's own event log and
from 30 fps recordings of the nested output):

| Check | Result |
| --- | --- |
| Hover menu after `move` (Chromium) | opens and stays open; Item A and Item B visible |
| Tooltip after `move` (Chromium) | "Tooltip text for the fixture" shown 3.5 s after the move |
| Hover then idle | leave event exactly 15.000 s after the last action |
| `mouse-down` twice | second refused, first stays held |
| `mouse-up` at a new point | about 38 motion events 8 ms apart, last at the exact target, release in the same millisecond |
| `mouse-down` then no action | release and leave exactly 30.000 s later |
| `mouse-down` then session stop | release and leave 0.6 s later, before the handback finished |
| Text selection by `mouse-down`, `move`, `mouse-up` (Chromium) | "Drag and drop" heading selected |
| `drag` across two lines (Text Editor) | selection grows frame by frame, ends at the exact target (270.8, 114.3 px for target 271, 115) |
| Drawn drag path | approach about 0.37 s, drag about 0.33 s for 238 px |

Not fixed, and why:

- **HTML5 drag and drop does not work.** On the fixture the "drop here" box stayed
  "drop here" after a `drag` that ended on it. Wayland drag and drop is started by the
  client with `wl_data_device.start_drag` and then driven by the compositor from the
  seat pointer. Synthetic `wl_pointer` events do not drive it, and driving it would
  mean moving the seat pointer, which is the owner's physical pointer. Pointer-event
  drags (text selection, sliders, canvas, most sortable lists) work.
- **Firefox was not run.** A fresh Firefox profile opens a Terms of Use and data
  collection consent page that blocks the content. Accepting it is the owner's call;
  the plugin path is the same `wl_pointer` events Chromium and the GTK probe received.
- The new plugin is built and verified but not loaded into the owner's compositor yet:
  six leases were active. Load it with `native-plugin unload`, then `native-refresh
  --plugin-manifest` when no lease is active.

### Live rerun on the owner compositor (29 October 2026, plugin source sha256 `8063744c`)

Real Firefox and Chromium windows opened as new windows on workspace 7 (not shown by
any monitor), driven through `sbar-orbit act` with `session observe` frames, then closed
with `ctrl+w` and the sessions stopped. Fixture served by `bun run experiments/web-flows/server.ts`.
The plugin also times a click now: motion, 45 ms, press, 60 ms, release (commit 88c0b49).

| Check | Chromium | Firefox |
| --- | --- | --- |
| Link click navigates (`#hover`) | pass, status bubble shows the URL | pass at corrected coordinates, see below |
| Hover menu opens after `move` | pass | pass |
| Tooltip | not in the capture (popup surface) | not in the capture (popup surface) |
| Text selection by `drag` | pass (drag started on the open menu, picked Item A) | pass, "Hover for a tooltip" selected |
| HTML5 drag and drop | not delivered, see above | not run, same protocol limit |

**Root cause of F-links on Firefox: capture and input disagree about the window origin.**
Firefox draws client-side margins. `state` for that window reported `window` 960x640,
`surface` 1008x688, `geometry` [24, 21, 960, 640]. The plugin maps `x`, `y` into the
geometry (it adds 24 and 21), and `observe` returns a 960x640 image whose top-left is
the surface origin, so everything in the image is 24 by 21 logical pixels away from
where the same coordinates land. Fields and buttons are large enough to tolerate that;
a 43 by 19 pixel link is not. The first four clicks on the "hover" link, including a
manual `mouse-down`, 0.3 s wait, `mouse-up`, did nothing. The same click at
(163, 100) instead of (187, 121) navigated at once. The click timing was not the cause.
Chromium has no margin (geometry [0, 0, w, h]), so it never showed this.
The fix belongs in `observe`, which must crop to the geometry rectangle (or the input
mapping must treat coordinates as surface pixels). Both are owned by other sessions, so
neither was changed here. Until then, on a window whose `state` geometry is not at 0, 0,
subtract the geometry offset from coordinates read off an image.
