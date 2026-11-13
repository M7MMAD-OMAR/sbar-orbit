# Orbit 0.4.5

Maintenance release: 13 November 2026.

## Changes

- Native sessions use the compositor's existing activity frame, workspace label
  and cursor. The GTK panel no longer maps a second frame for native activity.
  This avoids redundant layer map/unmap events and their monitor layout recalculation.
- CLI and MCP calls retain their conversation identity and conversation-off scope.
- Existing native window geometry is preserved during handoff, rule refresh and
  handback. Only verified new children receive initial workspace routing.

## Verification and limits

The frame regression checks native activity start, finish and forced refresh, and
cleanup of a previously shown GTK frame. Source review confirms that the compositor
indicator remains independent. These checks do not prove that every reported
window resize or displacement has been resolved. The original reported Zen event
was not reproduced during the earlier geometry observations.

The published verification asset records the exact source commit, hosted build
checks and artifact hashes. Archives are built from committed source, excluding
uncommitted workstation changes. Each source and installable package has a SHA-256
sidecar. Keep the extracted versioned directory when installing its launcher.

Native application acceptance remains Linux with Hyprland. This release adds no
Windows/macOS native control, other-compositor adapter, Windows installer or
measured efficiency gain. The deferred work recorded in [0.4.4](release-0.4.4.md)
remains deferred.
