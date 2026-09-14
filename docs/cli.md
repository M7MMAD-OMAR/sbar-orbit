# Local broker and CLI

Implemented prototype: independent browser and Fedora native sessions, ordered actions, retry deduplication, observation, pause/resume and owned-browser shutdown. The repository includes `bin/sbar-orbit`; the installer can register the executable and user service.

## Conversation usage

`usage on|off|status [ID]` controls one explicit conversation, without contacting
or stopping the broker. Set `ORBIT_CONVERSATION_ID` to that same unique ID on
later commands. Missing IDs on usage commands are refused. See
[agent interface](agent-interface.md) for MCP scope, reconnect behavior, the
portable skill and host limitations. Client RPC commands default to the managed
socket; `ORBIT_SOCKET` selects a different broker.

## Install

From the project directory, one command:

```sh
./install.sh
```

It checks prerequisites, prepares dependencies, links `sbar-orbit` into `~/.local/bin`, installs and
starts the broker service and the desktop mark, writes `~/.config/sbar-orbit/mcp.json` and then asks
the broker it started for a `doctor` report. Every step is shown as it runs, and anything only a
package manager can supply is printed at the end with its remedy rather than failing quietly.
`./install.sh --dry-run` reports the same steps and changes nothing, and `--no-service` keeps systemd
out of it. See [packaging](packaging.md) for the step table and what the run deliberately does not
claim.

## Run

From the project directory:

```sh
bun install --frozen-lockfile
bun run serve
```

The command prints a unique socket path and stays running. In another terminal, set `ORBIT_SOCKET` to that printed path. Then:

```sh
bun run src/cli.ts doctor
bun run src/cli.ts session create
```

Set `ORBIT_SESSION_ID` to the returned session ID. Examples:

```sh
bun run src/cli.ts act "$ORBIT_SESSION_ID" '{"type":"navigate","url":"https://example.com"}'
bun run src/cli.ts act "$ORBIT_SESSION_ID" '{"type":"read","selector":"h1"}'
bun run src/cli.ts session pause "$ORBIT_SESSION_ID"
bun run src/cli.ts session resume "$ORBIT_SESSION_ID"
bun run src/cli.ts session stop "$ORBIT_SESSION_ID"
```

`session observe ID` retains JPEG base64 JSON for existing scripts. Prefer `session observe ID --output /absolute/new-image.jpg` for an agent: it returns metadata and a file path without base64 text. Use `session observe ID --metadata` for tab/window and pointer information without capturing. The `mimeType` field names the actual image encoding. Nothing opens automatically. Use Ctrl+C in the broker terminal to close its browsers and stop the service.

Watching a session is the viewer's job:

```sh
bun run src/cli.ts preview           # print the link and open nothing
bun run src/cli.ts preview open      # open it in the chosen browser, in a window of its own
bun run src/cli.ts preview browsers  # the browsers this desktop has, and which can do that
```

The link carries an access token in its fragment, so `preview open` hands it straight to the browser rather than through anything that only wanted a window. The browser runs the viewer in a profile of Orbit's own under `~/.local/state/sbar-orbit/viewer/`, never in the person's profile. Which browser, and whether it gets a window of its own, are settings; see [preview](preview.md).

Two commands are for reading a run back rather than driving one:

```sh
bun run src/cli.ts session journal "$ORBIT_SESSION_ID"
bun run src/cli.ts session restore "$ORBIT_SESSION_ID" 12
```

`session journal` returns every decision the session made, the policy it was judged against, the origins
a page reached for and the lease refused, whether a page has spoken to the session yet, which layer held
the origin lease, and the restore points it holds. It identifies actions by class, type, destination
origin and the size of what they carried, and quotes neither typed text nor page content.

`session restore` puts a paused session back to one of those points, named by the sequence the journal
reports, or the most recent one when no sequence is given. It refuses far more often than it grants, and
the refusal is the point: a point is only taken before an action a snapshot could undo, and a restore is
refused outright if anything since has left the machine. Restoring a profile after a message was sent
would put the browser back, leave the message sent, and report success. See
[autonomy](autonomy.md) for what that reduces to in practice.

A capability report needs no broker at all, which is deliberate: the most commonly reported problem is a
broker that will not start.

```sh
sbar-orbit doctor --report > ~/orbit-report.json
```

