# Changelog

Versions follow Semantic Versioning. Alpha releases are experimental and may change interfaces without compatibility guarantees.

## Unreleased

- Made installation one command. `./install.sh` checks what the machine already has, prepares dependencies from the frozen lockfile with lifecycle scripts off, links `sbar-orbit` into `~/.local/bin`, installs and starts the broker service and the desktop mark, writes the agent connector configuration into Orbit's own directory, then asks the broker it just started for a `doctor` report. It is a driver over the pieces that already existed rather than a second implementation of any of them, and it runs inside the same shared budget as every other entry point. Each step is shown while it runs with its own elapsed time, a failure lands beside its step instead of in a wall of output afterwards, and the wait carries a rotating line naming a capability the project actually demonstrates. It installs nothing that needs root: Bun, Chrome and the Fedora capture tools stay the package manager's job, and each missing one is printed with the remedy the preflight already carries. The closing line says what the run did not check, because a linked command and a started service are installation state, not a measurement. `--dry-run` reports every step and writes nothing.

- Ran the unprivileged half of a fresh installation in a clean Fedora 44 container, at tier `Limited` with the limit printed beside it: no systemd user session, no cgroup delegation, no compositor, so the service, autostart, the private display and the resource budget were never exercised, and gate 3 is not closed by it. Tracked source is enough to install from, the frozen dependency install completes, and both the one command install and the launcher link refuse cleanly where the budget cannot exist. The run found two things a reading of the source would not have, and both are fixed: `preflight` reported systemd tools as available with no user manager behind them, and now looks for the private socket a running user manager keeps rather than only for the binary; and `doctor --report` read a Fedora container as this project's measured host class, and now recognises the markers a container runtime writes itself. The third finding is a gap that stays open, that the private compositor and pointer helper live in an untracked runtime directory a source release does not carry. Reproduce with `experiments/fresh-machine/run.sh`.

- Fixed a native supervisor that is killed rather than asked. A supervisor told to stop reaps its whole tree; one killed outright runs nothing, so its application kept running, became nobody's child and outlived the private runtime directory it had been given, with nothing reporting the loss. The backend now records the process group each supervisor leads, sweeps it when that supervisor exits and again when the session closes, and signals nothing whose own environment does not name this session's runtime directory, because a process identifier can be reused between the death and the sweep. The end to end check was run against the unfixed code first, where the application survived. This closes one failure mode of gate 2 and leaves account and application coverage where they were.

- Wrote the mint extension, and did not load it. `extension/` holds an MV3 extension that runs in the person's own browser, drives nothing, and mints narrow short lived origin scoped state for a separate Orbit browser through a native messaging host. Its decision path lives in modules a test can reach without a browser, which is what the tests cover: origin matching, cookie domain coverage, grant bounds, the envelopes and their refusal codes, and native messaging framing including every partial frame cut. G12 to G14 stay open, because each needs the extension loaded in a real browser and this project's rules keep agents out of the person's own browser.

- Gave the CDP handshake the same twenty seconds the socket before it already had. The two cover the same condition, a Chrome still starting on the shared budget while the host is busy, and they disagreed: the socket waited 20 s and the handshake immediately after it waited 10, so a starved host failed one line further down than the widened deadline was meant to reach. Caught from a captured run where `hyprctl` missed 37 of 84 samples and the 100 ms sample loop stalled for 3.7 seconds. That level of starvation could not be reproduced on demand, so the change is reasoned from the recorded failure rather than from a reproduction.

- Gave the project a mark, and put it where the project is seen: the panel's default shape, the quickshell bar indicator, the viewer header and its favicon, and the project map. It is two rounded squares offset on the diagonal, the screen you keep and the one Orbit opens beside it, with the outline stopping short at both crossings so they never touch. One flat silhouette in one colour, because the viewer's palette is regenerated from the wallpaper and the panel tints the mark by session state; the fixed blue is only for surfaces Orbit owns, and is the value the viewer already carried. Sized against real neighbours rather than guessed: in a bar row beside sixteen pixel glyphs 15 read lighter and 22 overflowed, so the indicator is 18. `brand/` holds the artwork and [brand](docs/brand.md) the rules. These are the first tracked binaries, and the publication audit refused them as it should; rather than bypass it, the audit now records the review it asks for as a path and the SHA-256 of its content, so replacing an approved file with different bytes fails again instead of inheriting the approval. See CONTRIBUTING.

- Removed a session's tmpfs runtime directory when it closes, and a private broker's socket directory when it stops. Nothing had, and on Fedora tmpfs pages stay charged to the cgroup that wrote them, so a day of sessions left 1.5 GB charged to the shared slice with nothing running and the kernel throttling everything under `MemoryHigh`. That throttling, not processor time, was behind a compositor that stopped answering, an input helper that missed its acknowledgement and screenshots that outlasted their deadline. Recorded in [resources](docs/resources.md).

