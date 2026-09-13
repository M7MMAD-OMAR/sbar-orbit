# Sbar Orbit website

A static landing site built with React, TanStack Router and Vite. The production build includes prerendered HTML, local fonts and optimized illustrations. Cloudflare Workers serves the static assets, with no application backend or analytics.

Live site: https://orbit.sbarah.com/

## Work locally

From the repository root, run commands one at a time within Orbit's shared budget:

```sh
bun run scripts/limited.ts bun install --cwd website --frozen-lockfile
bun run scripts/limited.ts bun run --cwd website typecheck
bun run scripts/limited.ts bun run --cwd website build
bun run scripts/limited.ts bun run --cwd website dev
```

The site runs on port 4196 and refuses to displace another service. Browser verification uses an Orbit private session.

## Verify in Orbit

With the production preview running, run `bun run scripts/limited.ts bun run --cwd website qa` from the repository root. The QA command creates a private session, temporarily adds local diagnostics, captures four viewport sizes, tests interactions, then removes diagnostics and closes its session. Do not deploy while QA is running.

## Publish

```sh
bun run scripts/limited.ts bun run --cwd website deploy:check
WRANGLER_SEND_METRICS=false ESBUILD_WORKER_THREADS=0 NODE_OPTIONS=--max-old-space-size=768 bun run scripts/limited.ts bun run --cwd website deploy
```

Wrangler requires an authenticated Cloudflare account. The Worker is named `sbar-orbit-site`. Asset routing returns a real 404 for unknown pages.

## Content and assets

- `src/App.tsx`: page content, menu, viewer explanation, install clipboard and disclosures.
- `src/styles.css`: responsive layout, typography and theme.
- `src/main.tsx`: TanStack routes and client mounting.
- `scripts/prerender.tsx`: readable initial HTML for browsers and crawlers.
- `public/images/`: AI-generated navy ink illustrations and the supplied Buy Me a Coffee button.
- `public/brand/`: existing approved logo artwork.
- `design-qa.md`: verification evidence and limits.

The viewer controls explain capabilities, they do not connect to an actual Orbit session. Installation commands are copied, never executed by the website. Support links to the user's supplied Buy Me a Coffee account in a separate tab, without loading a third-party widget.

The source illustration reference is the user-approved long ivory and navy landing mockup (`exec-84293ea4-fd30-411e-b415-cbda3ec8ea34.png`). The final layout adds the user-requested problem, benefits and support sections. Generated imagery is illustrative, not a product screenshot.

## Deployment

Deployment is one command from this directory, run by a person:

```sh
bun run build
bun run deploy
```

`wrangler deploy` uses the Wrangler login already on the machine, so nothing in the
repository holds a credential and no Cloudflare API token is stored as a repository
secret. `bun run deploy:check` is the same deployment as a dry run.

There is no GitHub Actions workflow for this. A push to `main` deploys nothing, which
is deliberate: the site goes out when somebody decides it goes out.

The custom domain is managed in `wrangler.jsonc`; canonical metadata, robots and
sitemap use https://orbit.sbarah.com/.

## Languages

English lives at `/`, Arabic at `/ar/`. Both are prerendered with their own
language, direction, canonical URL and social metadata. The language switch uses
ordinary links so it also works before JavaScript. Arabic copy is independently
written in `src/locale.tsx`; linked technical documents remain English and are
labelled accordingly. Terminal commands remain LTR in both layouts.

Run `bun run scripts/limited.ts bun test website/tests/locale.test.tsx` from the
repository root. Set `QA_LOCALE=ar` for the browser QA command to test Arabic.

The landing page includes an illustrated bento overview, an always-visible
architecture diagram and a three-step quick guide in both languages. The viewer
tabs explain session controls; they do not control a live agent. Deeper technical
reference stays on GitHub. No essential guidance is hidden in disclosures.

The large viewer illustration uses its full aspect ratio. Its walkthrough advances
every seven seconds, with a pause control and progress indicators. The architecture
highlights an explanatory stage every 2.6 seconds. Both pause on hover, keyboard
focus, hidden tabs and offscreen placement. Reduced-motion users receive static
content, including all four viewer descriptions. These are illustrations, not live
session state.
