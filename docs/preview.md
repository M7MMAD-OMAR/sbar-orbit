# Live workspace preview

**Measurements:** Current resource and sustained-run results are summarized in [validation](validation.md). Older timing numbers below describe their individual trials.
Implemented for browser and Fedora native sessions: live images, session selection, pause/resume/stop, and manual input while paused. `preview` prints the link and opens nothing; `preview open`, and the desktop mark, open it in the person's chosen browser.

## Use

With the broker running and `ORBIT_SOCKET` configured:

```sh
bun run src/cli.ts preview
```

Open the complete returned URL. Its fragment contains a per-broker access token. The viewer runs on an automatically allocated loopback port. Closing the page leaves sessions running. Stopping the broker closes the preview server as well.

## Opening it as its own window

```sh
bun run src/cli.ts preview open
bun run src/cli.ts preview browsers
```

`preview open` hands the link to a browser rather than printing it, in a window with no tab strip and no address bar. `preview browsers` lists what is installed, which is also what the settings row reads. Clicking the desktop mark takes the same path.

A browser is any desktop entry that handles `x-scheme-handler/http` and declares the `WebBrowser` category. Both conditions are needed: an application that registers the scheme to catch its own sign-in links is not somewhere to read the viewer. Flatpaks are found the same way as system packages, since on a desktop where the default browser is a flatpak a list of binary paths finds nothing.

The window itself is Chromium's `--app=`. That is the whole mechanism: no manifest, no installation and no fixed port, which is what makes it work with a link whose port is allocated per broker and whose access token lives in the fragment. An installed progressive web app is scoped to an origin, port included, and would be launched at `/` carrying no token at all, so it is a different change rather than a tidier version of this one.

Browsers in the Firefox family have no such mode. Site specific browsers were removed in Firefox 86 and no release build carries a replacement flag, so Firefox, Zen, LibreWolf and the rest open the viewer as an ordinary tab. Nothing is invented for them: a browser that cannot drop its tab strip gets a tab, which is why an unset choice passes over a default browser that cannot open a window and takes the first installed one that can. Choosing that browser explicitly is honoured, tab and all.

The family is read from the executable's name where it is recognisable, and otherwise from the private window action every browser ships, which the two families spell differently. That is what identifies a Chromium build whose name carries no Chromium token, such as Helium.

Both choices live in the panel's settings, under **The viewer**, and in `sbar-orbit config`: `viewerBrowser` is a desktop entry id or empty for the automatic choice, and `viewerAppWindow` turns the window off in favour of a tab. A browser that has since been uninstalled falls back rather than failing. Where the fallback has several browsers to choose between it takes them in the order `platform.ts` already uses for session browsers, Chrome before Chromium, rather than alphabetically.

Spawning is not opening. A binary that is missing or not executable fails at once, and a browser that starts, rejects its arguments and exits is given a moment for its exit code to arrive, because reporting that as opened is what would leave the desktop mark with no window and no fallback. Exiting immediately with success is not that case: it is the ordinary second invocation, whose command line is forwarded to the browser already running, and that instance is what opens the window.

Desktop entries are a Linux mechanism, so this is a Linux path. On macOS and Windows the viewer is handed to `open` or `start` and arrives as a tab in the default browser. Chrome's in-bundle binary on macOS does take `--app=`; nothing here uses it yet. See [porting](porting.md).

To take control: select a session in the rail, choose **Take over**, wait for **You are in control**, then click inside its image. Use **Send text** or **Send key** to operate the focused element. **Hand back** enables agent actions again, and **End session** stops it. For Fedora native sessions, **Paste text** uses the workspace clipboard and Ctrl+V, supporting Arabic and emoji in applications that accept that shortcut. Wait for the text to appear before taking the next action. For browser and native sessions, use the mouse wheel over the image to scroll vertically while paused. Image coordinates scale to the application viewport. Gestures received while a manual command is busy are discarded instead of replayed after resume. Horizontal wheel gestures and touch scrolling are not implemented. Native general key controls remain disabled. All input targets the owned session; the human desktop receives no injected input.

Preview now defaults to a 1000 ms target cadence. In the viewer those three choices read as **Every second**, **Only when I ask** and **As smooth as possible**, with **Update now** for a single capture. An already in-flight capture may finish after changing modes. These controls affect viewing, not the agent's execution state. Slow work does not create overlapping polls. Hidden tabs perform no polling. Connection failures back off to a 10-second cadence, and RPC requests time out after 5 seconds. Frame-age indicators remain visible; a pointer over a frame older than 1 second in Smooth, or 2 seconds otherwise, is dimmed rather than removed, because at the default one frame a second hiding it meant the marker saying where the agent is working was the one thing on the page you could not rely on seeing. Capture still does not wait behind an agent's locator action, and overlapping requests share one in-flight screenshot.

The viewer draws into a reusable Canvas and closes each decoded ImageBitmap immediately after drawing, including discarded frames. This replaces the image-element path that retained hundreds of MiB of renderer shared memory. See the [memory investigation](viewer-memory.md) for measurements; the scripted sustained run passed, while simultaneous human-work confirmation remains open.

