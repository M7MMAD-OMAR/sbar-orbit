# Changelog

Versions follow Semantic Versioning. Alpha releases are experimental and may change interfaces without compatibility guarantees.

## Unreleased

- Added native vertical wheel actions through broker, CLI and MCP. GTK X11 scrolling currently requires an explicit core-input compatibility option; default XInput2 remains unresolved.

- Strengthened native crash checks to inspect all task threads and require zombie reaping.
- Repeated browser/native recovery and real-editor file reservation suites three times on Fedora.
- Human takeover and broader application compatibility remain under validation.

## 0.1.0-alpha.1 - 2026-09-10

Initial public alpha, following private local prototypes.

### Added

- Local broker, CLI and MCP adapter for tool-capable agent hosts.
- Owned headless browser sessions with separate profiles and ordered actions.
- Optional Canvas viewer with pause, scoped manual input, resume and stop.
- Fedora private Wayland/Xwayland display backend and Unicode paste.
- Named account snapshots and cooperative selected-file reservations.
- Shared Linux CPU, memory, swap and task limits; process-tree cleanup.
- Source packaging, privacy checks, test fixtures and concise architecture documentation.
- Experimental read-only Hyprland focus telemetry and human takeover trial.

### Validated

- Scripted 10-minute browser/viewer run at approximately 5 FPS.
- Browser and native lifecycle, clipboard and file-reservation tests.
- Claude Code and Codex model-host browser/native examples in local trials.

### Limitations

- Fedora/Linux alpha; macOS and Windows adapters remain unverified.
- Display separation is not a security sandbox.
- Human trial confirmation, broad account compatibility and clean-machine installation remain open.
