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

**Not failures:** page scroll ticks are 120 px and my scroll past the list was my
aim; Firefox shows a first run profiles modal over the owner's profile that blocks
typing until dismissed with its close button; capture images of Firefox include 24
logical pixels of client decoration offset, and clicks map correctly through it
(verified by the form fill).

## Fix made

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

1. Chromium forwarded launch lands on the owner's workspace unplaced (F1).
2. Hover menus and tooltips cannot be driven (F2).
3. Drag and drop cannot be driven (F3).
4. Capture after a vanished target gives an opaque error (F4).
5. Text outside the seat layouts cannot be typed (F5), now reported clearly.
6. Rare lost handoff reply and lost final Return after a loading navigation (F6, F7).
7. Not run: Firefox infinite list, anchors, file dialog, iframe, lazy content, MDN and
   BBC; clicking the sticky-page target button was not verified in Chromium.
