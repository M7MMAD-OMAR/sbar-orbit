# Security and publication privacy

Orbit is an experimental local automation tool. Display/input separation is not a security sandbox: applications retain the OS user's filesystem permissions. Only tool calls routed through Orbit receive its session behavior. Do not expose its local broker or viewer publicly.

## Reporting

Do not place credentials, login snapshots or private screenshots in public issues. Report a vulnerability privately through GitHub's private vulnerability reporting on [M7MMAD-OMAR/sbar-orbit](https://github.com/M7MMAD-OMAR/sbar-orbit/security/advisories/new). If that is unavailable to you, open an issue saying only that you have a security report and asking for a private channel, with no detail in it.

Orbit is an alpha with one maintainer and no response-time commitment. What it does commit to: a report that turns out to be real is fixed with the measurement beside it, and a report that turns out not to be real is written down as such rather than deleted. The macOS security audit in `docs/research/macos/security-audit.md` includes the one finding of its eight that was not real, for that reason.

## Before publication

1. Stage only intended source and documentation.
2. Run `bun run scripts/public-audit.ts` to check the staged file set and local identifiers.
3. Run `gitleaks git --staged --redact --no-banner` for staged changes, and `gitleaks git --redact --no-banner` for committed history.
4. Scan the extracted release archive with `gitleaks dir --redact --no-banner PATH`.
5. Review Git author metadata and verify that private/runtime paths are ignored.

Automated scanners reduce risk but cannot prove that no sensitive data exists. Review documentation, fixtures and generated archives as well as code. Raw local experiment evidence is kept outside version control and source packages.
