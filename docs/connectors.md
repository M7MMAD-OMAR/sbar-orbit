# Agent connectors

Orbit exposes native application discovery and opening on an explicitly selected
numbered workspace. Browser automation, private desktop creation, profile copies
and browser viewers were removed. See [the native contract](desktop-only.md).

Call `orbit_applications` and pass a discovered `applicationId`, `workspace` and
stable `requestId` to `orbit_open`. It opens the original owner application and
leaves it open. It does not release the existing application input hold or prove
account state. No fallback creates a substitute application profile or desktop.

`orbit_handoff_candidates` reads window metadata from the selected workspace.
`orbit_handoff` retains the compositor crash release hold. `orbit_act`, observe,
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
