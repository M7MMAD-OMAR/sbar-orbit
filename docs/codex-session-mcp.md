# Codex session-bound Orbit tools

Status on 28 September 2026: implemented adapter, not connected to the person's
Codex Desktop or enabled by the Orbit launcher.

`src/session-mcp.ts` exposes actions for one already created Orbit session. Its
`ORBIT_SESSION_ID` is fixed when the adapter starts. Tool arguments do not
select a session, and the adapter overwrites an unexpected `sessionId` before
sending a request to the broker. It exposes observe, act, pause, resume, stop,
journal and narrow. It does not expose session creation, profile discovery,
global session listing, desktop settings or viewer controls. Existing session
policy and conversation usage checks still apply.

`tests/session-mcp.test.ts` starts two adapter clients against a disposable
broker fixture. Each client sends an action with the other client's session ID
in its arguments. The broker receives each action and stop request for the
adapter's own fixed ID. The tool list excludes global controls. The focused
test passed with 2 tests and 9 assertions using:

```sh
bun run scripts/limited.ts bun test tests/session-mcp.test.ts
```

`experiments/codex-bound-mcp-routing-probe.py` then started the installed Codex
app-server with an empty temporary home. Two ephemeral threads each configured
the same named `orbit_private` MCP server with a different `ORBIT_SESSION_ID`.
Direct MCP calls for the first, second and first thread reached a disposable
broker with the expected first, second and first session IDs. This proves
thread-specific adapter environment selection for this installed CLI and
direct MCP call path. It did not send a model turn, open a desktop window, or
use the person's account.

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bound-mcp-routing-probe.py
```

`experiments/codex-bound-mcp-model-probe.py` adds a local mock Responses API.
The model fixture returned a namespaced `orbit_act` function call. Codex
advertised the bound tool, delivered the call to the disposable broker for its
fixed session ID, completed the MCP item, and sent that result to the model's
second request. The temporary thread used `danger-full-access` with approvals
disabled. A first attempt with `read-only` rejected the MCP action before it
reached the broker because the tool has no read-only annotation. This is a
Codex approval and sandbox behavior, not an Orbit routing failure. An actual
shared authority must keep shell execution and all host UI tools inside the
private environment before using that mode.

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bound-mcp-model-probe.py
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-bound-mcp-model-probe.py --read-only
```

This is a tool interface boundary, not an operating system boundary. A process
that can reach Orbit's general broker socket as the same user can still call
its general RPC methods. The adapter is not currently attached to a shared
Codex authority. Before that integration, the selected Codex thread must have
all host display and browser tools disabled, the bound adapter enabled only
for its own Orbit session, and its shell executor isolated and verified. A
model-driven turn must then prove that every applicable tool stays in Orbit's
private display and selected file scope while the person's Desktop keeps
working.
