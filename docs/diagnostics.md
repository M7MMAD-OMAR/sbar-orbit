# Native diagnostics

Use `sbar-orbit doctor`, `sbar-orbit doctor --report` and `sbar-orbit diagnostics`
for the current broker and environment report. Installation and capability
metadata are separate from real application acceptance. A healthy service is not
evidence that input or capture works.

For a failed original opening, retain the request identity and private worker
journal. Do not blindly retry uncertain delivery or close an unrelated window.
Report the exact operation, source, host class and failure reason. Public reports
must omit account names, document text, personal paths, tokens and raw owner logs.

See [the application results](native-opening.md), [platform support](support-tiers.md)
and [the historical compositor incident](native-handoff-incident.md).

`APPLICATION_BUSY` means the selected Wayland client already has a lease or the
legacy plugin reached lease capacity. A new window in the same client does not
create an independent lease. Inspect active sessions and arrange an explicit
handoff; do not infer that a session is abandoned or stop another task automatically.
When the holder is an Orbit session the message names its label, task, state, idle time and
whether its adapter is alive, and `wait` queues for it (see
[multi-agent sessions](agent-interface.md#several-agents-on-one-broker)).
`SESSION_NOT_OWNED` means the session belongs to another agent connection; the message names
that owner. Stop only your own sessions with `scope: "mine"`.
`OWNER_BUSY` instead describes current physical owner input and its bounded wait.
`SESSION_CLOSED` describes ended control, not proof that a window closed. See
[handoff](existing-application-handoff.md) and [current acceptance](acceptance.md).

## Native control does not work: start here

Run `sbar-orbit native-check`. It compares four things and prints one plain sentence
per disagreement with the command that fixes it; it exits 1 unless they all agree.
`sbar-orbit doctor` carries the same result under `machine.native`, and
`nativeDisplaySupported` is true only when they agree.

1. the live compositor (found in `$XDG_RUNTIME_DIR/hypr/*`, not in the service environment),
2. the prepared plan that `~/.local/share/sbar-orbit/native/current` points to,
3. the recorded plugin build (`plugin-build.json`: Hyprland version, commit and ABI), and
4. the plugin the compositor actually has loaded (`hyprctl plugin list`).

| Problem | Meaning | Fix |
| --- | --- | --- |
| `PLAN_STALE` | The compositor restarted since the plan was written. | `sbar-orbit native-refresh`. The broker runs it by itself before a native request when the recorded build still matches. |
| `PLUGIN_NOT_LOADED` | The plan is current but the compositor has no Orbit plugin. | `sbar-orbit native-refresh`. |
| `PLUGIN_ABI_MISMATCH` | The compositor was upgraded (for example 0.56.2 to 0.57.0) and the recorded plugin was built for the old one. It cannot load. | Extract `hyprland-devel` of the running version into `experiments/ghost-cursor/plugin/.deps`, run `build.sh` (it refuses headers of another commit), then `native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON`. |
| `COMPOSITOR_NOT_RESTARTED` | The installed package is newer than the running compositor (`dnf upgrade` without logging out). | Log out and in, then build for the new version. Do not build for the installed version while the old one runs. |
| `PLUGIN_SOURCE_CHANGED` | The plugin source changed since the recorded build. | Rebuild and `native-refresh --plugin-manifest`. |
| `NO_COMPOSITOR`, `AMBIGUOUS_COMPOSITOR` | No Hyprland instance answers, or several do. | Start one session; Orbit never guesses between instances. |
| `ENVIRONMENT_STALE` (note only) | The systemd user service started before the compositor exported `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE` and `XDG_CURRENT_DESKTOP`. Orbit resolves them from the runtime directory, so nothing needs fixing. | Optional: `systemctl --user import-environment WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP` and restart the service. |

Native requests run this check first, so a mismatch is refused at once with the same sentence
(`NATIVE_STALE` or `NATIVE_INCOMPATIBLE`) instead of a bare `Request failed`. The last
`native-refresh` outcome, which autostart runs with no terminal, is kept in
`~/.local/share/sbar-orbit/native/refresh-status.json` and shown by `native-check`.

If a native worker still dies before it can answer, its final exception line is added to the
error, and a bounded excerpt goes to the broker journal (`journalctl --user -u sbar-orbit.service`).
The full traceback stays in the worker journal for as long as the session's private directory exists.

## The MCP tools after a broker restart

The MCP adapter is stateless: each tool call opens its own connection to the broker, so restarting
the broker does not end the adapter or its tool list. A call made while the broker is down waits up to
15 seconds for it to come back (only when nobody was listening, so nothing is ever sent twice), then
fails with `BROKER_UNAVAILABLE`. Sessions live in the broker and are gone after a restart, so
create a new one. A stray error inside the adapter is logged to its stderr instead of ending it.
If a host still shows no Orbit tools, the host dropped the connection; reconnect the server from
the host (`/mcp` in Claude Code). `tests/mcp-broker-restart.test.ts` covers the adapter side.
