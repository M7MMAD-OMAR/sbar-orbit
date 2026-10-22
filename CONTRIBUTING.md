# Contributing

Use Bun, keep changes focused and follow Conventional Commits, for example
`refactor(applications): separate registration parsing` or
`fix(native): preserve launch identity`. Read `AGENTS.md` and the
[architecture guide](docs/architecture.md) before changing module boundaries.

## Local verification

```sh
bun install --frozen-lockfile --ignore-scripts
git config core.hooksPath .githooks
bun run scripts/limited.ts bun run typecheck
bun run scripts/limited.ts bun run check:architecture
bun run verify
```

The supported suite exercises native product contracts without launching browsers
or creating private desktops. Platform-specific tests can skip on other hosts;
report those skips explicitly. Tests and typechecks run one budgeted command at a
time. See [support tiers](docs/support-tiers.md) for the difference between a source
contract and actual application acceptance. Never bypass the native input/capture
release hold to test a refactor.

`.github/workflows/verify-native.yml` runs source contracts and the dependency guard
on Linux, Windows and macOS. Its website job checks and builds the English and
Arabic static site. Hosted results do not establish desktop application control.
Use the local full suite for production changes, plus the existing focused tests
for any affected updater, installer or platform adapter. Model-host experiments
are opt-in and can use an existing authenticated or paid model service.

## Code organization

- Keep CLI, MCP and RPC adapters thin. Validation belongs at the boundary that
  owns the operation. Policy and permission checks must remain enforced there.
- Give each module one reason to change. Share domain types and small filesystem
  primitives below feature orchestration, without importing an entire feature
  for one helper. Prefer existing modules over speculative frameworks.
- Keep strict launch parsing separate from permissive metadata discovery. A
  parser used to display a registration does not authorize its execution.
- Preserve public exports when moving code. Change callers and documentation
  together when an intentional API change is required.
- Keep runtime dependencies acyclic. `check:architecture` follows static imports,
  re-exports and literal dynamic imports across production TypeScript. It also
  enforces explicit leaf dependencies. Extend those rules with the module design.
- Keep pure parsers independent from filesystem, service and UI behavior. Pass
  the data they need. Place runtime command identity below installation and
  update orchestration.
- Preserve validation order, limits and precise error codes during refactors.
  Keep aliases distinct from canonical executable identity. Use existing public
  behavior tests to catch changes rather than testing private implementation shape.
- TypeScript rejects unused locals and parameters across production, scripts, tests
  and indexed experiments. Remove dead imports and fields instead of retaining
  them for possible future use.
- Use strict types and fix unchecked access at its source. Do not silence
  uncertainty with non-null assertions. Use no em dashes or en dashes.

## Publication and secrets

The hook path is per clone. A fresh clone runs no pre-commit hook until configured.
The hook requires `gitleaks` on PATH, or `GITLEAKS_BIN` pointing at it. Before a
commit, stage explicit task paths, run `bun run scripts/public-audit.ts`, and scan
staged content with Gitleaks as described in [SECURITY.md](SECURITY.md).

Never commit personal configuration, account data, access links, local logs or raw
workstation evidence. Publish only reviewed, sanitized measurements. The public
audit rejects unreviewed binaries. Approved assets are recorded by exact path and
SHA-256, so replacing their bytes requires another review. The public audit and
secret scan answer different questions; neither replaces the other.

To inspect repository history or local content:

```sh
gitleaks git --redact --no-banner
gitleaks dir . --redact --no-banner
```

Ignored local artifacts can still contain sensitive data. Do not publish them or
assume every finding is a false positive.

Versions use `MAJOR.MINOR.PATCH`, or `MAJOR.MINOR.PATCH-alpha.N` for a prerelease.
Keep package metadata, MCP version and `CHANGELOG.md` aligned. Add an annotated
`v` tag only after source and archive checks pass. Do not replace tagged artifacts.

Reports from another distribution, compositor or operating system are useful new
evidence. `sbar-orbit doctor --report` describes the host; the
[support tiers](docs/support-tiers.md) explain what it establishes and where to
submit a report.
