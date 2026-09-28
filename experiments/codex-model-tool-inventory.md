# Codex model-visible tool inventory on a shared test authority

Run the disposable probe with one resource budget:

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-model-tool-inventory-probe.py
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-model-tool-inventory-probe.py --feature-flags
```

The probe starts one installed Codex app-server with a temporary home, a local
mock Responses model, and two ephemeral threads. It copies four installed
plugin payloads into a temporary marketplace and uses toy MCP transports for
their host names. A temporary Unix broker receives the private Orbit call.
No personal profile, account, Desktop window or browser is opened.

The mock model records the actual `tools` field of each request. The baseline
thread exposes `mcp__codex_app`, `mcp__cua_repl` and `mcp__node_repl`, each
with the toy `where` tool. The private thread uses `features.plugins=false`,
complete `enabled:false` transport stubs for those names, and the real
`src/session-mcp.ts` adapter. Its model request contains none of the three
host MCP namespaces. It contains `mcp__orbit_private` with `orbit_act`,
`orbit_observe`, `orbit_pause`, `orbit_resume`, `orbit_stop`, `orbit_journal`
and `orbit_narrow`. The mock model selected `orbit_act`; the temporary broker
received the session ID bound in the MCP process environment.

The private request still exposes built-in Codex tools, including
`exec_command`, `write_stdin`, `view_image`, MCP resource discovery, goal tools
and `multi_agent_v1`. This experiment therefore demonstrates removal of the
three named host plugin namespaces from the model-visible inventory. It does
not demonstrate a complete tool allowlist, shell isolation, or a private
executor. The real Desktop's tool configuration can differ from this
disposable authority. The current Desktop still uses its own stdio authority,
so this probe does not attach Orbit to the person's live Codex session.

The second mode creates a third ephemeral thread on the same authority and
selects a separate disposable Codex exec-server as that thread's environment.
Its per-thread feature flags set `view_image`, `goals`, `multi_agent`, `apps`,
`computer_use` and `browser_use` to false. In the actual model request,
`view_image`, goal tools and `multi_agent_v1` are absent. `exec_command` and
`mcp__orbit_private` remain. A model-selected `exec_command` returned the
executor's `EXECUTOR_ONLY` marker, without the authority's marker.

The same request still contains `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`, `request_user_input`,
`write_stdin` and a `skills` namespace. Thus these feature flags do not yield
an Orbit plus remote exec only allowlist. This is an observed tool inventory
and one executor routing result for a disposable thread, not a general
enforcement guarantee for all turns or future CLI versions.

## Source check for the installed Desktop authority version

The Desktop authority reports `0.155.0-alpha.9.2`. Its matching [Codex source
tag](https://github.com/openai/codex/tree/rust-v0.155.0-alpha.9.2) has a
startup [AllowedTools type](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/ext/extension-api/src/allowed_tools.rs).
The [core session](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/core/src/session/session.rs)
captures it from `ExtensionDataInit` when the thread starts. An absent value
keeps ordinary tool setup; an empty list permits no model tools. The
[tool registry](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/core/src/tools/registry.rs)
omits names outside that list when registering trusted and external tools, and
the [tool plan](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/core/src/tools/spec_plan.rs)
also filters hosted tool specs. This is an internal positive tool ceiling.

The [app-server thread start protocol](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
has no `allowedTools` field. Its [request processor](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9.2/codex-rs/app-server/src/request_processors/thread_processor.rs)
creates thread extension data with selected capability roots only. Thus the
unmodified app-server does not expose this ceiling to an Orbit client through
`thread/start`. The same protocol has no `allowedTools` field on
`thread/resume` or `thread/fork`. The resume path does not pass an
`ExtensionDataInit` value to the core thread manager. These are source
findings for the matching tag, not runtime measurements of the installed
app-server.

A smallest opt-in host patch for **new threads only** would add an experimental,
optional `allowedTools` list to `ThreadStartParams` and insert the supplied
names as `AllowedTools` into `thread_extension_init` before `start_thread`.
Omission must preserve current behavior, while an explicit empty list must
deny all model tools. A disposable app-server test should inspect both the
model request inventory and rejection of a model-selected excluded tool.
This proposal does not cover resumed or forked threads, direct app-server RPC
tool calls, or the person's current Desktop authority. No current Orbit thread
has been proved to have this ceiling.
