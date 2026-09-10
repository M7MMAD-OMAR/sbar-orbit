# Agent connectors

Orbit exposes seven MCP tools over stdio: `orbit_create`, `orbit_act`, `orbit_observe`, `orbit_pause`, `orbit_resume`, `orbit_stop` and `orbit_status`. The adapter connects to the local broker; disconnecting it leaves broker-owned sessions alive.

## Setup

Start the broker, set `ORBIT_SOCKET` to its printed path, then run:

```sh
./bin/sbar-orbit connector-config
```

Register the generated server through your host's MCP settings. The command prints configuration without editing personal settings. Preserve existing servers and regenerate configuration after restarting the broker because its socket changes.

Tool approval and selection belong to the host. An API model requires a runtime that executes its tool calls. An app with no custom tool interface cannot automatically use Orbit. See the [MCP architecture](https://modelcontextprotocol.io/specification/2024-11-05/architecture) and [Claude MCP setup](https://code.claude.com/docs/en/mcp).

## Validation

The protocol test covers negotiation, independent sessions, actions, image observations, pause/resume and disconnect survival. Opt-in model-host experiments additionally completed browser tasks and native editor saves with Claude Code and Codex. [Validation scope](validation.md).

Model-host experiments use an already authenticated host and may consume service usage. They are not part of `bun test`. Put `codex` on PATH or set `ORBIT_CODEX_BIN` to the intended executable. Do not commit the generated host configuration, authentication state or raw output.
