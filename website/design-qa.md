# Orbit landing page design QA

final result: passed

## Scope and reference

Reference: the user-approved ivory/navy ink landing mockup `exec-84293ea4-fd30-411e-b415-cbda3ec8ea34.png` and its mobile counterpart. The selected reference and rendered captures were opened together for visual comparison. The mockup is a full page; evidence captures are viewport-sized section views. This is a design-language and responsive-layout comparison, not a claim of pixel-identical full-page length.

The later user request intentionally adds a clear problem, reasons to use Orbit and a Buy Me a Coffee section. The result also keeps platform and security limits accessible in concise disclosures. These content additions increase page length while keeping the reference's spacious rhythm.

## Findings and fixes

- P1, resolved: the original static App render did not have the same provider tree as the client TanStack Router, causing React error 418. Static HTML remains available for the first paint and crawlers; the client now mounts the router normally. The final browser audit reports zero errors at all four widths.
- P2, resolved: a wide desktop illustration would be too small on phones. Generated a separate vertical composition and select it through picture/source. Both scenes stay legible at mobile sizes.
- P2, resolved: multiplying ivory image backgrounds made rectangular fields darker than the page. Changed image blending to darken and recaptured.
- P2, resolved: clipboard failure feedback was only available to screen readers. A visible status line now reports copy success or manual-copy guidance. Final trusted browser click returned `Copied`.
- P3, accepted: generated ink has subtle paper texture; it is a visual illustration, not a product screenshot.

## Required visual surfaces

- Typography: locally hosted DM Sans, strong large headings, restrained body copy and readable line lengths. No clipped text at 320, 390, 768 or 1440 pixels. At 320 pixels the hero intentionally wraps over more lines and CTAs stack.
- Spacing/layout: broad desktop margins, one-column mobile reflow, large independent drawings, no horizontal overflow. Problem, solution, control, installation and support remain visibly distinct.
- Colors: approved navy identity, ivory surface, coral actions with dark text for contrast. Dark viewer section uses off-white text. Original yellow donation button remains identifiable.
- Images: four optimized WebP illustrations, including a mobile-specific hero. No broken images. Below-fold artwork is lazy-loaded and is confirmed loaded after scrolling.
- Content: clear desktop-input conflict, separate workspaces as the solution, three practical benefits, install path and voluntary support. Experimental alpha and measured-platform limits are printed beside installation. Security separation is not overstated.

## Functional verification

Private Orbit session, automated sequential RPC actions:

- Widths 320, 390, 768, 1440, each at 1000 pixel height: no overflow, broken images, JavaScript errors, missing local anchors or empty links.
- Mobile menu opens, link selection closes it and navigates to support.
- All four viewer tabs produce their respective explanation.
- Installation copy button returns `Copied` after a real browser click.
- Architecture and security disclosures open and display their contents.
- Buy Me a Coffee link is exactly `https://www.buymeacoffee.com/m7mmadomar`, uses a local image and opens a separate tab with noopener/noreferrer.
- Keyboard focus styles, roving tab selection and reduced-motion CSS are implemented. Real keyboard-only and screen-reader walkthroughs are not measured.

Local evidence, intentionally excluded from source control:

- `evidence/browser-audit.json`
- `evidence/viewport-1440.jpg`, `viewport-768.jpg`, `viewport-390.jpg`, `viewport-320.jpg`
- `evidence/mobile-menu.jpg`, `mobile-support.jpg`
- `evidence/desktop-viewer.jpg`, `desktop-install.jpg`, `desktop-architecture.jpg`, `desktop-support.jpg`

## Build and deployment checks

- TypeScript check: passed.
- Vite production build and static HTML render: passed.
- Wrangler dry run: passed.
- Diagnostic browser instrumentation is removed by the QA script before deployment.
- Browser coverage is Chromium in an Orbit private session. Safari, Firefox and real mobile devices are not measured.

## Live verification

