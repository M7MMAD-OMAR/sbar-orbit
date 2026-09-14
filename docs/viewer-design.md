# Viewer design

The agent's screen is the subject. Orbit supplies a compact frame around it, while session management and troubleshooting stay available without occupying the main view.

## Visual system

The viewer retains Orbit's monochrome palette, existing Material role fallbacks, borderless surfaces and optional desktop palette. Application pixels are never tinted, blurred or filtered. Colour is allowed inside the displayed application and on the agent pointer.

The window holds one rounded frame, 24px at its corners, and the rail lives inside it rather than beside it: the list of sessions and the picture are one object, so closing the rail widens the picture instead of leaving a seam where a column used to be. Inside that frame the stage card has 18px corners, the stage 13px and the displayed image 10px. Image padding is 4px on desktop and 2px on mobile. Primary buttons invert the palette, quieter controls use raised grey surfaces, and keyboard focus keeps a visible outline. A thin activity indicator appears only while an action is actually in flight.

## Screen space

A 264px rail holds the session cards, agent identity and activity state. The header button hides or restores it and remembers the choice in local storage when available. Closing it animates the frame's own grid column over about a third of a second, with the rail's contents holding their width so the text slides away rather than reflowing narrower on every frame; the rail ends at `visibility: hidden`, so nothing collapsed is still reachable by a pointer or a screen reader. `prefers-reduced-motion` removes the movement. At widths of 900px or less the rail is a sheet over the work rather than a column beside it, starting closed; Escape closes it. Rail visibility never changes a session.

The compact header identifies the conversation, project and agent. There is no second list: the horizontal conversation strip that used to repeat the rail above the picture is gone, because two lists of the same sessions in two shapes is one more thing to read and nothing more to learn. The stage toolbar identifies the current page or application and its location. Everything secondary lives in one **Settings and tools** disclosure below the stage: display settings, problem reports, session actions and the technical readout. Typing for the assistant is not a disclosure at all; it appears only while a person holds the controls, which is the only time it can be used, and a prepared error report opens the tools sheet.

The available image height is measured from the current window and surrounding controls. The canvas preserves the captured aspect ratio, and the pointer container has exactly the canvas's bounds. No stretch or crop is used to fill unused space. Normal page scrolling remains available when a disclosure is open or the viewport is unusually short.

**Focus view** hides navigation and secondary controls while retaining conversation/project identity, page tabs and an obvious **Exit focus** button. Escape leaves focus view. **Fullscreen** uses the browser fullscreen API and enters focus view. Leaving browser fullscreen retains focus view until the person exits it. If fullscreen is denied, the viewer explains that focus view is still available.

These controls change only how the image is displayed. **Screen size** changes the agent's actual workspace dimensions and still requires taking over first.

## Language and direction

The viewer opens in Arabic, right to left, and a switch in the rail moves the whole page to English; the choice is remembered per browser. Every string a person reads is written in English in `viewer/viewer.js` and looked up in the Arabic table beside it, the same shape the website uses. Static markup carries `data-i18n`, `data-i18n-label`, `data-i18n-title` and `data-i18n-placeholder`; nothing a test or the desktop panel keys off moves, because ids, `data-state`, `data-working` and the session states themselves stay in English.

The layout mirrors through logical properties alone, so Arabic needs no rules of its own. The stage is the one deliberate exception and is pinned to `ltr`: the agent pointer is placed in image coordinates and clicks are measured from the frame's left edge, and neither mirrors. Foreign text, page titles, locations, tab labels and the names an agent supplies, gets `unicode-bidi: plaintext` so a Latin string inside an Arabic page reads in its own direction, with the alignment set explicitly from the page's language. `dir="auto"` does the first half and loses the second: it decides the alignment too, which is how an English title ends up stranded at the far end of an Arabic header. The font stack puts the Arabic faces after the Latin ones rather than under them: a generated desktop font is almost always Latin only, and without that tail the page falls back glyph by glyph, which is what makes an Arabic interface look broken while every string in it is correct.

## Session navigation

Session cards are the whole of navigation. Each shows the supplied conversation name and project, the agent and current state, and when anything last happened in it. The rail is ordered by that same moment, newest first, so the session an agent touched a minute ago sits above the ones that finished this morning. The order is made in the viewer rather than in `session.list`, which several other readers share and which answers in creation order.

`session.create` stamps `createdAt`, and every acted-on session stamps `lastActivityAt` at both the start and the settle of the action. The card prints an absolute 12-hour time with Latin digits in both languages, dated `Today`, `Yesterday` or by day and month. It is absolute rather than relative on purpose: the rail is rebuilt only when the text on a card changes, and a duration that ticks would put every card through a rebuild once a second for no new information.

A finished session can be removed from the list, and that is the only thing left to do to one. The card's control asks once in place, and the second click calls `session.forget`, which drops the broker's entry and leaves the session's journal file where it is, because that record is what a run is reviewed from afterwards. An unknown id succeeds quietly rather than failing, so a second click on a card that has already gone is not an error on screen. A session that has not finished is refused with `SESSION_OPEN`. The viewer document title uses `Conversation · Project | Orbit`, making the viewer's own browser tab identifiable.

`session.create` accepts optional `conversationName` and `projectName`, each 1 to 80 printable characters. Both are returned by session information and are exposed through `orbit_create`. CLI callers can set `ORBIT_CONVERSATION_NAME` and `ORBIT_PROJECT_NAME` alongside the existing agent/task variables. These are display labels, not host conversation identifiers or access grants. They are excluded from diagnostic reports.

Orbit does not read another application's conversations to guess their names. If no conversation title is supplied it shows `taskName`; if no project is supplied it says **Project not provided**. A host or agent must pass the real names to make them available. Existing sessions keep their original metadata.

The separate page strip uses actual browser page or native window labels. Switching one changes the active page/window in that agent's workspace, so those buttons remain disabled while the agent owns control. **Take over to switch pages** explains the requirement. Selecting another conversation clears the old page strip immediately and requests a new capture, including in manual refresh mode.

## Interaction and verification

Semantic buttons support rail and page navigation. A card is a container holding the button that selects it, whose hit area is stretched over the whole card, plus the removal control for a finished session, so the second control needs no nested button. Page tabs expose their selected state. Text is assigned with textContent, including untrusted labels. Polling retains its existing hidden-page suspension, manual refresh and adaptive backoff.

`tests/viewer-layout.test.ts` runs inside private Orbit sessions. It checks Arabic and right to left on first load with the stage still `ltr`, that the rail is the only session list, newest-first ordering, the last-activity stamp, supplied identity, rail persistence, focus growth, matching image/pointer bounds, fullscreen, session switching, the typing panel appearing only while paused, the language switch, removing a finished session, and mobile overflow. Its selectors are ids, classes and data attributes only: the words move between languages at the reader's choice, and a test that clicks a button by the sentence printed on it breaks on the next copy change while the interface it guards is fine. `tests/viewer-polling.test.ts` verifies capture cadence and hidden-page handling. Diagnostic preparation and download remain covered by their separate viewer test.

Screenshots from the layout test use a local demonstration application, not the person's desktop or a live customer project.

Measured on 13 September 2026: the full suite passed 202 tests with 12 optional tests skipped and zero failures. TypeScript passed. Layout checks used 1440x1000 and 390x844 private-browser viewports and covered sidebar persistence, focus, fullscreen, project identity, paused tab switching, pointer bounds and horizontal overflow. Native display-specific skipped tests are not claimed as measured.
