# 0.1.1

Published on 22 September 2026 to the npm registry as `latest` and to
[GitHub](https://github.com/M7MMAD-OMAR/sbar-orbit/releases/tag/v0.1.1), tagged at `7e9c6d7`, where
all nine CI jobs passed. The published tarball was downloaded back and is byte identical to the one
built here, SHA-256 `6a50331e5e5a7d9f7828489d596fbc871d462ebdeac66d2cba1774e84d7b9d42`, 149 files in
161 tar entries, and installing it from the registry into a throwaway prefix runs `--help`,
`preflight` and `install --dry-run --json`.

A fix release, and the fix is about when to use Orbit at all. No persisted schema and no service unit
contract changed, so an existing installation upgrades in place.

## What changed

Every surface that decided when to use Orbit said "whenever a task needs a browser", so an agent
opened a session, an owned browser and a slice of the shared resource budget to read a public page a
fetch answers for free, while the host's own web tools sat unused beside them. The trial recorded in
[connectors](https://github.com/M7MMAD-OMAR/sbar-orbit/blob/main/docs/connectors.md) had already
measured the honest behaviour: a generic browser request is a generic browser tool's job, and a host
keeps it there unless its instructions say otherwise.

The rule now lives in every surface that makes the decision: the MCP adapter's own instructions and
the `orbit_create` description, the [agent interface](https://github.com/M7MMAD-OMAR/sbar-orbit/blob/main/docs/agent-interface.md),
the connectors guide, the portable `orbit-usage` skill and the README. Orbit is for the person's own
browser and logged-in accounts, a private session they can watch or take over, and real desktop
applications; a link to read, a site to review or research goes to the host's own web tools first,
which cost no session.

`tests/mcp.test.ts` pins both halves of the rule where an agent reads them, and the assertion was run
against the unfixed adapter first, where it failed on the missing words. The local suite at this
commit, Fedora 44: 468 pass, 0 fail, 27 skip, 495 tests across 100 files in 218 s with
`ORBIT_TEST_NATIVE=1`; without the native tests, 454 pass, 0 fail, 41 skip in 182 s.

## Install

```sh
bun add -g sbar-orbit
sbar-orbit install --connect auto
```

Or from a source checkout:

```sh
git clone https://github.com/M7MMAD-OMAR/sbar-orbit
cd sbar-orbit
./install.sh --connect auto      # Windows: install.cmd --connect auto
```

## Upgrade

No persisted schema and no service unit contract changed, so an existing installation upgrades in
place and the migration path from `0.1.0-alpha.8` still applies. Close Orbit sessions first, because
stopping a broker closes them.

```sh
systemctl --user stop sbar-orbit.service
bun add -g sbar-orbit@0.1.1
systemctl --user start sbar-orbit.service
```

The change is in what agents read before they choose a tool, so an MCP host reloads its adapter to
pick it up: restart the configured hosts. The managed update path takes this version 72 hours after
publication, and only where `update on` is set.

What this release does not do: measure whether an agent now chooses its own web tools more often. The
words an agent reads are asserted; the behaviour they cause on a real host is not measured here.
