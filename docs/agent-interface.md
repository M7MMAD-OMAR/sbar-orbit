# Agent interface: usage, observations and context cost

Orbit has two adapters over the same local broker: a shell CLI and a stdio MCP
server. An application needs a tool-capable host to use them. A closed application
with no shell, extension or custom tool interface cannot integrate automatically.
This review improves data delivery and conversation opt-out; it does not certify
all applications or model hosts.

## One conversation can opt out

With MCP:

```json
{"name":"orbit_usage","arguments":{"mode":"off"}}
```

`mode` is `on`, `off` or `status`. Off causes subsequent broker-bound tool calls
to return `isError: true` with `code: "ORBIT_DISABLED"`. The usage tool itself
remains available so the user can check or explicitly re-enable it. Calls already
accepted by the broker and running applications continue. Close owned sessions
first when the user also wants their work stopped. Do not stop the shared service.

With CLI, choose one unique conversation ID and keep it for that task:

```sh
export ORBIT_CONVERSATION_ID=my-task-unique-id
sbar-orbit usage off
sbar-orbit usage status
sbar-orbit session create   # refuses with ORBIT_DISABLED
sbar-orbit usage on         # only after the user asks to re-enable
```

`usage off ID`, `usage on ID` and `usage status ID` are equivalent control
commands. They do not set the environment of later commands. Shell tool calls may
start fresh processes: pass `ORBIT_CONVERSATION_ID` on every invocation when the
host does not preserve the environment. Missing IDs on CLI usage commands fail
with `CONVERSATION_REQUIRED` rather than accidentally disabling all conversations.

The state is a private JSON file named by the SHA-256 digest of the ID under
`$XDG_STATE_HOME/sbar-orbit/usage` (default `~/.local/state/sbar-orbit/usage`).
`ORBIT_USAGE_DIR` overrides that directory for tests or an isolated host.
Invalid or unreadable state fails closed with `USAGE_STATE_INVALID`; an explicit
on/off command repairs it. IDs are scope labels, not secrets or capabilities.

### Scope and enforcement limits

| Setup | Effective scope | Persistence |
|---|---|---|
| MCP without `ORBIT_CONVERSATION_ID` | One adapter process/connection | Resets on reconnect |
| CLI/MCP with the same ID and usage directory | That explicit conversation ID | Survives process restart |
| Host shares one MCP adapter among chats | All chats using that adapter | Host must provide separate processes or scopes |

A CLI command cannot change the private state of an already connected, unscoped
MCP process. Configure the same ID in the environment of a per-conversation MCP
adapter to share state. Never put one fixed ID in global MCP settings for every
chat. For a new host process, for example `ORBIT_CONVERSATION_ID=unique-task hermes`,
ensure its MCP launcher inherits the variable and does not replace it with a
fixed value. Starting another chat inside that process does not create a new ID.

This gate is an adapter preference, not an OS security boundary. Broker RPC,
other adapters without the ID, direct imported code and same-user processes can
bypass it. The skill explicitly forbids such a workaround. The gate covers CLI
broker commands in `src/cli.ts`; service installation, panel and configuration
utilities have separate entry points and are not conversation controls. No local
program can prevent a tool-capable host with arbitrary shell access from changing
its own configuration. Strong host enforcement requires removing tool access.

## Portable skill

[orbit-usage](../skills/orbit-usage/SKILL.md) handles a natural-language request
such as "Do not use Orbit in this conversation" or "Enable Orbit here again".
It gives explicit opt-out priority over automatic selection, explains scope, and
routes observations by purpose. Install the directory using the host's skill
mechanism. For a fresh local installation with no existing skill of that name:

```sh
mkdir -p ~/.codex/skills
cp -R skills/orbit-usage ~/.codex/skills/
# Hermes:
mkdir -p ~/.hermes/skills
cp -R skills/orbit-usage ~/.hermes/skills/
```

Do not overwrite a customized skill without comparing it. In hosts that support
skill slash commands, select `orbit-usage` and give the desired state. This does
not introduce a universal `/orbit` slash command into every host.

### Hermes host controls are different

