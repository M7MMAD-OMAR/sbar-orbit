# Viewer design

The agent's screen is the subject. Orbit supplies a compact frame around it, while session management and troubleshooting stay available without occupying the main view.

## Visual system

The viewer retains Orbit's monochrome palette, existing Material role fallbacks, borderless surfaces and optional desktop palette. Application pixels are never tinted, blurred or filtered. Colour is allowed inside the displayed application and on the agent pointer.

The main frame has 16px corners, its inner stage 10px and the displayed image 8px. Image padding is 4px on desktop and 2px on mobile. Primary buttons invert the palette, quieter controls use raised grey surfaces, and keyboard focus keeps a visible outline. A thin activity indicator appears only while an action is actually in flight.

## Screen space

A 248px sidebar holds conversation cards, agent identity and activity state. The header button hides or restores it and remembers the choice in local storage when available. At widths of 900px or less it starts closed and opens as an overlay; Escape closes the mobile overlay. Sidebar visibility never changes a session.

The compact header identifies the conversation, project and agent. Below it, a horizontal conversation strip remains usable with the sidebar closed. The stage toolbar identifies the current page or application and its location. Secondary controls live in native details disclosures below the stage: display settings, problem reports, typing and session actions. Taking over opens typing controls. A prepared error report opens the report disclosure.

The available image height is measured from the current window and surrounding controls. The canvas preserves the captured aspect ratio, and the pointer container has exactly the canvas's bounds. No stretch or crop is used to fill unused space. Normal page scrolling remains available when a disclosure is open or the viewport is unusually short.

**Focus view** hides navigation and secondary controls while retaining conversation/project identity, page tabs and an obvious **Exit focus** button. Escape leaves focus view. **Fullscreen** uses the browser fullscreen API and enters focus view. Leaving browser fullscreen retains focus view until the person exits it. If fullscreen is denied, the viewer explains that focus view is still available.

These controls change only how the image is displayed. **Screen size** changes the agent's actual workspace dimensions and still requires taking over first.

## Conversation and page navigation

Conversation buttons select which session is observed. Each shows the supplied conversation name and project, with the agent on the second line. Sidebar cards show the same ownership and the current activity state. The viewer document title uses `Conversation · Project | Orbit`, making the viewer's own browser tab identifiable.

`session.create` accepts optional `conversationName` and `projectName`, each 1 to 80 printable characters. Both are returned by session information and are exposed through `orbit_create`. CLI callers can set `ORBIT_CONVERSATION_NAME` and `ORBIT_PROJECT_NAME` alongside the existing agent/task variables. These are display labels, not host conversation identifiers or access grants. They are excluded from diagnostic reports.

Orbit does not read another application's conversations to guess their names. If no conversation title is supplied it shows `taskName`; if no project is supplied it says **Project not provided**. A host or agent must pass the real names to make them available. Existing sessions keep their original metadata.

The separate page strip uses actual browser page or native window labels. Switching one changes the active page/window in that agent's workspace, so those buttons remain disabled while the agent owns control. **Take over to switch pages** explains the requirement. Selecting another conversation clears the old page strip immediately and requests a new capture, including in manual refresh mode.

## Interaction and verification

Semantic buttons support sidebar and conversation navigation. Page tabs expose their selected state. Text is assigned with textContent, including untrusted labels. Polling retains its existing hidden-page suspension, manual refresh and adaptive backoff.

`tests/viewer-layout.test.ts` runs inside private Orbit sessions. It checks supplied identity, sidebar persistence, focus growth, matching image/pointer bounds, fullscreen, conversation switching, paused page selection and mobile overflow. `tests/viewer-polling.test.ts` verifies capture cadence and hidden-page handling. Diagnostic preparation and download remain covered by their separate viewer test.

Screenshots from the layout test use a local demonstration application, not the person's desktop or a live customer project.

Measured on 13 September 2026: the full suite passed 202 tests with 12 optional tests skipped and zero failures. TypeScript passed. Layout checks used 1440x1000 and 390x844 private-browser viewports and covered sidebar persistence, focus, fullscreen, project identity, paused tab switching, pointer bounds and horizontal overflow. Native display-specific skipped tests are not claimed as measured.
