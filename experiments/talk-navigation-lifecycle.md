# Talk navigation and concurrent viewer capture

Status on 30 September 2026: a local pending-font capture failure is reproduced
and corrected. The real Talk loading failures remain unresolved. Navigation
success alone is not evidence that Talk's scripts loaded correctly.

The opt-in [diagnostic](talk-navigation-lifecycle.ts) creates an Orbit browser
session using the normal session dispatcher, a private system Chromium profile
copy, and bounded Nextcloud and GitLab origins. It records lifecycle times,
resource types, response status and fixed network error codes. It does not
record URL paths, queries, headers, payloads, console text or page content.
The profile copy and workspace are removed after the session closes.

```sh
ORBIT_REAL_PROFILE=1 bun run scripts/limited.ts bun run experiments/talk-navigation-lifecycle.ts
ORBIT_REAL_PROFILE=1 ORBIT_DIAGNOSTIC_VIEWER=1 bun run scripts/limited.ts bun run experiments/talk-navigation-lifecycle.ts
```

Three runs without frame polling completed navigation in 9,960, 10,423 and
9,867 ms, with no page errors. Their slowest completed resources were scripts,
and the document remained interactive while later resources loaded. A run with
the former Playwright screenshot path polling once a second exceeded the
15 second action deadline. No `DOMContentLoaded` event had fired after a
further 20 second wait. It produced no frames and nine capture errors. The
longest recorded script requests took about 28 seconds.

## Pending web font regression

A separate local page uses a fallback font while one web-font response remains
open. `tests/browser-font-capture.test.ts` failed against the original code
with `TIMEOUT`, explicitly naming its wait for fonts. The viewer now calls
Chromium's `Page.captureScreenshot` on the owned tab, keeping the existing
JPEG format, quality, viewport and bounded capture deadline. It captures the
current surface rather than waiting for font completion. The same test passed,
along with the navigation, tab and capture-budget checks.

The capture protocol is defined in the
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
The installed Playwright protocol types confirm the JPEG quality,
`fromSurface` and `captureBeyondViewport` parameters used here. A private CDP
connection is reused for each tab, removed on tab closure, and detached on a
capture timeout. It creates no new agent API or access to the person's browser.

Type checking passed. A full run recorded 563 pass, 45 skip and one failure
in an existing frame-age test whose mock implemented the former screenshot
interface. That mock was updated while preserving its assertion that capture
work contributes to frame age. The subsequent targeted run passed all
20 tests across preview, font capture, navigation, tabs and capture budgets.
This is not a fresh passing full-suite result.

## Live failures retained

The first live run with direct surface capture produced four frames without
capture errors and completed navigation in 5,680 ms. Several script responses
reported status 200 followed by `net::ERR_SSL_PROTOCOL_ERROR`; six page errors
were observed. Reusing one capture connection produced two frames without
capture errors and completed navigation in 3,036 ms, but still had failed script
responses and four page errors. These faster returns do not establish a usable
Talk page. A subsequent run without polling produced no page errors.

Inspection found that both the namespace network proxy and CDP relay use Bun
socket writes without inspecting partial-write results or handling `drain`.
The [Bun TCP documentation](https://bun.com/docs/runtime/networking/tcp)
states that socket writes are unbuffered and applications must handle
backpressure. Dropped tails under pressure are a hypothesis for the TLS and
capture failures, not yet a measured cause. A bounded byte-for-byte local
transport regression is the next required check. Account refresh, device use,
other applications and full application parity remain unmeasured by this work.