The installed Hermes CLI at commit `af4be179e8` implements `/tools disable` by
writing its tool configuration and starting a new session. This was verified in
`hermes_cli/cli_commands_mixin.py`, `_handle_tools_command`, on 13 September 2026.
The [Hermes command reference](https://hermes-agent.nousresearch.com/docs/reference/slash-commands)
is useful for syntax, but do not assume a command is temporary merely because it
is typed inside a chat. Orbit's usage gate is the conversation preference; host
controls are how to remove schema overhead when their wider scope is intended.

## Observation contracts

| Need | MCP | CLI | Result |
|---|---|---|---|
| Tab/window labels and pointer | `orbit_observe` with `mode: "metadata"` | `session observe ID --metadata` | Presence JSON, no screenshot call |
| Visual evidence | `orbit_observe` (default `image`) | `session observe ID --output PATH` | Image plus metadata, no base64 text in model context |
| Existing script compatibility | Image MCP block stays first | `session observe ID` | Original base64 JSON CLI contract |
| Specific browser text | `orbit_act` with `read`, narrow selector | `act ID '{"type":"read","selector":"h1"}'` | Text only |

Image metadata includes `mimeType`, `width`, `height`, `capturedAt`, and `presence`
with the title, location, page count, active page index, tab/window labels and
pointer. The adapter preserves all metadata the backend supplies. Image mode
returns the native image block followed by a JSON text block, plus the same
metadata as `structuredContent`, excluding base64. This repairs the previous MCP
adapter's loss of title, tab and dimension data. Small object results from other
tools also expose structuredContent; legacy text remains available. Array results
such as session lists retain their existing text shape.

Metadata mode calls `session.presence`. It has no image dimensions or capture
timestamp, is not a DOM/accessibility snapshot, and is not visual verification.
Use image mode when layout, pixels or native application controls matter. Neither
mode claims atomic consistency if the page or windows change during observation.

CLI `--output` writes the original bytes to a new file with mode 600 and returns
metadata, absolute `path` and byte count. Existing files and symlinks are refused.
It does not recompress, resize or degrade the screenshot. The filename extension
is chosen by the caller; use `mimeType` as the encoding authority. The directory
must already exist. `--metadata` and `--output` are mutually exclusive; invalid
observation options fail before contacting the broker.

A host should render MCP image blocks through its native image/vision channel,
and choose one of JSON text or structuredContent when both encode the same data.
Do not concatenate both into the model prompt. Local file paths work only on the
machine that owns the artifact. Hermes' installed MCP renderer caches image blocks
as `MEDIA:` paths and keeps the metadata text; model vision still depends on the
host and model. Image compression bytes are not a reliable measure of vision tokens.

## Research behind the changes

- [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
  4 November 2025: discover tools when needed, filter results in the execution
  environment, and keep intermediate data out of model context. Orbit applies
  the filtering principle by offering capture-free metadata and file delivery.
  Its reported savings are from its examples, not a benchmark of this project.
- [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools):
  image content is typed separately from text; structured results can be exposed
  along with serialized JSON for compatibility. Orbit follows that contract.
- [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode/): an alternative
  to loading large tool catalogs and intermediate outputs into the prompt. Orbit
  already exposes a local RPC API usable from a host's execution environment;
  this change does not add an unrestricted JavaScript execution tool to the broker.

Practical order: remove unnecessary observations, use narrow text reads or
metadata, deliver images through an image channel, then measure actual host/model
usage. Progressive tool discovery is host-specific. The usage gate prevents calls
but keeps schemas listed, so it alone does not reduce schema tokens. Paged journals,
bounded long reads, native accessibility extraction, image crops with coordinate
mapping, and host-side lazy schema loading remain potential follow-up work, not
implemented claims.

## Reproduce the evidence

```sh
bun run typecheck
bun run verify tests/agent-interface.test.ts tests/mcp.test.ts
bun run scripts/limited.ts bun run experiments/hermes-interface.ts
ORBIT_TEST_NATIVE=1 bun run verify tests/fedora.test.ts
```

The Hermes probe uses the installed source and its venv (override the source with
`ORBIT_HERMES_SOURCE`), a temporary Hermes home, a private broker and an owned
browser. It calls the real Python MCP client and installed Hermes result renderer.
It does not load personal MCP configuration, call a paid model, or modify a live
Hermes conversation. It verifies decoded image bytes, metadata retention, absence
of duplicated structured text, metadata mode and off/on refusal. It reports JSON
byte measurements. General model task success and billed text/vision tokens are
`not measured`.

### Measured on 13 September 2026

The private browser fixture through Hermes at `af4be179e8` produced:

| Measurement | Bytes |
|---|---:|
| Original JPEG, unchanged after Hermes cache | 14,482 |
| Equivalent full image JSON | 19,595 |
| Metadata-only result | 182 |
| Hermes text containing the image path and full metadata | 347 |

The image still travels through the image channel. The smaller text payload does
not imply an equivalent percentage reduction in billed model or vision tokens.
The fixture is intentionally small and is not representative of every app.
The probe discovered 12 tools and verified disable, refusal, re-enable and cleanup.
Its first run exposed a probe compatibility issue: this installed Python MCP SDK
uses `is_error`, not `isError` attributes. The probe now uses Hermes' own alias-aware
field accessor; the second run passed.

The completed run `ORBIT_TEST_NATIVE=1 bun run verify` passed 212 tests across
52 files, with 1,577 assertions and no failures, in 94.51 seconds. This includes
Wayland and X11 applications, Unicode paste, browser/MCP workflows and the new
usage/observation checks. The original adapter failed the 4 initial interface
regressions before implementation; the completed interface tests also cover
corrupt persistent state. `bun run typecheck` and skill validation passed.

Existing MCP processes need a host reconnect/reload to load the updated tools.
Reloading the broker is unnecessary for these adapter changes. An older live
adapter must not be represented as having a runtime opt-out gate.
