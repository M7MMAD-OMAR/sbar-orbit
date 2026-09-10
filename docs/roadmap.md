# Roadmap

## Demonstrated in the alpha

- Local broker, CLI and MCP contract.
- Owned browser sessions and optional viewer.
- Fedora native Wayland/Xwayland capture and input.
- Unicode paste, account snapshots and cooperative file reservations.
- Process cleanup and a scripted 10-minute browser/viewer run.

## Next acceptance gates

1. Resolve the participant-reported CPU problem before another interactive trial. Names/pointer visibility were confirmed; takeover and resource acceptance were not.
2. Broaden failure and native application/account coverage. Three repeated recovery runs pass; independent supervisor death remains uncovered.
3. Verify full local installation on a fresh machine, including native dependencies. Launcher activation, upgrade, rollback and link-only uninstall pass filesystem tests without touching retained profiles.
4. Repeat browser and native adapter gates on actual macOS and Windows hosts.
5. Publish capabilities from evidence; unsupported closed tools remain explicit.

Use [acceptance cases](acceptance.md) as release criteria. Alpha versions do not imply these gates are complete.