Published at https://sbar-orbit-site.default-1a8.workers.dev/. The home page and both hero variants plus the support image return HTTP 200. Unknown routes and the removed diagnostic script return HTTP 404. Response headers include nosniff and frame protection; initial HTML contains the real page content.

The public page heading was read through Orbit. Public-site screenshot and interaction attempts hit Orbit browser timeouts, so live visual and interaction verification is not measured. The same production assets passed the complete local Chromium visual and interaction audit. Initial Python HTTP requests received 403; subsequent curl requests returned the expected 200/404 responses.

## Arabic edition, 13 September 2026

Rewrote the landing-page copy in conversational Arabic, including accessibility
labels, feedback, FAQs and support. Added a persistent language switch, RTL layout,
local Noto Sans Arabic, RTL tab keyboard navigation and LTR installation commands.
Both language pages include static HTML and their own canonical metadata.

Arabic browser checks passed at 1440, 768, 390 and 320 pixels: no overflow, broken
images, JavaScript errors, missing anchors or empty links. Menu, viewer controls,
disclosures and Arabic clipboard feedback passed. Screenshots were reviewed for
Arabic shaping, spacing and illustration placement. Technical documents linked on
GitHub remain English; Arabic link labels disclose that limitation.

## Illustrated bento revision, 13 September 2026

The revised middle-page concept is `exec-e2669256-a7a4-4fb6-8869-adcf428d6cea.png`.
The original hero and support identity remain. The asymmetric overview reuses the
approved private-spaces and viewer illustrations, with live translated labels.
The architecture is native HTML/CSS so Arabic remains readable on narrow screens.
The quick guide replaces FAQ disclosures with visible setup steps and commands.

Intentional concept adjustments: existing brand artwork replaces the concept's
invented orbit symbol. The viewer tile retains real explanatory tabs. Architecture
copy describes screen and input separation, never filesystem or security isolation.
The quick guide is an open three-step layout, not another set of bordered tiles.

Visual comparison ledger:

- Layout: asymmetric two-column bento follows the section concept; RTL reverses the reading order.
- Palette: retained ivory, navy and sage tiles, with coral reserved for the broker.
- Typography: live DM Sans and Noto Sans Arabic replace raster concept text, with wrapping reviewed.
- Images: reused approved ink artwork, enlarged the viewer crop and removed excess space above the browser illustration.
- Hierarchy: attached the optional viewer connector to the broker, with a separate mobile branch layout.
- Guidance: visible numbered steps, LTR commands and an optional English reference replace all accordions.
- First viewport: hero wording and images are unchanged; navigation now links to the in-page guide and hierarchy.

Concept and local Orbit screenshots were inspected with view_image at a 1440-pixel
browser width, plus mobile screenshots at 390 pixels. The concept was generated at
1488 pixels; layout comparison accounts for the 48-pixel viewport difference.

Verification limits: the shared Orbit service restarted during full browser runs.
The Arabic run reached all four viewport checks, menu and clipboard checks, viewer
tabs and desktop/mobile captures of all three changed sections, then failed on a
later support screenshot. A final focused Arabic capture was reviewed after the
image-size adjustment. The final English browser navigation timed out. These are
partial browser runs, not a complete browser-suite pass. Type checking, production
build and four locale/static-content tests passed. No diagnostic script is deployed.

## Automatic presentation revision

The viewer is now the large bento tile. Its illustration uses `object-fit: contain`
and its native aspect ratio at every breakpoint. Four task-selection buttons were
replaced with a seven-second automatic walkthrough, passive progress segments and
one pause control. All descriptions remain visible when reduced motion is preferred.
The architecture highlights agent, broker, workspace and optional viewer in order,
with an explanatory caption and a separate animation pause control. Motion stops
while offscreen, backgrounded, hovered or keyboard-focused. Timer cleanup preserves
the remaining reading time when paused; it does not skip ahead on resume.
