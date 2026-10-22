# Orbit agent instructions

Read `~/AGENTS.md` directly. No long dashes anywhere. Bun only.
Use `main` in this checkout. Do not create branches or worktrees. Preserve
unrelated changes. Commit and push finished task paths to `main`.

## Original applications and current owner authorization

For ordinary web tasks, prefer the AI host's built-in browser or its normal web
tools. Orbit provides native desktop application control, not a browser-specific
session backend. Use Orbit for original installed desktop application tasks. Use
the owner's normal browser or personal profile through Orbit only when the owner
explicitly requests that browser or profile. Original browser and terminal
registrations remain supported; this routing preference is not a category ban.
Never copy profiles or create a hidden substitute desktop.

The owner explicitly enabled original browsers, terminals and other installed
applications on 22 October 2026. Do not invent a category ban or revive obsolete
browser prohibitions from historical documents. Use Orbit with an exact installed
registration and an explicit visible numbered workspace, preserving normal owner
state. Do not create hidden substitute desktops or copy application profiles.

Input and capture availability must follow the actual adapter and prepared build.
The historical incident is diagnostic evidence, not permanent user policy. Repair
and measure event delivery, cursor visibility and lifecycle behavior; do not call
an operation successful merely because a command returned ok. Preserve unrelated
windows, unsaved content, owner focus and pointer. Report actual measurements.

Load `skills/sbar-orbit/SKILL.md` for native desktop application work. Respect conversation off.
Never restart a shared broker while another task has active work.

## Verification

```sh
bun install --frozen-lockfile --ignore-scripts
bun run scripts/limited.ts bun run typecheck
bun run verify
```

Run one budgeted command at a time. Automated contract tests use owned fixtures; actual native browser
acceptance uses the original visible application and preserves owner work. Times use 12 hour form. Fix types at their source with
`noUncheckedIndexedAccess`. See `docs/desktop-only.md` for the product contract.

<!-- graft:start -->
## Graft : repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here : understanding how something works, finding where code lives,
or scoping a change : get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first : a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer : cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete : run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges : who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects :
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to : never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
