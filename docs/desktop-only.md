# Desktop-only Orbit

The current development public API admits only `system` (`fedora` alias) and
configured `native` sessions. Standalone browser sessions are retired, including
browser profile copying, saved browser accounts and DOM actions. This is enforced
by `DesktopSessions` at the broker, not merely by agent instructions. Previously
connected adapters therefore cannot recreate a browser session against this broker.
`bun run verify` now selects the desktop product suite. Historical low-level
browser code and tests remain during migration; they are not
a supported public route and their measurements do not prove native behavior.

Browser-based viewers are also retired: `preview.open`, `viewer.browsers` and
all CLI `preview` variants refuse. The panel expands its native session list;
the shell click starts that panel without asking for a URL. There is no desktop
URI-launcher fallback. New panel requests use native-only message names, so an
older panel cannot interpret them as browser-launch commands. An older panel may
ignore these requests until it is refreshed. The former browser settings editor is unavailable; settings
remain editable through `sbar-orbit config`. A native settings editor and full
native session viewer still require implementation and private-display acceptance.

## Acceptance contract

- Discover currently installed/running applications through OS metadata.
- Operate acknowledged application/window identities, preserving existing owner
  state only where the adapter has measured support.
- Use multiple desktops and move only a selected window, without changing the
  person's active desktop or input focus.
- Separate OS adapters from the common action contract. Report unavailable and
  not measured capabilities explicitly, without a standalone browser fallback.

## Current evidence

The earlier [native accessibility demonstration](native-desktop-demonstration.md)
successfully exercised GNOME Calculator through AT-SPI according to the retained
conversation. That experimental mutation route is distinct from compositor plugin
handoff and remains outside the public session adapter. The public private-desktop
adapter now supports read-only inspection as described below.

| Requirement | State |
| --- | --- |
| Public browser admission refusal, CLI desktop default, desktop MCP schema | Covered by `tests/desktop-only.test.ts`; see current task run for actual execution |
| Existing owner application control | Blocked by the compositor crash [release hold](native-handoff-incident.md) |
| Private desktop workspace actions | Numbered private workspaces and exact window moves implemented; private runtime acceptance is recorded by this task |
| Windows and macOS desktop adapters | Not implemented; runtime not measured |
| Legacy browser suite migration | Pending; historical browser RPC tests are incompatible with the new public contract |

Opening a normal application through the desktop is distinct from a standalone
browser automation backend. No DOM, tab or profile-copy API is exposed. An agent
must report a failed desktop action rather than silently substitute another path.

Generic private desktop launches receive a session-owned `HOME` as well as private
XDG directories. Applications that keep profiles directly below `HOME`, including
Zen's `.zen`, therefore start with fresh private state instead of locking the
person's default profile. This does not copy accounts or authorize supplying an
owner profile path through command arguments. It is default-state separation,
not a filesystem sandbox. The directory is removed when the session closes.

For a new private application, discover `registrationIds` using `applications.list`
and submit `launch-installed` with one exact `applicationId`. The Linux adapter
resolves the current desktop registration, its arguments and working directory
before applying the private runtime HOME. Installation paths are not supplied by
the caller. A simple supported HOME-relative wrapper binds its installation path
without restoring the owner's runtime HOME. Invocation aliases are preserved.
Known profile-selection arguments are refused. This is not a general filesystem
sandbox and does not prove every application ignores owner state.

Unsupported activation recipes, complex scripts, ambiguous identities and missing
executables return errors. They do not trigger a guessed binary or another
application. The operation defaults to the private Wayland display, with an explicit
`toolkit: "x11"` compatibility option. Its result reports `applicationState: "new"`
and `runtimeHome: "private"`; it does not acquire an already-open owner window.
The [adaptive architecture](native-adaptive-architecture.md) separates this launch
path from existing-window acquisition and semantic control.

## Runtime activation

Source verification is not installed-service activation. The installed broker must
be running this source before the admission guarantee applies to it. Restarting a
host is needed to refresh MCP schemas, while broker enforcement also applies to
older adapters once the desktop-only broker is activated. Record that separately
from source tests. Do not describe an old running service as migrated.

## Read-only native inspection

On a private Linux session that advertises `inspect`, request `list-windows`, then
use an exact returned window identity with `orbit_act`:

```json
{"sessionId":"SESSION_ID","requestId":"UNIQUE_REQUEST_ID","action":{"type":"inspect","windowId":"RETURNED_WINDOW_ID"}}
```

The snapshot contains bounded node names, roles, states and parent relationships.
Element identifiers belong to that snapshot; they are not action handles. The
response reports `mutations: "unsupported"` and empty per-node action lists.
Document text is not returned. Inspection revalidates the private window, process
and supervisor scope and uses the session's private accessibility bus. A missing
service, ambiguous match or foreign window produces an explicit error.

Limited runtime evidence covers a private GTK3 fixture's button name/role readback,
foreign window refusal, replacement of inherited AT_SPI routing and helper process
cleanup. The final local native-enabled suite reported 127 passed, 4 skipped,
0 failed and 543 assertions. Independent static review passed within the private
inspection scope. This does not
establish arbitrary application coverage, native semantic mutations, owner-session
access or Windows/macOS native support.