It prints the platform, the session type, whether a secret service answered, whether a browser can be
confined to a network of its own, one line per browser install with its cookie scheme and row count, the
distribution id and version, and the tier this host class may claim. It collapses the home directory to
`~` and carries no cookie names, hosts or values, no account names and no viewer tokens. Write it outside
the work tree, as above: it is built from a browser profile. See [support tiers](support-tiers.md) for
which report to file.

## Starting with the desktop

```sh
sbar-orbit service install
```

installs the units and turns Orbit on: the broker at login, and the mark with the graphical session.
That is the default because a person who installs something meant to be waiting for their agents should
not have to read documentation to discover it is not running. `sbar-orbit service install --no-autostart`
writes the units and enables nothing, which is what this command used to do.

```sh
sbar-orbit autostart status
```

answers the only question that matters, `startsWithTheDesktop`, and says what it cannot see. It reports
on two paths, because a desktop honours one or the other and Orbit cannot tell which from here: a systemd
user unit wanting `graphical-session.target`, and an XDG autostart entry for the desktops that never
reach it. Both may be enabled at once. The panel claims a socket at startup, so a second copy hands over
its request and exits with status zero rather than drawing a second mark; that is also why the unit can
carry `Restart=on-failure` without retrying the loser of a race forever.

A compositor that starts the panel from its own configuration, a Hyprland `exec-once` line for example,
is invisible to this status. It reports what Orbit installed, not everything on the machine that might
start it. Surviving a full logout rather than only a login needs `loginctl enable-linger $USER`, which
requires elevation and is therefore never done for you.

`sbar-orbit autostart disable` turns both paths off. The launcher entry stays: it is how a person finds
Orbit, not how it starts.

## Settings

Every setting is described in one place, `desktop/orbit_settings.py`, which the panel, the settings
window and the command line all read. A value the command line accepts is therefore the value the panel
keeps, rather than one it silently clamps afterwards.

```sh
sbar-orbit settings              # the window, searchable, on a running panel or a new one
sbar-orbit config list           # every setting, its value and its default
sbar-orbit config search glow    # or search توهج, or boot, or transparent
sbar-orbit config get size
sbar-orbit config set size 14
sbar-orbit config reset          # one setting, or all of them
```

`config` needs no broker and no GTK, so it works over ssh and inside a service. The panel watches its
settings file, so a change from a terminal is on screen before the command returns. Out of range values
are clamped and the clamp is printed; an unusable one is refused rather than stored.

The search answers the description and a list of terms, in English and in Arabic, not only the label:
"boot" finds the startup switch, whose window says neither word, and "توهج" finds the three glow
settings. Labels are English, like all shipped text here; the person searching often is not.

## Keeping a broker available

`sbar-orbit serve` runs in the foreground and binds a fresh socket each time, so every client must be told the new path. A managed broker instead binds one fixed socket at `$XDG_RUNTIME_DIR/sbar-orbit/broker.sock`, and `connector-config` prefers it when `ORBIT_SOCKET` is unset, so generated host configuration survives a restart.

```sh
sbar-orbit service install
systemctl --user daemon-reload
systemctl --user enable --now sbar-orbit.service
```

`service install` writes two files into `~/.config/systemd/user`: `sbarorbit.slice` carrying the shared CPU, memory, swap and task budget, and `sbar-orbit.service` bound to that slice. The budget must live on the slice because the broker looks for `sbarorbit.slice` in its own cgroup path. Enabling, starting and stopping stay with `systemctl`, so nothing changes your session without you running the command. Stop with `systemctl --user stop sbar-orbit.service`, and remove the units with `sbar-orbit service uninstall` followed by `systemctl --user daemon-reload`.

Note that `~/.config` is a Git repository on this workstation, so the written units appear as changes there.

What this does and does not give you. The broker starts at login and restarts on failure; surviving a full logout additionally needs `loginctl enable-linger`, which requires elevation. Only one managed broker can run: a second refuses with `PROFILE_BUSY` rather than displacing the first, while a socket file nothing answers on is treated as stale and replaced. Sessions do not survive a broker restart: `Sessions.close` stops every session on shutdown, so a restarted broker comes back empty. The per-lifetime caps of 32 sessions and 10,000 action IDs were written assuming restarts, so a long-lived broker eventually refuses new work and must be restarted.

## Updating without ending a session

```sh
sbar-orbit update status     # which version is running, which are prepared, whether one is waiting
sbar-orbit update check      # what the registry has, and whether it is eligible yet
sbar-orbit update stage      # prepare it beside the running version, activate nothing
sbar-orbit update activate VERSION
sbar-orbit update on|off     # check daily by itself, or stop doing that
```

