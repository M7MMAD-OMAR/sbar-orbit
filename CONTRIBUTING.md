# Contributing

Use Bun and keep changes focused. Follow the existing code style and Conventional Commits, for example `fix(viewer): release decoded frames` or `docs: clarify account setup`.

```sh
bun install --frozen-lockfile --ignore-scripts
git config core.hooksPath .githooks
bun run scripts/limited.ts bun run typecheck
bun run verify
```

The hook path is per clone and is not carried in the repository, so a fresh clone runs no pre-commit hook until you set it. Without it neither the publication audit nor the secret scan runs on your staged changes. The hook needs `gitleaks` on PATH, or `GITLEAKS_BIN` pointing at it.

Two gaps to know about rather than trip over. `tsconfig.json` covers `src`, `tests` and `experiments`, so nothing under `scripts` is typechecked; keep logic in `src` and leave `scripts` as thin wrappers. Continuous integration cannot run `bun run verify`, because the shared budget it requires is not available there, so it runs only the pure unit tests listed in `.github/workflows/checks.yml`; add new pure tests to that list by hand, and run the full suite locally.

Native tests additionally require the Fedora runtime and `ORBIT_TEST_NATIVE=1`. Model-host experiments are opt-in and can use the host's existing authentication or paid model service.

Never commit account snapshots, browser profiles, access links, personal configuration, local logs or raw workstation evidence. Before committing, stage explicit paths and run `bun run scripts/public-audit.ts`; also scan staged content with Gitleaks as described in SECURITY.md.

Alpha version identifiers use `MAJOR.MINOR.PATCH-alpha.N`. Keep package metadata, MCP version and CHANGELOG.md aligned. Add an annotated `v` tag only after the intended source and archive checks pass. Do not silently replace a tagged artifact.
