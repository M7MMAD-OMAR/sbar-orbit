# Sbar Orbit website

A static landing site built with React, TanStack Router and Vite. The production build includes prerendered HTML, local fonts and a native workspace diagram. Cloudflare Workers serves static assets, with no application backend or analytics.

Live site: https://orbit.sbarah.com/

## Work locally

From the repository root, run commands one at a time within Orbit's shared budget:

```sh
bun run scripts/limited.ts bun install --cwd website --frozen-lockfile
bun run scripts/limited.ts bun run --cwd website typecheck
bun run scripts/limited.ts bun run --cwd website build
bun run scripts/limited.ts bun run --cwd website dev
```

The site runs on port 4196 and refuses to displace another service. Current content describes the desktop-only runtime and keeps existing-application handoff and platform limits visible.

## Verify static content

Run `bun run scripts/limited.ts bun run --cwd website qa` from the repository root. This runs the English and Arabic render tests without creating an Orbit session, starting a preview, contacting the broker or injecting diagnostics. Then run the typecheck and production build commands above.

These checks cover source types, localization and generated HTML. They do not measure visual layout or interactive behavior. The old standalone browser automation scripts have been removed. Historical captures in `design-qa.md` describe earlier source and do not certify the current page.

## Publish

```sh
bun run scripts/limited.ts bun run --cwd website deploy:check
WRANGLER_SEND_METRICS=false ESBUILD_WORKER_THREADS=0 NODE_OPTIONS=--max-old-space-size=768 bun run scripts/limited.ts bun run --cwd website deploy
```

Wrangler requires an authenticated Cloudflare account. The Worker is named `sbar-orbit-site`. Asset routing returns a real 404 for unknown pages.

Deployment uses the machine's Wrangler login. Credentials must remain outside the
repository. `deploy:check` performs a dry run. There is no automatic website deploy
workflow: pushing to `main` does not publish the site.

The custom domain is configured in `wrangler.jsonc`; canonical metadata, robots and
sitemap use https://orbit.sbarah.com/.

## Content and assets

- `src/App.tsx`: page content, menu, native operation evidence, install clipboard and support.
- `src/styles.css`: responsive layout, typography and theme.
- `src/main.tsx`: TanStack routes and client mounting.
- `scripts/prerender.tsx`: readable initial HTML for browsers and crawlers.
- `public/images/`: current native workspace SVG and the supplied support button.
- `public/brand/`: existing approved logo artwork.
- `design-qa.md`: verification evidence and limits.

The page explains original application opening and scoped evidence; it does not
connect to an Orbit session or provide a desktop viewer. Installation commands
are copied, never executed by the website. Support opens its configured external
destination without loading a third-party widget.

Earlier navy ink illustration prompts remain in `desktop-assets.json` as dated
provenance. Their deleted image names and private-desktop wording do not describe
the current shipped assets or product. See [asset provenance](ASSETS.md). The
current SVG is an architecture diagram, not an application screenshot.

## Languages

English lives at `/`, Arabic at `/ar/`. Both are prerendered with their own
language, direction, canonical URL and social metadata. The language switch uses
ordinary links so it also works before JavaScript. Arabic copy is independently
written in `src/locale.tsx`; linked technical documents remain English and are
labelled accordingly. Terminal commands remain LTR in both layouts.

Run `bun run scripts/limited.ts bun test website/tests/locale.test.tsx` from the
repository root. The test file checks both locales without a graphical session.

The landing page includes native application evidence, an architecture diagram
and a three-step quick guide in both languages. Deeper technical reference stays
on GitHub. Source rendering tests do not certify current visual layout, native
input or live session state. Use [the current product contract](../docs/desktop-only.md)
and [acceptance index](../docs/acceptance.md) for operational meaning.