A session is state inside the broker process, so pointing the launcher at another version and restarting
ends every open one. Activation therefore refuses while any session is open, and there is no flag to
waive that. Preparing is the opposite and is the half that runs by itself: versions sit side by side in
their own directories with one symlink saying which is current, so a new one is downloaded, verified,
unpacked and given its dependencies without anything being written into the tree the running broker is
executing from.

If the broker does not answer `doctor` after its restart, the link goes back to the version that was
working, the broker is restarted again, and the report says `rolledBack` rather than reporting a success.
The version that failed is kept, because it is the evidence.

Automatic updates are off until `update on`, and absence of the switch means off. `update off` is read
before the feed and before anything else, so it stops a run with no network and no broker, which is the
state a kill switch exists for. A published version is not eligible until it has been public for 72
hours: a compromised publishing account reached about 6,000 machines in under 40 minutes on another
registry, and a signature verifies all of them, because the attacker holds the credentials. A different
release line is reported and never taken by itself.

An install running from a source checkout is refused by name: its updater is git, and an automatic swap
has no business moving somebody's working tree. The desktop mark is a separate process that keeps
running its own version until the person's next login, which `status` reports rather than hides. See
[automatic updates](updates.md).

## Disk that sessions leave behind

Every session gets a fresh profile directory under `~/.cache/sbar-orbit/workspaces`, on disk rather than in RAM, since a browser profile is written constantly. The profile is removed when the session stops, and the broker removes its whole workspace when it closes, so a clean shutdown leaves nothing. A broker that was killed or crashed does leave its workspace behind, and older versions retained every profile: this workstation had accumulated 4.5 GB of them from test runs.

```sh
sbar-orbit clean
```

removes the workspaces no running broker owns. Each workspace records the socket of the broker that made it; a directory whose broker still answers on that socket is kept, a directory from before that record is kept while it was modified within the last hour, and everything else is removed. It needs no socket and reads nothing inside a profile. Saved accounts live elsewhere, under `~/.local/state/sbar-orbit/accounts`, and are never touched.

## Contract

`sbar-orbit diagnostics` prepares a metadata-only support report and a prefilled GitHub issue link,
including offline recovery when the broker cannot answer. Nothing is sent automatically. See
[diagnostic reports](diagnostics.md) for privacy, storage bounds and coverage.

The Unix socket accepts `POST /rpc` with `{method, params}`. Responses are `{ok:true,result}` or `{ok:false,error:{code,message}}`. The TypeScript client is `call(socket, method, params)` in `src/ipc.ts`.

| Method | Parameters |
|---|---|
| `doctor`, `session.list` | `{}` |
| `session.create` | `{backend:"browser"|"fedora"|"system", profileKey?:string, accountName?:string}` |
| `session.account.save` | `{sessionId}`, paused named browser session only |
| `session.act` | `{sessionId, requestId, action}` |
| `session.observe`, `session.pause`, `session.resume`, `session.stop`, `session.journal` | `{sessionId}` |
| `session.narrow` | `{sessionId, origins?:string[], allow?:ActionClass[]}`, tightening only |
| `session.restore` | `{sessionId, sequence?}`, paused browser session only |
| `preview.open` | `{launch?:boolean, browser?:string, appWindow?:boolean}`; without `launch` it returns the link and opens nothing |
| `viewer.browsers` | `{}`, the browsers installed on this desktop and the stored choice |

Actions: `navigate` with HTTP/HTTPS `url`, `fill` with `selector` and `text`, `click` or `read` with `selector`, `scroll` with integer viewport `x`, `y` and nonzero integer `deltaY` from -20 to 20, and `select-tab` or `close-tab` with the 1-based `tab` number that observation reports. A tab the site opens by itself, such as a login or consent window, becomes the followed tab, so read observation before assuming which tab an action targets. The last remaining tab cannot be closed; stop the session instead. The private display backend supports `launch`, `pointer`, `scroll`, ASCII `text`, Unicode `paste` and a limited `key` set; see [native commands](fedora-results.md). Ask for it as `system` or as `fedora`: `system` exists because a caller should not have to name a distribution to ask for a private desktop, and it is an alias rather than a wider claim, since the backend still needs the wlroots runtime this project builds and has run on one host class. Everything reported back, in `session.list`, observation and the journal, says `fedora`, so one thing keeps one name; `doctor` lists the aliases. Host input is rejected. Retry an uncertain CLI action with the same `ORBIT_REQUEST_ID`; a reused ID with different arguments is rejected. IDs are cached for the session lifetime, including failed outcomes.

