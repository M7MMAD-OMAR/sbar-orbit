# Live workspace preview

**Resource correction:** The earlier timing runs did not audit complete Chrome cgroup membership. Their resource figures are historical, not whole-browser measurements. See [containment correction](resources.md#chrome-containment-correction) for the failed sustained attempt and the corrected short rerun.
Implemented for browser and Fedora native sessions: live images, session selection, pause/resume/stop, and manual input while paused. The viewer never opens automatically.

## Use

With the broker running and `ORBIT_SOCKET` configured:

```sh
bun run src/cli.ts preview
```

Open the complete returned URL. Its fragment contains a per-broker access token. The viewer runs on an automatically allocated loopback port. Closing the page leaves sessions running. Stopping the broker closes the preview server as well.

To take control: select a session, choose **Pause agent**, wait for **Paused**, then click inside its image. Use **Send text** or **Send key** to operate the focused element. **Resume agent** enables agent actions again. For Fedora native sessions, **Paste text** uses the workspace clipboard and Ctrl+V, supporting Arabic and emoji in applications that accept that shortcut. Wait for the text to appear before taking the next action. Native general key controls remain disabled. All input targets the owned session; the human desktop receives no injected input.

Frames refresh on a 200 ms target cadence that includes request, capture and decoding time. Slow work does not create overlapping polls. The page displays frame age and marks frames older than 1 second. Hidden tabs skip image capture. This is best-effort polling; a short browser measurement reached approximately 5 FPS, with broader conditions still unverified. Capture does not wait behind an agent's locator action; concurrent capture requests share one in-flight screenshot.

The viewer draws into a reusable Canvas and closes each decoded ImageBitmap immediately after drawing, including discarded frames. This replaces the image-element path that retained hundreds of MiB of renderer shared memory. See the [memory investigation](viewer-memory.md) for measurements and the still-open sustained gate.

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

Known limits: one page per session, fixed 1280 by 800 browser viewport, no zoom, drag, wheel, uploads or tab picker. Live account login, a 10-minute simultaneous-work session, sustained/native frame-rate distributions remain unverified. Native fixture preview and paused manual clicks/text pass the optional Fedora integration suite. Native shortcut controls are disabled. The full T3/T4 release gates remain open.

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
