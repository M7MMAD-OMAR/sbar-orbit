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