- Removed the GitHub Actions workflow. It could run only the pure unit tests, never the suite that matters, and a partial green check reads as more than it is. Every gate runs locally and is documented in CONTRIBUTING.

- Applications in a private display now look the way they look on the desktop. The person's GTK, Qt and KDE theme settings, icon and cursor choices, colour schemes and fonts are carried into the session's private configuration, and nothing else: no desktop entries, MIME associations, recent files, dialog state or caches. `kdeglobals` is filtered to its appearance groups. Fonts are named by their real path in a fontconfig fragment because a copy or a link would make every session rescan every installed font, which on this workstation held the compositor for 3.9 seconds and stopped sessions starting at all. See [appearance](docs/appearance.md).

- Added a quickshell bar module, `desktop/quickshell/`: a capsule in the person's own bar drawn in the shell's own colours, showing the state by colour, blinking when a session or a window appears, listing the sessions on hover and opening the viewer on click, and taking no width at all when nothing is running. It reads a new helper, `desktop/orbit-stream.py`, which prints one JSON line per change at 18 MB resident and 0.04% of one core, where `sbar-orbit status --watch` answers a related question at 117 MB and 1.3%. The broker client both share is `desktop/orbit_client.py`.
- The panel mark is a capsule, five pixels wide with no number on it, and the card list it opens on hover no longer strands itself open. The pointer is read from the controller property rather than from a pair of crossing signals, with a delay each way and a watchdog behind them. Removed the tooltip: it asked GTK to export a toplevel, which a layer surface is not, and the protocol error killed the panel the moment the pointer rested on it. The surface is pinned to one end of its edge, so the capsule no longer slides out from under the pointer as the cards open. Settings gained the offline colour, the distance from the edge, hiding the mark while nothing runs, a reset, Escape, scrolling and screen-reader names, and they are written once the hand stops moving and renamed into place rather than truncated. Cut the panel's own cost: one worker for its life instead of a thread a second, one kept connection instead of two a second, and presence only when something is going to read it.
- Found what actually freezes this desktop, and it is not Orbit: of 868 recorded stalls only 18 were real freezes, all of them in early September, all of them with swap completely full and two agent processes holding 20 GB between them. Recorded the rest in [resources](docs/resources.md), including the shell idiom that burns a whole core while pretending to sleep.
- Redesigned the panel around a small dot that says the state by colour, no number by default, blinking once when a session or an application appears and expanding on hover into a card per session. Added a settings window a right click opens: the edge and monitor, the shape (dot or dot with a count), the size, a colour for each state, the working frame and its colour, notifications and the blink, each saved and applied at once. Measured the panel's cost at 0.1% of one core and the broker's polling at 0.5%, and documented the real causes of the processor stalls (a leftover heavy session in the throttled slice, host-load starvation, a runaway from another agent), none of them the panel. Settings persist in `~/.config/sbar-orbit/panel.json`; the mark lands on the largest monitor unless one is named.
- Added the working indicator, `sbar-orbit panel --indicator`: four click-through overlay strips framing the monitor while any session's action is in flight, mapped once per state change and painted above the person's own `gtk.css`. Verified inside a private display with edge pixels sampled during and after a slow launch. The panel now takes the person's GTK colour names when their theme defines them.
- Profiles are removed when a session stops and a broker's workspace when it closes; `sbar-orbit clean` removes workspaces whose broker is gone, keeping a live broker's directory when its recorded socket still answers. Before this every test and experiment profile was retained forever, 4.5 GB on this workstation.
- Added `sbar-orbit status`, a read-only view of every session with tabs, windows, activity and pointer, a `--watch` mode that prints only on change, and `session.presence`, which is `observe` without the frame. Added `sbar-orbit panel`, a wlr-layer-shell edge strip that shows session and tab counts, expands on hover into one row per session and opens the viewer on click; it runs outside the shared budget as the person's own desktop process, uses the Cairo renderer, polls off its main thread and opens only a loopback viewer link. Captured inside a private display by `experiments/panel-check.ts`.

- Started backends one at a time, with a 30 second queue deadline, and widened the browser action timeout to 5 seconds, navigation to 15 and the Chrome connection wait to 20. `experiments/concurrent-sessions.ts` drives several sessions from independent loops on one broker: three Chromes and two compositors booting together on one core had timed each other out, and a locator that resolves in 200 ms alone took over three seconds with four other sessions working, which was being reported as a missing element. With the fixes, three browser sessions and two private displays complete 20 of 20 rounds in 9.8 seconds at 93 percent of one core.

- Kept each private display's compositor output in `compositor.log` beside the session, bounded, because it is the only evidence when a display fails to start.

- Raised the native launch deadline to thirty seconds for Electron applications on a software-rendered display. Docker Desktop still does not open there: its launcher requires the session bus, which a private display deliberately lacks, and the Electron binary underneath did not map a window in that time.

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