## Tabs, windows and surface size

Sessions are listed in the rail down the left, one card each, carrying the agent, the task, the backend, the state and a light that breathes while an action is in flight. That is the whole of navigation: the drop-down it replaced showed one session at a time and said nothing about the rest, so a person running several agents could not see which one had stopped without opening it. The rail is built from `session.list` alone and holds no second live image, because every live image is a capture, an encode and a decode on each poll.

The stage carries the same signal at the size the question is asked at: while the selected session has an action in flight its frame glows, so "is something happening in there" is answered by the thing being watched rather than by a badge somewhere else.

Below the settings row the viewer shows one entry per tab of a browser session, or per window of a private display, numbered the way `observe` reports them. Selecting one follows that tab, or focuses that window. Native sessions also get **Fullscreen window** and **Restore window**.

**Make it bigger** hides the rail, the panels and the heading so the picture can use the height of the window as well as its width. It is viewer layout only: it changes nothing about the session and needs no pause.

The **Screen size** control changes the session surface. Browser sessions resize every open tab, not only the followed one, so switching tabs does not change what a coordinate means. Native sessions resize the private display itself.

All of these are manual control, so they require **Pause agent** first, for the same reason typing does: they change what the coordinates an agent just read refer to. An agent changes them for itself with the `resize`, `select-tab`, `close-tab` and `window` actions. Sizes are capped by total pixel count; the [measured cost curve](resources.md) is why.

## Design and theming

The viewer paints from Orbit's own design system: one fixed dark palette with no hue in it, no borders anywhere, one elevation scale and one spacing scale, and plain words in place of the project's own vocabulary. See [viewer design](viewer-design.md) for the tokens and what each rank of elevation is for.

Following the desktop's generated colour scheme is a switch in the rail rather than the default, so the page looks the same on every machine until somebody asks for otherwise. See [theming](theming.md).

## Boundaries

API requests require both the per-broker token and the exact loopback origin. The viewer exposes only listing, observation, pause/resume/stop, manual control and explicit account snapshot saving. Session creation and arbitrary agent actions are not exposed through its HTTP route. Responses are not cached; the page disallows external scripts and framing.

The token is for the local viewer, not a per-agent security boundary. Programs running as the same OS user can already reach the local broker. Manual input is accepted only after pause acknowledgement and shares the same action queue. It is not exposed as an MCP tool.

## QA evidence

`bun run verify tests/preview.test.ts` verifies:

- Invalid tokens and foreign origins are rejected.
- Desktop and mobile page identity, content, bounds and console health.
- Pause, image click, manual typing, submission, resume and agent readback.
- Viewer disconnect leaves work alive; reconnect and stop work.
- Capture returns while an agent is still waiting for an absent element.

Browser skill was not listed, so the existing Playwright workflow was used headlessly. Viewports: 1280 by 1120 and 390 by 844. Screenshots: `output/playwright/viewer-desktop.png` and `viewer-mobile.png`. Mobile verifies layout, not comfortable operation of every desktop-sized target.

Known limits: no zoom, drag or uploads. Live account login, a 10-minute simultaneous-work session, sustained/native frame-rate distributions remain unverified. Native fixture preview and paused manual clicks/text pass the optional Fedora integration suite. Native shortcut controls are disabled. The full T3/T4 release gates remain open.

### Viewer cost and scheduling

The viewer idles at least as long as its own last iteration cost, so a machine that cannot keep up lowers its frame rate instead of polling back to back. Before this rule a slow iteration scheduled the next poll with no delay at all, in the default 1 FPS mode as well as Smooth.

The viewer prints its own measurement inside the **Technical details** disclosure under the picture: `Viewer cycle: N ms of every M ms (S%)`, then the `request`, `decode` and `draw` split. It moved there because it is an instrument rather than a sentence a person needs, and it is still the figure a participant should report. The cycle share includes time awaiting the broker, which is not processor time; the split is what separates them. This readout exists because the viewer runs outside Orbit's runtime cgroup, so `scripts/measure-cpu.ts` cannot observe it. It is the figure a participant should report.

### Native Unicode viewer check

`ORBIT_TEST_NATIVE=1 bun run verify tests/fedora.test.ts --test-name-pattern 'native session is visible'` passed 1 test and 8 assertions in 3.96 seconds under the shared resource budget. The test creates a native session through the MCP protocol harness, opens the viewer in owned headless Chrome, confirms manual paste is rejected while running, pauses, pastes Arabic/emoji through the visible button and verifies the actual GTK text and saved result. Closing the viewer preserves the paused session. This is protocol and UI integration, not a model-driven host test. The updated `output/native/viewer.png` was visually inspected. General desktop/mobile browser checks were not rerun for this change.

## Timing correction and measurement

The original loop waited 200 ms after each capture and achieved 3.963 FPS in a 20-second browser run. The corrected loop budgets the entire poll toward its 200 ms cadence. Both backends now timestamp the start of capture work, so `capturedAt` is a conservative capture-start time rather than a claim that the image became fresh when encoding completed. The viewer updates freshness only after the image decodes.

A second measurement used one active browser session and a headless viewer, with 70 verified form submissions in 20.219 seconds:

