# Orbit 0.4.2

Release preparation, 4 November 2026. Publication, downloaded artifact identity and website deployment are separate gates; these notes do not claim they have already completed. Native application control remains Linux/Hyprland only.

## Reliability and observation

- Additive error delivery/retry disposition defaults to unknown/unsafe. Only audited preflight can establish non-delivery. Metadata does not automatically retry input or grant permission after a policy denial.
- Queued actions re-evaluate current policy at broker dispatch. Late advisor answers cannot restore authority removed by narrowing. Request deduplication remains session-scoped; this is not exactly-once behavior across crashes or atomic remote revocation.
- Accessibility observations fail closed on ambiguous titles, count UTF-8 bytes and report bounded filtered traversal completeness honestly. Password-role values are excluded, but images and surrounding application content are not sanitized.
- `ORBIT_A11Y_WARM_HOST=1` explicitly opts into the supervised read-only warm helper. Cold observation stays the default. Bounded framing, deadlines, resource caps, cache clearing/event pumping and parent-death cleanup are source-tested foundations, not provider lifetime or speed guarantees.
- Native observation can return acknowledged window metadata inline instead of a second worker round trip. Legacy responses retain the fallback. This establishes fixture request counts, not a measured end-to-end latency gain or an atomic image/title snapshot.
- Capture failures preserve fixed unavailable/deadline codes and one observation budget. A failed capture does not invalidate acknowledged prior input or authorize replay.
- Opening metadata separates the original request, fitted placement request and sampled actual geometry. Forwarding, minimum-size enforcement, geometry stability and difference causes remain unknown unless independently proved. The launch receipt PID describes a registration/scope helper, not executable identity.

## Measurement and identity boundaries

The strict content-free benchmark evaluator summarizes explicit observed serial task outcomes and rejects incompatible or insufficient comparisons. Synthetic fixtures are not performance evidence. No 80% efficiency result is claimed.

Internal retained-object and provider identity comparison primitives remain unintegrated. GTK release/source provenance and UUID lifetime rules were audited, including actual managed-bus address routing and typed GI fields. A matching token, version string, proxy hash or local GObject reference is not live provider proof. Public refs, semantic actions, skeleton/root traversal and safe external-operation admission remain future work. See [the execution plan](efficiency-plan.md), [host design](accessibility-host-design.md) and [installed provider audit](research/installed-atspi-provenance-2026-11-04.md).

## Evidence and limits

Before these release/site edits, the lead reported source typecheck and default verification with 362 passing tests, 4 skipped and 0 failures. The release candidate, package smoke checks and bilingual site changes require their own final verification. Source fixtures do not certify installed runtime behavior.

In one original Calculator run, independent text observation showed `1+2=3` after a settled capture failed. The input was not replayed. That partial result does not establish screenshot acceptance, explain the capture failure or prove complete application workflows. Unrelated owner windows, workspaces and leases are not release-test fixtures. See [dated acceptance](acceptance.md) for operational evidence.

Windows and macOS still have no native control adapter. Source/registry archives are not a Windows desktop installer, and source CI does not establish installed Windows application or automatic-update acceptance. No cross-platform native parity is claimed.

## Downloads, website and updates

Planned GitHub assets are the versioned source archive, installable registry `.tgz` and a SHA-256 file for each. The website derives the exact tag/download URLs from the root package version, keeps development checkout commands separate and offers both English and Arabic. Deploy only after verifying all linked assets; no Windows executable link is advertised.

Automatic update discovery uses the npm registry, not GitHub release creation. Managed Linux installs require explicit opt-in and wait 72 hours after publication; source checkouts use Git. Activation requires an idle safe boundary and remains separate from preparation. Publishing does not restart an owner broker or activate/rebuild a native plugin. Preserve active sessions and review source/install/plugin/compositor identity before any later runtime switch.
