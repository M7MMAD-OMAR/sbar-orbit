# Security and publication privacy

Orbit controls original local applications with the owner's OS permissions and
ordinary shared clipboard. Application leases and target checks are cooperative
control, not an OS security sandbox. Only calls routed through Orbit receive its
session behavior. Keep the local broker private. See the
[current product contract](docs/desktop-only.md).

## Reporting

Do not place credentials, login snapshots or private screenshots in public issues. Report a vulnerability privately through GitHub's private vulnerability reporting on [M7MMAD-OMAR/sbar-orbit](https://github.com/M7MMAD-OMAR/sbar-orbit/security/advisories/new). If that is unavailable to you, open an issue saying only that you have a security report and asking for a private channel, with no detail in it.

Orbit has one maintainer and no response-time commitment. Confirmed findings and
their measurements are retained alongside repairs. Rejected findings retain their
reason rather than being silently erased. Historical audits apply to their dated
source; they do not establish a current application isolation boundary.

## Before publication

1. Stage only intended source and documentation.
2. Run `bun run scripts/public-audit.ts` to check the staged file set and local identifiers.
3. Run `gitleaks git --staged --redact --no-banner` for staged changes, and `gitleaks git --redact --no-banner` for committed history.
4. Scan the extracted release archive with `gitleaks dir --redact --no-banner PATH`.
5. Review Git author metadata and verify that private/runtime paths are ignored.

Automated scanners reduce risk but cannot prove that no sensitive data exists. Review documentation, fixtures and generated archives as well as code. Raw local experiment evidence is kept outside version control and source packages.