| Measurement | Observed |
|---|---|
| Image render-readiness events | 101, approximately 4.995 FPS |
| Frame interval p95 | 217 ms |
| Capture-start to render-readiness p95 / maximum | 76 / 79 ms |
| Sampled displayed age p95 / maximum | 237 / 252 ms |
| Maximum age-sampling gap | 51 ms |
| Average machine CPU for the whole command | 1.41% across 24 threads |
| Peak charged scope memory / swap | 661,032,960 bytes / zero |
| Memory or task-limit events | None |

[validation summary](validation.md) and [validation summary](validation.md). Run `bun run scripts/limited.ts bun run experiments/viewer-timing.ts`. The final probe binds each timestamp update to its decoded image and the next animation callback. An intermediate load-event probe could associate the previous timestamp with the new image and was replaced. The original age metrics use the old completion-time semantics and should not be compared directly with the corrected ages.

This measures render readiness in a headless viewer and sampled metadata age, not physical pixels or native-viewer latency. It is one short comparison, not a five-run matched benchmark or the 10-minute simultaneous human-work gate. Closing the viewer left the session working. The full T3/T4 gates remain open.

The [validation summary](validation.md) passed 5 tests and 35 assertions across browser and native viewing/control. It explicitly holds image decoding to verify that freshness is not announced early, and delays capture to verify its work contributes to age. TypeScript checking passed.

## Native viewer wheel verification

`ORBIT_TEST_NATIVE=1 bun run verify tests/native-viewer-scroll.test.ts` drives actual wheel events over the rendered, scaled Canvas in an owned headless browser. A GTK text view running through default Xwayland moves down and back up while paused. The test checks the emitted session coordinates, rejects direct manual scroll RPC while running, and verifies wheel events after resume produce no manual RPC or application scroll. Console errors are checked and a local screenshot is retained outside Git.

The Browser plugin was not available; verification used the repository's Playwright/Chrome harness. This is an automated takeover-path test, not evidence of human participation. The resource wrapper cleans its process scope afterward.

Browser wheel coverage: `bun run verify tests/browser-scroll.test.ts` checks the actual page scroll offset after agent and viewer input. Wheel deltas in the viewer are converted to bounded steps: approximately 100 pixel units, 3 line units or one fifth of a page unit per step. Input arriving while busy is not queued. This is basic wheel support; continuous trackpad gesture fidelity remains a separate improvement.

## Identify the workspace and follow input

Each session has `agentName` and `taskName`, supplied when it is created through RPC or MCP. The CLI reads `ORBIT_AGENT_NAME` and `ORBIT_TASK_NAME`. Defaults are SbarOrbit and Agent workspace. These are descriptive labels, not authenticated agent identities. The selector retains a short session identifier to distinguish duplicate names.

The viewer shows the controlled page title, URL origin/path without query or fragment, controlled tab index and owned tab count. Native sessions show their focused private application title. This identifies Orbit's page or private application, not a tab in the user's personal browser. A tab the site opens by itself becomes the followed tab. The viewer lists the session's tabs, or the windows of a private display, and switching between them is a manual action like any other, so it requires pause.

Activity reports only action kind, actor, sequence and working/done/failed state. It does not store input text, selectors, command arguments or full URLs. Page titles and screenshots can still contain the application's private content and remain available only through the local access-controlled viewer.

The blue arrow labelled with the agent name follows the last trusted pointer event in the controlled browser's top-level page. Its listener runs in a separate JavaScript world; synthetic page events and page globals cannot set it. Navigation clears it, and stale frames hide the marker. Native sessions show the last acknowledged pointer/scroll target. Green You marks the latest manual input actor. Keyboard-only actions do not invent mouse movement. Embedded-frame pointer coverage and continuous native cursor sampling remain unverified; this overlay is a following aid, not a security or no-interference proof.

`bun run verify tests/workspace-presence.test.ts` checks names, title/location, actual click coordinates, synthetic-event rejection, input-text omission, navigation reset, manual ownership and desktop/mobile layout.

## Low-cost viewing validation

Following the participant's CPU report, live trials remain stopped. The five tests in `tests/viewer-polling.test.ts` execute the actual viewer script with a deterministic DOM, clock and RPC fixture, without launching Chrome or an Orbit agent. They verify the 1000 ms default, zero repeated captures in On demand mode, one capture after Refresh image, zero hidden-tab requests, explicit 200 ms Smooth mode, bounded reconnect backoff and bitmap closure.

Visibility is rechecked after session listing, capture and bitmap decoding. A tab hidden during those waits starts no subsequent capture or decode, and does not draw the returned bitmap. Already-started server capture or decoding may still finish; decoded bitmaps are always closed. The freshness timer skips hidden-page updates. Two race tests failed before these checks and passed afterward. Returning to the visible page resumes the existing polling chain without a second loop.

These are scheduling checks, not measurements of CPU, rendering performance or the participant's desktop app. The new settings have not yet undergone rendered-browser validation. The timing experiment explicitly selects Smooth so its historical 5 FPS target is not silently replaced with a lower bar. That experiment was not rerun after the participant report.
