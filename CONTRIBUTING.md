# Contributing

Use Bun and keep changes focused. Follow the existing code style and Conventional Commits, for example `fix(viewer): release decoded frames` or `docs: clarify account setup`.

```sh
bun install --frozen-lockfile --ignore-scripts
git config core.hooksPath .githooks
bun run scripts/limited.ts bun run typecheck
bun run verify
```

The hook path is per clone and is not carried in the repository, so a fresh clone runs no pre-commit hook until you set it. Without it neither the publication audit nor the secret scan runs on your staged changes. The hook needs `gitleaks` on PATH, or `GITLEAKS_BIN` pointing at it.

There is no hosted continuous integration. `bun run verify` needs the shared budget, which a hosted runner does not have, and the workflow that ran only the pure unit tests was removed rather than kept as a partial gate. Every gate runs locally: the typecheck, the full suite, the publication audit and the Gitleaks scan, in that order, before a commit.

Native tests additionally require the Fedora runtime and `ORBIT_TEST_NATIVE=1`. Model-host experiments are opt-in and can use the host's existing authentication or paid model service.

Never commit account snapshots, browser profiles, access links, personal configuration, local logs or raw workstation evidence. Before committing, stage explicit paths and run `bun run scripts/public-audit.ts`; also scan staged content with Gitleaks as described in SECURITY.md.

Binary files are refused by the publication audit unless they have been reviewed. The review is recorded in `scripts/public-audit.ts` as a path and the SHA-256 of its content, so replacing an approved file with different bytes fails again rather than inheriting the approval. Adding a binary means looking at it, saying in the commit what it is, and adding its hash; there is no flag that skips this. Today the list holds the brand artwork under `brand/logo/` and nothing else.

The two scanners answer different questions and neither replaces the other. The publication audit looks for personal paths, private addresses and generated artifacts in tracked content. Gitleaks looks for key material. A staged file carrying a live-looking API key passes the audit and is refused by Gitleaks; a personal home path passes Gitleaks and is refused by the audit.

To check the whole repository rather than one commit:

```sh
gitleaks git --redact --no-banner
gitleaks dir . --redact --no-banner
```

The directory scan reports findings inside `output/`, which is gitignored working evidence and never committed. Those are the API keys Chrome ships inside the throwaway browser profiles an experiment retains, not project secrets.

Alpha version identifiers use `MAJOR.MINOR.PATCH-alpha.N`. Keep package metadata, MCP version and CHANGELOG.md aligned. Add an annotated `v` tag only after the intended source and archive checks pass. Do not silently replace a tagged artifact.
