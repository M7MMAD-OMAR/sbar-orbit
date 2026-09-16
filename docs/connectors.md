# Agent connectors

`orbit_diagnostics` prepares a local metadata-only report and a prefilled GitHub issue link. Failed
operations return a `diagnosticId` matching the report's trace ID. It sends nothing. See
[diagnostic reports](diagnostics.md) for collection scope and privacy.

Orbit exposes twelve MCP tools over stdio, including `orbit_usage` for conversation preference and `orbit_diagnostics` for local reports. `orbit_create` takes `browser` or `system`, and `fedora` is still accepted for the same private display; the alias is vocabulary, not a wider platform claim, and every reply says `fedora`. Seven drive a session: `orbit_create`, `orbit_act`, `orbit_observe`, `orbit_pause`, `orbit_resume`, `orbit_stop` and `orbit_status`. Three are for an agent working without a person to ask: `orbit_journal` reads back every decision the session made, `orbit_narrow` tightens what it may do for the rest of its life, and `orbit_restore` puts a paused session back to a restore point, which it refuses more often than it grants. The adapter connects to the local broker; disconnecting it leaves broker-owned sessions alive.

## Conversation choice and compact observations

`orbit_usage` accepts `mode: "on"`, `"off"` or `"status"`. Explicit user opt-out
blocks subsequent calls in this adapter. With `ORBIT_CONVERSATION_ID` it persists
and is shared with CLI calls carrying the same ID; without it the state lasts
only for this connection. It leaves sessions and schemas intact. See the
[scope contract and portable skill](agent-interface.md).

`orbit_observe` now returns both the native image block and metadata, fixing the
previous loss of page title, tabs/windows and dimensions. Set `mode: "metadata"`
to read presence without screenshot capture. Hosts should consume one copy of
metadata from text or structuredContent and render the image through their image
channel. [Research and Hermes bridge evidence](agent-interface.md#reproduce-the-evidence).

## Setup

Start the broker, set `ORBIT_SOCKET` to its printed path, then run:

```sh
./bin/sbar-orbit connector-config
```

What it prints names the launcher, not an interpreter and a source file:
`{"command": "<the sbar-orbit you ran>", "args": ["mcp"]}`. Run it through an installed link and the
link is what gets written down, so the configuration keeps working after an upgrade switches the
source behind it. Run it out of a checkout and the checkout's own `bin/sbar-orbit` is named instead,
which is the best stable name a checkout has. Windows has no launcher to run, so there the
configuration names Bun and `src/mcp.ts` directly.

On this workstation the server is registered for Claude Code at user scope (`claude mcp add --scope user orbit ...` with the managed socket), and for Hermes in its `mcp_servers`, so every conversation on the machine has the tools. The machine-wide agent instructions in `~/AGENTS.md` and the `sbar-orbit` skill in `~/.claude/skills` say when to use them: any task that needs a screen, a browser or a desktop application goes through an Orbit session and never through the person's own screen. The rule exists because an agent that merely has the tool available still reaches for a host screenshot unless it is told not to; that happened in a Claude conversation before the rule was written.

An agent can do the whole installation itself, including this file, by following
[agent-install.md](agent-install.md). Registering the server stays the person's decision either way,
so the run prints the command rather than editing host settings.

Register the generated server through your host's MCP settings. The command prints configuration without editing personal settings. Preserve existing servers. A broker started by hand uses a fresh socket each time, so regenerate configuration after restarting it. The managed service binds one fixed socket instead, and `connector-config` prefers it when `ORBIT_SOCKET` is unset, so its configuration stays valid across restarts.

Tool approval and selection belong to the host. An API model requires a runtime that executes its tool calls. An app with no custom tool interface cannot automatically use Orbit. See the [MCP architecture](https://modelcontextprotocol.io/specification/2024-11-05/architecture) and [Claude MCP setup](https://code.claude.com/docs/en/mcp).

## Trial with a real agent host

Run against a local agent host that loads MCP servers from its own configuration, with the managed broker on its fixed socket. The host registered every tool on every start, in 774 ms on a cold stdio connection with the seven session tools of that version.

What the host did with them depended on what was asked, and on what else it had:

| Asked | Other browser tools offered | Outcome |
|---|---|---|
| Read a heading from a page | Orbit only | Chose Orbit at once, created a session, navigated, read the heading, stopped the session |
| Read a heading from a page, in a real browser | Orbit and a general purpose browser server | Never reached Orbit. Tried its own built-in browser tool, then searched, then used the other server |
| Read a heading in a session separate from mine | Orbit and a general purpose browser server | Tried its built-in tool first, searched, then chose Orbit and completed the task |

The deciding factor was the wording of the request, not anything Orbit changed: all three runs above used the descriptions as they were. A generic browser request is a generic browser tool's job, and a host preferring one is not a defect. What Orbit controls is being legible when isolation is what the person wants, so the tool descriptions now lead with that rather than with caveats, and every action a tool can perform is named in its description. That is worth doing on its own terms; it did not change how the host ranked a search for the bare word browser, which is dominated by servers whose descriptions are literally that word.

Two things this trial found and fixed. Tool descriptions listed constraints before purpose, so nothing in them said what the tools were for. And an agent could follow a tab a site opened, select one and close one, but could not open one, which the host discovered by trying twice and reporting that Orbit did not support it. `open-tab` closes that gap; a repeat of the trial then opened two tabs, read both headings and switched back.

The trial used a copy of the host configuration in a throwaway home directory, so the live configuration was never modified and no credential was copied. Model-host trials consume the host's own model usage and stay outside `bun test`.

## Validation

The protocol test covers negotiation, independent sessions, actions, image observations, pause/resume and disconnect survival. Opt-in model-host experiments additionally completed browser tasks and native editor saves with Claude Code and Codex. [Validation scope](validation.md).

Model-host experiments use an already authenticated host and may consume service usage. They are not part of `bun test`. Put `codex` on PATH or set `ORBIT_CODEX_BIN` to the intended executable. Do not commit the generated host configuration, authentication state or raw output.

`orbit_create` also accepts optional `conversationName` and `projectName` display labels. Pass the actual host conversation title and project when available. Orbit cannot infer either from an MCP connection, and does not inspect personal host history to fill them in. These labels are shown in the viewer and excluded from diagnostic reports.
