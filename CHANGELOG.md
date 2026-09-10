# Changelog

Versions follow Semantic Versioning. Alpha releases are experimental and may change interfaces without compatibility guarantees.

## Unreleased

- Added named workspaces, current page/application identity, action status and a labelled pointer overlay for following agent work and manual takeover.

- Added browser vertical wheel actions and paused viewer scrolling, with shared validation across both backends.

- Added paused native-session wheel control in the viewer, with scaled coordinates and no gesture backlog.

- Added native vertical wheel actions through broker, CLI and MCP.
- Fixed the first GTK XInput2 scroll delta being consumed as initialization by sending a zero axis baseline; no core-input override is required in the tested fixture.

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
