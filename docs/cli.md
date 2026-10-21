# Desktop CLI

Use the installed `sbar-orbit` launcher or `./bin/sbar-orbit` from a checkout.
Windows provides `bin/sbar-orbit.cmd` for supported installation and metadata
contracts. Native desktop control currently requires Linux and its native runtime.
The public interface is desktop-only; retired browser routes refuse.

## Install and prerequisites

```sh
./install.sh --dry-run --json
./install.sh --connect auto --json
sbar-orbit preflight
```

Windows uses `install.cmd`. The installer reports prerequisites, installation
steps, requested host registrations and broker health. Read its actual result;
installation is not application acceptance. See [agent installation](agent-install.md)
for report fields and [packaging](packaging.md) for source and runtime prerequisites.

## Broker and diagnostics

```sh
sbar-orbit serve
sbar-orbit status
sbar-orbit status --watch
sbar-orbit doctor
sbar-orbit doctor --report
sbar-orbit diagnostics
```

`serve` starts a foreground broker and prints its socket. Point clients at that
socket with `ORBIT_SOCKET`. Without that variable, clients use the platform's
managed socket. `doctor` queries the broker; `doctor --report` describes the local
machine without requiring a running broker. `diagnostics` can also prepare an
offline report. Review a report before sharing it; creation sends nothing.

## Discover and create a private desktop

```sh
sbar-orbit applications
sbar-orbit applications QUERY
sbar-orbit session create system
sbar-orbit session list
```

`session create` defaults to `system`; `fedora` is its legacy alias. Sessions
use a visible desktop by default. Hidden mode requires the explicit
`hiddenSessions` choice in Orbit settings; a tool argument cannot enable it.
If no visible desktop is available, creation refuses instead of falling back.
Discovery reports application registration and process metadata, not input authority.
Use a discovered registration ID to launch a new private Linux application:

```sh
sbar-orbit act SESSION_ID '{"type":"launch-installed","applicationId":"discovered-registration.desktop"}'
sbar-orbit act SESSION_ID '{"type":"list-windows"}'
sbar-orbit act SESSION_ID '{"type":"desktops"}'
```

Replace example identifiers with returned values. The launch resolver uses installed
metadata, not guessed paths. Unsupported activation recipes fail explicitly. A
new private process does not inherit the person's existing session, and private
HOME is not a universal filesystem sandbox. See [application discovery](application-discovery.md).

Desktop selection uses `{"type":"desktop","desktopId":"RETURNED_ID"}`.
Moving a private window uses `{"type":"move-window","windowId":"RETURNED_ID","desktopId":"RETURNED_ID"}`.
Only use session-bound identifiers from the current result. These operations do
not move the person's own windows.

## Action documents and observation

```sh
sbar-orbit act SESSION_ID @/absolute/path/action.json
sbar-orbit act SESSION_ID -
sbar-orbit session observe SESSION_ID --metadata
sbar-orbit session observe SESSION_ID --output /absolute/new-image.jpg
```

`act` accepts inline JSON, a regular JSON file prefixed with `@`, or standard input
with `-`. File/stdin forms avoid shell quoting differences. `ORBIT_REQUEST_ID`
provides an explicit request identity; otherwise the CLI generates one. After an
uncertain mutation result, observe state before deciding whether another action
is appropriate.

Metadata observation does not capture pixels and is not visual verification.
The output-file form preserves original image bytes, creates a new file and prints
metadata. Existing files and symlinks are refused. The parent directory must exist.
`--metadata` and `--output` are mutually exclusive. Without either option, the CLI
returns its image result as JSON including base64. Use the encoding reported by
`mimeType`, not the filename extension, as the authority.

## Session lifecycle and conversation labels

```sh
sbar-orbit session pause SESSION_ID
sbar-orbit session resume SESSION_ID
sbar-orbit session journal SESSION_ID
sbar-orbit session restore SESSION_ID SEQUENCE
sbar-orbit session stop SESSION_ID
```

Restore is backend-dependent and may refuse; the command is not a guarantee that
arbitrary desktop effects can be undone. Stopping a session closes its owned work.
Broker restart closes sessions; they do not persist across it.

Creation accepts `ORBIT_AGENT_NAME`, `ORBIT_TASK_NAME`,
`ORBIT_CONVERSATION_NAME` and `ORBIT_PROJECT_NAME` as display labels. These are
caller-supplied descriptions, not authenticated identities.

## Conversation usage

```sh
sbar-orbit usage status UNIQUE_CONVERSATION_ID
sbar-orbit usage off UNIQUE_CONVERSATION_ID
sbar-orbit usage on UNIQUE_CONVERSATION_ID
```

Alternatively set `ORBIT_CONVERSATION_ID` on every command for that conversation.
Only re-enable when requested. Off blocks subsequent broker-bound calls from the
same scope, but does not stop accepted work or the shared service. Different host
processes must share the same ID and usage directory to share this preference.
See [agent interface](agent-interface.md) for enforcement limits.

## Service, settings and updates

```sh
sbar-orbit service install
sbar-orbit autostart status
sbar-orbit autostart enable
sbar-orbit autostart disable
sbar-orbit config list
sbar-orbit config search WORD
sbar-orbit config get KEY
sbar-orbit config set KEY VALUE
```

Service and desktop settings are platform-specific. On Linux, `service install`
enables autostart by default; `--no-autostart` leaves it disabled. Uninstallation
uses `service uninstall`. Do not restart or remove a shared service to stop one
conversation. `panel` opens the desktop session mark; `settings` shows the native
configuration notice and `config` edits its supported settings.

Managed Linux version-directory installations also support `update status`,
`update check`, `update stage`, `update activate VERSION`, `update on`, `update off`
and `update prune`. Staging prepares a version; activation changes the active
version and restarts the broker, refusing while sessions are open. macOS and
Windows managed activation and scheduling remain unsupported. Publishing a new
package does not activate this machine. `clean` removes abandoned Orbit workspace
and temporary transport storage while preserving live broker-owned directories.

## MCP hosts

```sh
sbar-orbit connector-config
sbar-orbit connector-config --no-launcher
sbar-orbit mcp
```

The connector command prints configuration; `mcp` starts the stdio adapter.
Prefer the stable launcher in host configuration so upgrades do not leave a stale
source path. The installer changes selected host registrations only with explicit
`--connect`. See [connectors](connectors.md).

## Experimental native interfaces and release hold

The CLI retains `native-prepare ABSOLUTE_EMPTY_PRIVATE_DIRECTORY` with optional
`--plugin-manifest ABSOLUTE_PRIVATE_JSON`, `native-plugin status|load|unload|resume
ABSOLUTE_PREPARATION_DIRECTORY`, and `native-settings`. These are owner
configuration interfaces, not instructions to bypass a capability hold.

Configured native paths include `session create native`, `native-candidates
WORKSPACE`, `native-open JSON|@FILE|-`, and `session handoff JSON|@FILE|-`.
Existing-owner handoff remains blocked by the
[compositor incident release hold](native-handoff-incident.md). Preparation or
successful metadata discovery does not remove that hold.

`session native-view SESSION APP WINDOW [--frames COUNT]` is the experimental
native GTK viewer for returned owned application/window handles. It requires
its configured backend and runtime; it does not establish universal desktop
viewing or existing-owner support. See the [current desktop contract](desktop-only.md)
for the exact supported boundary.

## Optional desktop guide preview


[The visual guide](desktop-guide.md#reusable-visual-preview) retains the approved
compact Orbit badge and Codex pointer label. It is owner-started, visual-only,
click-through and time-bounded. It is not a session control capability and does
not start automatically or change the native handoff hold.
