# Orbit documentation

The current product is desktop-only. Start with these contracts:

- [Desktop sessions and limits](desktop-only.md)
- [Adaptive native architecture](native-adaptive-architecture.md)
- [Application discovery](application-discovery.md)
- [Agent installation](agent-install.md)
- [Agent interface](agent-interface.md)
- [Host connections](connectors.md)
- [Resource limits](resources.md)
- [Native handoff incident and release hold](native-handoff-incident.md)

## Verification and release

The main CI workflow runs desktop product contracts, website checks, generated host
registration, packaging, installer and service-path contracts on Linux, Windows and
macOS. It does not run the retired standalone browser acceptance or require Chrome
trace artifacts. This is a deliberate product-boundary change, not proof that those
old browser checks pass. A separate mandatory Linux job provisions Wayland development files in a capped
container and runs the compiled selection-lifetime guard in the host shared budget.
Native runtime acceptance still needs its actual supported runtime. Platform metadata and mocked service contracts do not prove native input.

Release publication requires a single reviewed source tree, matching source and
registry-format archives, current version metadata and explicit capability limits.
Website publication is a separate Cloudflare deployment. Publishing code does not
activate a workstation service or establish existing-application handoff support.

## Historical evidence

Old release notes, browser performance investigations, account and viewer measurements,
and platform reports remain as evidence for their named revisions. They are not
current setup instructions. Git history also retains removed instructions.
[Release readiness](release-readiness.md), [roadmap](roadmap.md),
[validation](validation.md), [accounts](accounts.md), and [preview](preview.md) contain
historical results. Their browser measurements do not establish desktop capabilities.

Obsolete release-specific setup pages for alpha.8, alpha.9, 0.1.0, 0.1.1 and 0.2.0
have been removed from the current documentation. Their inbound links now point to
the corresponding versioned GitHub release pages. The original files remain in Git
history, and a checksum-indexed local evidence copy was retained before removal.
