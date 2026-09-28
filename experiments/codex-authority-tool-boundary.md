# Codex shared authority tool boundary probes

These probes use the installed Codex CLI at `/usr/lib/chatgpt/resources/codex`,
version `0.155.0-alpha.9.2`. They create temporary homes and ephemeral threads.
They do not use the person's profile, account, model service, Desktop process or
display.

Run one bounded command at a time:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-thread-mcp-isolation-probe.py
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bundled-tool-boundary-probe.py
```

The first probe configures two toy MCP servers in the authority home. Both work
for a baseline thread. A thread started with `config: {mcp_servers: {}}` can
still call the inherited `host_ui` server. Thus an empty per-thread MCP map is
an overlay, not a replacement or an allowlist. A thread with explicit
`enabled: false` for both inherited servers cannot call either one, while its
new `orbit_private` server connects and works. The private MCP child still
runs in the authority process environment. Its own implementation must route
to an Orbit session with a separate, enforced capability.

The second probe copies the installed `codex-app-tools`,
`unified-computer-use`, `browser` and `chrome` plugin payloads into a temporary
marketplace. The installed CLI reserves the name `openai-bundled`, so the copy
uses `orbit-disposable`; it does not install or alter the person's plugins.
It provides disposable toy transports under the same MCP names used by these
bundles. A baseline thread reports `codex_app`, `cua_repl` and `node_repl`
connected. A private thread with `features.plugins=false`, complete disabled
MCP transport stubs for those three names, and an `orbit_private` transport
reports the three host names disabled and Orbit connected. Direct calls to the
host names fail; the Orbit call succeeds.

In this CLI build, `features.plugins=false` together with a partial
`codex_app: {enabled:false}` override caused `thread/start` to fail with
`invalid transport in mcp_servers.codex_app`. The passing probe supplies a
complete `command` and `args` stub alongside `enabled:false`. This matters
when turning off a bundled plugin whose MCP transport was supplied by that
plugin.

These checks prove only named MCP behavior with toy transports. They do not
prove that every actual Desktop UI, browser, connector or future plugin tool is
disabled, nor that model-driven tools cannot reach an authority-owned tool not
named in the override. The installed `browser` and `chrome` bundles reference
`node_repl` in hooks, in addition to `codex_app` and `cua_repl` from the other
bundles. A safe shared authority needs an authoritative per-thread positive
allowlist for host tool execution, or complete detection and denial of every
host MCP source at thread creation and after configuration changes. A protocol
proxy filtering only Orbit's WebSocket cannot prevent an authority-owned MCP
tool from executing inside the shared authority, because the tool call does not
cross that client's socket.

The separate `codex-dynamic-tool-routing-probe.py` observed a different risk:
`item/tool/call` for a resumed thread was sent to both WebSocket clients. A
proxy attached only to Orbit's socket cannot stop Desktop from receiving that
callback. A unicast gateway would need to be the sole client-facing path for
both Desktop and Orbit, or Codex itself would need a thread and turn aware
callback router. Neither path is enabled in the person's Desktop.

## Current Desktop transport migration blocker

A read-only inspection of the installed `app.asar` found a built-in
`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` branch. It requires an empty
`getConfigOverrides()` result, no `CODEX_CLI_PATH`, a compatible running
daemon and other local-host conditions. The same bundle's local
`getConfigOverrides()` always returns a `codex-app-tools` MCP enable override,
even when it sets that flag to false. Thus the daemon branch cannot be selected
by the current normal local Desktop merely by setting the environment flag.
The running person's Desktop has neither that flag nor a daemon socket.
Its observed child command uses `-c features.code_mode_host=true`,
`--analytics-default-enabled`, and a `codex-app-tools` MCP enable override
through the normal stdio transport.

The separate, disabled-by-default Linux feature in the local
`codex-desktop-linux/linux-features/shared-app-server-socket` source
can select a Desktop-owned Unix authority on a future build. Its current
`startAuthority()` launches plain `codex app-server --listen unix://PATH` with
`env: process.env`. The observed normal child has `CODEX_APP_TOOLS_PIPE_PATH`
and `CODEX_MCP_NODE_PATH` in its environment; these keys were absent from the
Desktop parent's initial environment in `/proc`. The parent may set variables
at runtime, so this comparison does not prove which values the feature would
inherit. The feature does not explicitly build the same child arguments and
environment as the normal transport. It therefore cannot yet be claimed to
preserve normal Desktop tool behavior. Its tests cover socket lifecycle and
protocol upgrade, not parity
of the normal child arguments, environment, plugin availability, transcript
state or ongoing turns. The currently installed `app.asar` does not contain
this optional feature's transport class, and the local feature config does
not enable it.

The managed daemon has a further lifetime mismatch: it can outlive Desktop,
while the app tools native pipe belongs to a Desktop instance. Preserving
`codex_app` and code mode behavior would require startup environment and
configuration handoff, compatibility checks, and a way to refresh or retire
the Desktop pipe as instances restart. Removing the override to force the
daemon branch would change normal tools. A source-only tweak that merely sets
the daemon flag is therefore not a safe migration. No original app, daemon,
profile, pipe, or socket was changed during this inspection.
