# Desktop support tiers

Current scope, 16 October 2026: Orbit controls applications through native desktop
adapters. Standalone browser sessions, browser viewers, DOM automation and browser
profile copying are retired. Historical browser results do not establish desktop
support. See [the desktop contract](desktop-only.md).

## Evidence vocabulary

| Tier | Meaning |
| --- | --- |
| Measured | A named reproducible test passed for the stated capability, source revision and host class. |
| Limited | A test or pilot passed within an explicit restriction, such as one application, a disposable environment or a subset of operations. |
| Failed | An executed test did not pass. Preserve the failure and its scope alongside any later correction. |
| Reasoned | An implementation or platform primitive provides a basis for investigation, but the claimed runtime behavior has not been measured. |
| Refused | The current product deliberately rejects an operation. A refusal is not successful application control. |

`Unsupported` means no usable adapter is implemented or available. `Not measured`
means evidence is absent. Neither is a pass. Installation, version numbers,
metadata discovery and `doctor --report` do not upgrade a runtime capability.
A passing suite covers only tests that actually executed, not its skipped cases.

## Current capability boundaries

| Capability | Current status and limit |
| --- | --- |
| Desktop-only public contract | Implemented at the broker, CLI and MCP boundary. Browser operations are refused. Source verification and activation of an installed broker must be recorded separately. |
| Linux private desktop | Limited native application evidence on the Fedora runtime. Application/toolkit compatibility and isolation must be checked for the selected operation; this is not support for every Linux desktop or application. |
| Private desktop workspaces | Limited to numbered Sway private workspaces and exact session-scoped window moves. This does not establish movement of owner windows on arbitrary desktop environments. |
| Application discovery | OS metadata adapters cover Linux registrations and processes, macOS bundles and Windows App Paths. Metadata does not establish launch, account continuity or native control. See [application discovery](application-discovery.md). |
| Installed application launch | A Linux registration-based route is implemented for supported literal launch recipes and bounded literal forwarders. It creates new private state. Complex scripts, Flatpak, terminal and DBus activation remain explicitly unsupported by this route. Acceptance is specific to the executed fixture and source revision. |
| Private accessibility inspection | Read-only integration is in progress, pending validation. It does not establish semantic mutation or existing owner application control. |
| Existing owner application handoff | Refused under the compositor crash [release hold](native-handoff-incident.md). Isolated fixture results do not authorize owner activation. |
| Windows and macOS native control | Unsupported: native desktop control adapters are not implemented. Discovery and installation contracts do not establish native runtime support. |

## Retained desktop pilot

The [14 October desktop guide pilot](https://github.com/M7MMAD-OMAR/sbar-orbit/blob/609a000889584a1ddc2bbb7e3a3798792f6fb05d/docs/desktop-guide.md)
is Limited evidence from one workstation. It records authorized application
opening, an editor save and a later calculator accessibility sequence. The guide
itself is a visual overlay and sends no input. The initial shared-pointer attempt
was rejected, and existing Chrome control on workspace 4 did not complete.
The optional guide was retained in release 0.2.1. None of this releases the
compositor hold or proves general existing-session control.

The [demonstration record](native-desktop-demonstration.md) distinguishes retained
conversation evidence from the unavailable temporary report. Historical results
remain historical; they are not a fresh validation of the current implementation.

## Verification and release

Run `bun run verify` for the selected desktop product contracts. On a prepared
isolated Fedora runtime, `ORBIT_TEST_NATIVE=1 bun run verify` enables its gated
native cases. Run one bounded command at a time. Record source identity, actual
executed cases, failures, skips, platform, cleanup and limitations with each result.

The [roadmap](roadmap.md) lists remaining acceptance work. The incident contract
governs owner handoff independently of installation or ordinary contract tests.
