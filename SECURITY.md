# Security and publication privacy

Orbit is an experimental local automation tool. Display/input separation is not a security sandbox: applications retain the OS user's filesystem permissions. Only tool calls routed through Orbit receive its session behavior. Do not expose its local broker or viewer publicly.

## Reporting

Do not place credentials, login snapshots or private screenshots in public issues. Once a GitHub repository is configured, use its private vulnerability reporting facility if enabled. No reporting address or repository URL is invented here.

## Before publication

1. Stage only intended source and documentation.
2. Run `bun run scripts/public-audit.ts` to check the staged file set and local identifiers.
3. Run `gitleaks git --staged --redact --no-banner` for staged changes, and `gitleaks git --redact --no-banner` for committed history.
4. Scan the extracted release archive with `gitleaks dir --redact --no-banner PATH`.
5. Review Git author metadata and verify that private/runtime paths are ignored.

Automated scanners reduce risk but cannot prove that no sensitive data exists. Review documentation, fixtures and generated archives as well as code. Raw local experiment evidence is kept outside version control and source packages.
