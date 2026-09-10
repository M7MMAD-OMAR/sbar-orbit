# Changelog

Versions follow Semantic Versioning. Alpha releases are experimental and may change interfaces without compatibility guarantees.

## Unreleased

- Closed the secret-scanning gap. Gitleaks now runs, the whole history scanned clean across 28 commits, and the pre-commit gate was verified by staging a fabricated key and watching it refuse. Recorded what the publication audit and Gitleaks each catch, since neither sees what the other does. Also brought `scripts` under `tsconfig.json`, which needed no code changes, and added the theme and surface unit tests to continuous integration.

- Added `open-tab`, so an agent can open a tab itself instead of only following one a site opened. A trial with a local agent host found the gap: the host tried to open a second tab, could not, and reported that Orbit did not support it.

- Rewrote the MCP tool descriptions to lead with what each tool is for and to name every action it can perform, rather than opening with constraints, and described the session labelling fields so an agent names itself in the viewer. What decided whether a host reached for Orbit at all was the wording of the request, not the descriptions; the trial is recorded in [connectors](docs/connectors.md).

- Made the session surface a session property instead of a fixed 1280 by 800. A session can be created at a size and resized while it runs, on both backends: browser sessions resize every open tab so a tab switch does not change what a coordinate means, and native sessions resize the private display itself. Native sessions also gained `window` with fullscreen, restore, focus and close, which gives one application the whole display at no per-frame cost. Coordinate bounds, which were hardcoded in three places, now follow the session's actual surface. The cap is 1,920 by 1,200 total pixels, taken from `experiments/surface-cost.ts`: capture latency is nearly flat across that range, but continuous capture on a private display already reaches a whole core at the cap.

- Gave the viewer a tab strip and a size control. The strip lists browser tabs, or the windows of a private display, numbered the way observation reports them, and selecting one follows that tab or focuses that window. Both, like typing, require pause first. Observation now reports a `tabs` list and the real surface size on both backends.

- Let the viewer take the desktop's colour scheme. It paints from Material 3 colour role tokens with the shipped palette as fallback, and the broker serves a generated `/theme.css` read from `ORBIT_THEME`, an Orbit theme file, or a matugen or quickshell palette. Values are checked against a fixed key list before they reach CSS, because the viewer origin holds a session access token. With no theme file present nothing changes. See [theming](docs/theming.md).

- Gave native sessions private XDG base directories, so an application cannot restore the person's own previous session or recent documents into the agent's workspace. A trial had shown GNOME Text Editor doing exactly that. Added `experiments/multi-application.ts`, which opens four real applications at once, edits a real file through one of them and reads the result back from disk.

- Added an optional managed broker: `sbar-orbit service install` writes a `systemd --user` service bound to a slice that carries the shared budget, and `serve --managed-socket` binds one fixed socket at `$XDG_RUNTIME_DIR/sbar-orbit/broker.sock`. A second managed broker refuses rather than displacing the first; a socket nothing answers on is treated as stale. Generated MCP configuration now prefers that socket, so it survives a restart. Enabling, starting and stopping stay with `systemctl`. Sessions still do not survive a restart. Brokers started by tests and experiments keep their own private sockets and are unaffected.

- Corrected the capability list `doctor` reports, which still omitted scroll and the tab actions.

- Added `experiments/live-trial.ts` and `experiments/pointer-separation.ts`, recording measured session cost and evidence that a session holds no connection to the host display. Corrected the MCP observe description, the preview limits and the project milestones, which still described one page per session, PNG capture and an unmoved resource gate.

- Followed browser tabs that a site opens by itself, so a login, consent or payment window is now reachable instead of leaving the agent bound to the opening tab for the life of the session. Added `select-tab` and `close-tab` actions keyed to the 1-based number observation reports, sized adopted tabs to the session viewport so reported and captured dimensions agree, moved the pointer overlay to whichever tab is followed, and fell back to a surviving tab when the followed one closes. Each action and each frame now resolves the followed tab once, so a tab opened mid-action cannot redirect it.

- Captured frames as JPEG quality 80 instead of PNG on both backends. Measured on one Fedora host: browser capture fell from 68 ms and 188 KiB per frame to 47 ms and 70 KiB, and native capture fell from 77.8 ms to 8.1 ms because PNG deflate, not the per-frame `grim` process or the sway tree query, was the whole cost. Frames now declare their format in `mimeType`, which the MCP adapter accepts for both formats.

- Stopped the viewer scheduling its next poll with no delay when an iteration outlasted its cadence. A slow desktop previously polled back to back at a full duty cycle, including in the default 1 FPS mode. The viewer now idles at least as long as the iteration cost, degrading its frame rate instead, and reports its own measured per-frame cost and busy share.

- Enforced source-manifest content hashes during extracted-release repackaging, rejecting invalid paths, linked inputs and version mismatches before archive creation. Added a standalone content verifier.

- Added standalone `sbar-orbit preflight` to report browser/native prerequisite availability without launching applications or requiring a broker socket.

- Added local source launcher activation, atomic upgrade/rollback and link-only uninstall. Retained source and account/workspace data are preserved; dependencies remain a separate preparation step.

- Stopped hidden preview tabs from decoding or drawing late-arriving frames, and skipped their freshness updates. Already-started capture/decoding can finish; bitmaps are still released.

- Added bounded read-only CPU observation, separating Orbit one-core and machine percentages from host busy/iowait totals. This does not establish the cause of the participant CPU spike.

- Fixed publication-path validation so example environment files cannot bypass private-directory exclusions; index auditing and packaging now share one policy.

- Defaulted preview to 1 FPS, added on-demand and opt-in Smooth modes, stopped hidden-tab polling and added reconnect backoff. Scheduling tests pass; desktop CPU acceptance remains unresolved.

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
