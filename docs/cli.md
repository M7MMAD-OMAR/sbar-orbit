# Local broker and CLI

Implemented prototype: independent browser and Fedora native sessions, ordered actions, retry deduplication, observation, pause/resume and owned-browser shutdown. The repository includes `bin/sbar-orbit`; no system service or global executable is installed.

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

`session observe ID` returns a JPEG as base64 JSON, with the format named in the `mimeType` field. Nothing opens automatically. Use Ctrl+C in the broker terminal to close its browsers and stop the service.

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

## Contract

The Unix socket accepts `POST /rpc` with `{method, params}`. Responses are `{ok:true,result}` or `{ok:false,error:{code,message}}`. The TypeScript client is `call(socket, method, params)` in `src/ipc.ts`.

| Method | Parameters |
|---|---|
| `doctor`, `session.list` | `{}` |
| `session.create` | `{backend:"browser"|"fedora", profileKey?:string, accountName?:string}` |
| `session.account.save` | `{sessionId}`, paused named browser session only |
| `session.act` | `{sessionId, requestId, action}` |
| `session.observe`, `session.pause`, `session.resume`, `session.stop` | `{sessionId}` |

Actions: `navigate` with HTTP/HTTPS `url`, `fill` with `selector` and `text`, `click` or `read` with `selector`, `scroll` with integer viewport `x`, `y` and nonzero integer `deltaY` from -20 to 20, and `select-tab` or `close-tab` with the 1-based `tab` number that observation reports. A tab the site opens by itself, such as a login or consent window, becomes the followed tab, so read observation before assuming which tab an action targets. The last remaining tab cannot be closed; stop the session instead. The Fedora backend supports `launch`, `pointer`, `scroll`, ASCII `text`, Unicode `paste` and a limited `key` set; see [native commands](fedora-results.md). Host input is rejected. Retry an uncertain CLI action with the same `ORBIT_REQUEST_ID`; a reused ID with different arguments is rejected. IDs are cached for the session lifetime, including failed outcomes.

`profileKey` is currently a mutual-exclusion label, not a persistent account profile. Use `accountName` for [saved account state](accounts.md). Every browser receives a fresh temporary profile; no existing directory can be supplied. Profiles are retained after close and the broker's temporary root is identifiable from its socket path. No automatic profile deletion is implemented.

Pause blocks new actions immediately and acknowledges after accepted actions drain. Resume during draining is rejected. Stop closes the browser to cancel in-flight work and invalidates queued work. The service listens only on a Unix socket inside a mode-700 directory; socket mode is 600. Same-user programs can connect, which is intentional for local agents.

## Verification and limits

```sh
bun run typecheck
bun run verify tests
```

Four session integration tests cover separate sessions, profile contention, duplicate clicks, conflicting retries, unsupported input, pause ordering, timeout recovery, cancellation, socket permissions and CLI create/navigate/read/observe/stop.

Google Chrome is required. `doctor` reports broker capabilities, session count and live aggregate Orbit resource limits/counters; it does not preflight Chrome installation. See [resource limits](resources.md) for the counter scope and limitations. Browser startup has a 15-second limit, navigation 10 seconds and locator operations 3 seconds. There is no total queue deadline yet.

Session state and retry records are in memory. A graceful SIGINT/SIGTERM closes owned browsers; abrupt broker kill now passes a browser-tree cleanup and fresh-session test; broader crash scenarios remain open. At most 32 sessions can be created per broker lifetime and 10,000 distinct action IDs per session. Restart after reaching those limits. Synthetic account persistence and bounded resource probes pass. Real-service accounts, sustained resource baselines, 100-action stress runs and model-driven host tasks remain next work. The [live preview](preview.md) now supports observation and paused manual control. The [MCP adapter](connectors.md) now passes its separate protocol integration test.

## Repository launcher

From this checkout, use `./bin/sbar-orbit --help`, `./bin/sbar-orbit serve`, then `ORBIT_SOCKET=... ./bin/sbar-orbit doctor`. `connector-config` prints the same temporary MCP configuration and `mcp` starts the stdio adapter. An absolute path or symlink to the launcher works from other directories; it resolves source paths relative to its real location and preserves the caller's working directory.

The launcher uses the existing shared resource wrapper for `serve`, including graceful signal forwarding when already inside the Orbit slice. A browser-free test passed 8 assertions: a symlink in a directory containing spaces, startup outside the repository, doctor, connector configuration and SIGTERM shutdown with a refused connection afterward. Reproduce with `bun run verify tests/launcher.test.ts`.

This is a checkout launcher, not a standalone release. It requires Bun and the installed project dependencies. Versioned packaging, installation and uninstall remain separate work. No global `orbit` command was created or replaced.

Browser workspace files are created in fresh private directories under `$XDG_CACHE_HOME/sbar-orbit/workspaces`, defaulting to `~/.cache/sbar-orbit/workspaces`. This must be disk-backed storage, not tmpfs. Broker sockets stay in short private `/tmp` directories. Workspace profiles are retained after stop; no automatic deletion is implemented.

## Wheel input

Both adapters accept `{"type":"scroll","x":400,"y":300,"deltaY":3}`. Positive steps scroll down, negative steps up. Browser sessions move their owned pointer to the viewport point and send 100 CSS pixels per step through Playwright wheel input. Native sessions send wheel steps through the private Wayland pointer. Applications can consume or change the resulting movement, so acknowledgement does not prove a specific final offset. Nested scrollable elements are selected by the target point.

The same input is available through `session.control` only while paused and through the viewer's wheel gesture. The browser integration test uses a local fixture's scroll-event readback to verify agent down/up, input validation, paused viewer down/up and no viewer control after resume.