`profileKey` is currently a mutual-exclusion label, not a persistent account profile. Use `accountName` for [saved account state](accounts.md). Every browser receives a fresh temporary profile; no existing directory can be supplied. The profile is removed when the session stops; see the section on disk below.

Pause blocks new actions immediately and acknowledges after accepted actions drain. Resume during draining is rejected. Stop closes the browser to cancel in-flight work and invalidates queued work. The service listens only on a Unix socket inside a mode-700 directory; socket mode is 600. Same-user programs can connect, which is intentional for local agents.

## Verification and limits

```sh
bun run typecheck
bun run verify tests
```

Four session integration tests cover separate sessions, profile contention, duplicate clicks, conflicting retries, unsupported input, pause ordering, timeout recovery, cancellation, socket permissions and CLI create/navigate/read/observe/stop.

Google Chrome is required. `doctor` reports broker capabilities, session count and live aggregate Orbit resource limits/counters; it does not preflight Chrome installation. See [resource limits](resources.md) for the counter scope and limitations. Browser startup waits up to 15 seconds for Chrome's endpoint and 20 more for its connection; navigation has 15 seconds and locator operations 5. Backends start one at a time, and a creation that has waited 30 seconds behind others is refused with `DEADLINE_EXCEEDED` rather than started for a caller that has given up.

Session state and retry records are in memory. A graceful SIGINT/SIGTERM closes owned browsers; abrupt broker kill now passes a browser-tree cleanup and fresh-session test; broader crash scenarios remain open. At most 32 sessions can be created per broker lifetime and 10,000 distinct action IDs per session. Restart after reaching those limits. Synthetic account persistence and bounded resource probes pass. Real-service accounts, sustained resource baselines, 100-action stress runs and model-driven host tasks remain next work. The [live preview](preview.md) now supports observation and paused manual control. The [MCP adapter](connectors.md) now passes its separate protocol integration test.

## Repository launcher

From this checkout, use `./bin/sbar-orbit --help`, `./bin/sbar-orbit serve`, then `ORBIT_SOCKET=... ./bin/sbar-orbit doctor`. `connector-config` prints the same temporary MCP configuration and `mcp` starts the stdio adapter. An absolute path or symlink to the launcher works from other directories; it resolves source paths relative to its real location and preserves the caller's working directory.

The launcher uses the existing shared resource wrapper for `serve`, including graceful signal forwarding when already inside the Orbit slice. A browser-free test passed 8 assertions: a symlink in a directory containing spaces, startup outside the repository, doctor, connector configuration and SIGTERM shutdown with a refused connection afterward. Reproduce with `bun run verify tests/launcher.test.ts`.

This is a checkout launcher, not a standalone release. It requires Bun and the installed project dependencies. Versioned packaging, installation and uninstall remain separate work. No global `orbit` command was created or replaced.

Browser workspace files are created in fresh private directories under `$XDG_CACHE_HOME/sbar-orbit/workspaces`, defaulting to `~/.cache/sbar-orbit/workspaces`. This must be disk-backed storage, not tmpfs. Broker sockets stay in short private `/tmp` directories. Profiles are removed when their session stops, the workspace when its broker closes, and `sbar-orbit clean` reclaims what a killed broker left.

## Wheel input

Both adapters accept `{"type":"scroll","x":400,"y":300,"deltaY":3}`. Positive steps scroll down, negative steps up. Browser sessions move their owned pointer to the viewport point and send 100 CSS pixels per step through Playwright wheel input. Native sessions send wheel steps through the private Wayland pointer. Applications can consume or change the resulting movement, so acknowledgement does not prove a specific final offset. Nested scrollable elements are selected by the target point.

The same input is available through `session.control` only while paused and through the viewer's wheel gesture. The browser integration test uses a local fixture's scroll-event readback to verify agent down/up, input validation, paused viewer down/up and no viewer control after resume.

## Conversation and project names

Session creation accepts `conversationName` and `projectName` as optional display labels, each 1 to 80 printable characters. The viewer uses them on conversation buttons and its browser title. A missing conversation name falls back to `taskName`; a missing project is shown as not provided.

CLI callers can supply `ORBIT_CONVERSATION_NAME` and `ORBIT_PROJECT_NAME`, alongside `ORBIT_AGENT_NAME` and `ORBIT_TASK_NAME`. These labels identify the work visually and do not attach Orbit to a host conversation. Existing sessions keep the labels they were created with.
