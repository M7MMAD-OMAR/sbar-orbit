# Contributing

Use Bun and keep changes focused. Follow the existing code style and Conventional Commits, for example `fix(viewer): release decoded frames` or `docs: clarify account setup`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run scripts/limited.ts bun run typecheck
bun run verify
```

Native tests additionally require the Fedora runtime and `ORBIT_TEST_NATIVE=1`. Model-host experiments are opt-in and can use the host's existing authentication or paid model service.

Never commit account snapshots, browser profiles, access links, personal configuration, local logs or raw workstation evidence. Before committing, stage explicit paths and run `bun run scripts/public-audit.ts`; also scan staged content with Gitleaks as described in SECURITY.md.

Alpha version identifiers use `MAJOR.MINOR.PATCH-alpha.N`. Keep package metadata, MCP version and CHANGELOG.md aligned. Add an annotated `v` tag only after the intended source and archive checks pass. Do not silently replace a tagged artifact.
