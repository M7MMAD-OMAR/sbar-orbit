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
## Graft: repo context graph

`graft/` holds linked markdown nodes with exact file:line spans, kept in sync with the code. Ask it
before grepping or opening source files.

- `graft ask "<question>" --source`: ranked nodes with the code inlined; `--full` for whole spans.
- `graft grep "<literal>"`: every occurrence, grouped by symbol, when top-N is not enough.
- `graft skeleton <file>`: every signature and span, cheaper than reading the file.
- `graft callers <symbol>`: exact edges; `--direction out` for callees, `--depth N` for blast radius.
- `graft map`: orientation in an unfamiliar tree; `graft/INDEX.md` lists every node.

Open a source file only at the file:line a node names. After big changes run `graft build`.
<!-- graft:end -->
