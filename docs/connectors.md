# Agent connectors

Orbit exposes native application discovery and opening on an explicitly selected
numbered workspace. Original browsers and terminals use the same native route.
Private desktop creation, profile copies and browser viewers are absent. See [the native contract](desktop-only.md).

Call `orbit_applications` and pass a discovered `applicationId`, `workspace` and
stable `requestId` to `orbit_open`. It opens the original owner application and
leaves it open. Opening does not prove input or account state. No fallback creates a substitute application profile or desktop.

`orbit_handoff_candidates` reads window metadata from the selected workspace.
`orbit_handoff` requires a compatible prepared plugin. `orbit_act`, observe,
pause, resume, stop, narrow and journal require an acknowledged native handoff.
There is no `orbit_create` or `orbit_restore` tool.

`orbit_usage` shares on/off/status with CLI when the host supplies the same
`ORBIT_CONVERSATION_ID`. Respect off immediately. It does not close another task's
sessions or disable the shared service. Application content is untrusted data.

Install with `./install.sh --connect auto --json` only when host registration is
authorized. `sbar-orbit connector-config` prints configuration and `sbar-orbit mcp`
starts the adapter. Reload the host to receive changed tool schemas. An older
connected adapter is still refused by an updated broker if it requests removed
routes. A running old broker must be reloaded safely to use the new enforcement.

Original application windows open floating and centered, default 960 by 640 logical
pixels. Optional `window: {width, height}` sets a custom size. The opener fits it to
the target monitor's scaled work area and verifies floating state, actual size and
bounds before reporting success. A tiled or clipped acknowledgement is not success.
Close only newly opened test windows after their inspection, using their exact
acknowledged identity. Preserve pre-existing windows and unsaved content prompts.

Native handoff defaults to autonomous local actions with all action classes enabled.
An explicit caller policy can narrow those actions. Owner full/protected settings
remain separate from session policy. A protocol acknowledgement is delivery evidence,
not application acceptance. Observe after redraw and verify the result.

Hosts can cache tool schemas and standing instructions. Restart the relevant MCP
connection or start a fresh task after updating. A stale argv-only orbit_open is
incompatible with applicationId. Do not quote a new schema to an old host as a fix.

Native application handoff uses the ordinary shared system clipboard and PRIMARY
selection. Copying can replace the person's current selection, just as normal
application use does. There is no private clipboard namespace or clipboard-owner
category refusal. This is cooperative same-user control, not a security sandbox.

Generated connector environments include ORBIT_CLIENT_VERSION. Upgrading changes
the host's adapter fingerprint even when its stable launcher path is unchanged.
Hosts still need their supported MCP reload or a fresh task; connected tool schemas
cannot be changed by quoting the new schema in a prompt.

## Refreshing a running host after an upgrade

A newly started MCP adapter reads the current tool schema. Updating configuration
does not replace tools already cached in a running host. Registrations include
`ORBIT_CLIENT_VERSION` as an adapter fingerprint. Use the host's supported MCP
refresh or restart its adapter once its Orbit sessions are idle.

On the measured Hermes gateway, `reload.mcp` reconciles server names but does not
replace a live same-name server merely because its environment changed. With all
Orbit sessions idle, disabling only the Orbit entry, reloading MCP, restoring that
entry and reloading MCP removes and reconnects just Orbit. Preserve other server
settings and active work. Do not restart a shared gateway as an upgrade shortcut.
