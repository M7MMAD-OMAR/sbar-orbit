# Orbit 0.4.4

Release freeze: 6 November 2026. This release records the completed Linux work and
closes the current issue campaign at the owner's request. Closing deferred work
is a scope decision, not evidence of implemented platform parity.

## Delivered

- #24: bounded snapshot-scoped refs with expiry, exact window/provider identity,
  qualified GTK and explicitly prepared Qt Widgets targets, and typed stale refusal.
- #28: skeleton and root traversal, measured in the original Thunderbird window
  down to one message row without the node cap.
- #26: bounded pixel-backed correction for named GTK targets, measured in Nautilus.
- #29: explicit Chromium renderer accessibility registration, measured in VS Code.
- #32: proven single-instance forwarding and sampled native minimum sizes,
  measured in Nautilus and Calculator.
- Guarded semantic preparation and one final send. Actual GTK button/text and
  Qt button/checkbox/text effects were independently observed. An explicit
  prepared ref-click fallback recalibrates named GTK geometry and refuses stale
  identity, resize, recrop and changed authority before a single click.
- Desktop navigation is reserved for explicit owner selection. Opening and
  handoff preserve the owner's current desktop selection.

## Closed with remaining work deferred

- #25: semantic dispatch is implemented for qualified targets. GTK checkbox and
  the final Nautilus ref-click acceptance were not completed. Nautilus exports
  scroll-to rather than activation for the tested grid cell; an accepted scroll
  reply did not open it. Later acceptance windows disappeared before input, with
  no established cause and no action replay.
- #30: Windows/macOS metadata prototypes are included. Production handoff,
  capture, opening and input remain unavailable until initial native window
  lifetime and actual-host acceptance are qualified. Windows desktop/installer
  source from the 0.4.3 candidate is included, but no Windows EXE is shipped or
  installed by this release.
- #31: GNOME/KDE and other compositor adapters remain unimplemented. This release's
  native application acceptance is on Linux with Hyprland.
- #34: no compatible baseline/candidate throughput result or 1.8x gain is claimed.
  The staged efficiency program is frozen, not marked measured complete.

The existing Win11 guest was gracefully shut down after severe host memory
pressure. No guest application acceptance was obtained. No macOS or registered
GNOME/KDE desktop was found in the bounded local inventory.

## Evidence and installation

See [current status](completion-status.md), [dated acceptance](acceptance.md),
[snapshot refs](snapshot-refs.md), [semantic and Qt evidence](native-input-reliability.md),
and [remaining roadmap](roadmap.md). Source fixtures do not substitute for native
application acceptance. Optional target-host and prepared Qt wire checks can be
skipped on hosts without their prerequisites; the release verification record
reports the actual counts. Before the version-only release bump, strict TypeScript
and the full default verification passed: 1165 tests passed, 7 skipped, 0 failed,
20808 assertions across 124 files. Packaging and installation checks are recorded
separately in the published release verification asset.

Release artifacts are generated from one immutable main commit: the source
archive and installable package each have a SHA-256 sidecar. The local installation
uses the extracted versioned release, not this mutable checkout. Agent hosts
already running keep their loaded schemas until normal reconnect or reload.
Automatic-update preferences and unrelated application work are preserved.
