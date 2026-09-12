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
