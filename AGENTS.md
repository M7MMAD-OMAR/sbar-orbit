# Orbit, for agents

Orbit gives an agent its own private browser or Fedora display so the person can keep working. If you
are reading this inside a session an agent host started, you are probably here for one of two reasons.

**You were asked to install Orbit.** Read [docs/agent-install.md](docs/agent-install.md) and follow
it. It is the contract: the commands, the JSON, the exit codes, and the line between what you may run
and what you hand back to the person. The short version is `./install.sh --dry-run --json` to plan,
`./install.sh --json` to act, and never `sudo`.

**You were asked to change this repository.** The rest of this file, and the sections below.

## Build and test

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run verify                      # the suite, inside the shared resource budget
ORBIT_TEST_NATIVE=1 bun run verify  # adds the private display tests, needs the Fedora runtime
```

Every Orbit entry point runs inside a shared systemd user slice. `bun test` on its own refuses with
`RESOURCE_LIMIT_REQUIRED`; `bun run verify` and `bun run scripts/limited.ts <command>` are how a
command gets that budget. Run one bounded command at a time: two splitting one budget time each other
out, and that shows up as viewer tests failing rather than as contention.

## Conventions

- Bun only. Never npm or npx.
- No em dashes or en dashes, in any file, in any language. A comma, a colon, or two sentences.
- `noUncheckedIndexedAccess` is on. Fix the type at the source rather than writing `!` at each index.
- Commit only the paths belonging to the finished task. Other agents have their own work in this tree.
- Times are written in 12 hour form.

## The rule this project is judged on

An unknown measurement is `not measured`, never a pass. A capability is claimed at the tier its
evidence supports and no higher, with the limit printed beside it: see
[docs/support-tiers.md](docs/support-tiers.md). A test that has not run against the unfixed code has
not shown that it catches anything. Installing Orbit is installation state, not a measurement, and
nothing in [docs/roadmap.md](docs/roadmap.md) is closed by it.

Agents do not touch the person's own browser, screen, pointer or windows. That is the whole point of
the project, and it holds while working on the project too.

<!-- graft:start -->
## Graft, the repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here, understanding how something works, finding where code lives,
or scoping a change, get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first: a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer, so cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete, so run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges, who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects,
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to, never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
