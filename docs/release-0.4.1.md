# Orbit 0.4.1

Released 30 October 2026. Linux (Hyprland) is the platform with native control. This release makes Orbit
work on Hyprland 0.57.0. Everything below was measured on one Fedora 44 machine running Hyprland 0.57.0
(commit 0aa6745f705f); anything not measured is said so.

## Hyprland 0.57

- **Plugin ported.** Hyprland 0.57 moved the window, workspace, render and IPC interfaces. The plugin
  now uses the window backend and metadata accessors, the new workspace identity, the render stage event
  with its render context, and the new `hyprctl` command registration. Its commands keep their names.
- **No second crop.** 0.57 applies the XDG client geometry to main-surface texture coordinates itself.
  The 0.56 correction hook was removed, because keeping it cropped GTK4 windows a second time in capture
  and on screen.
- **Source builds for 0.57 only.** The source no longer builds against 0.56.x headers. `build.sh` still
  refuses headers of a different Hyprland commit, and `native-check` names a stale plan or an old plugin
  with the command that fixes it.

## Measured on 0.57.0

- The plugin loaded on the live compositor and `native-check` reported compositor, plan, plugin build
  and loaded plugin in agreement.
- In the original GNOME Text Editor on a numbered workspace: a click, typed text, Return, Ctrl+A, Ctrl+C
  and Ctrl+V worked, the window capture showed the whole window, and the workspace label, agent cursor and
  frame rendered on the presented monitor. The test window was closed and its draft discarded.
- `bun run verify` passed with 244 tests, 4 skipped.

## Not measured

Drag, scroll, the click ring and other applications were not re-measured on 0.57.0. Windows and macOS
still have no native adapter; see the [Windows manual check](windows-manual-check.md).

## Updating

Rebuild the plugin against `hyprland-devel` 0.57.0, then run `sbar-orbit native-refresh
--plugin-manifest ABSOLUTE_PRIVATE_JSON`. Publishing does not activate a running service or plugin.
