# Codex writable Orbit thread route

Status on 28 September 2026: design only. No writable route to the person's
Codex authority is enabled. The public attached Desktop route has a read-only
gate. This plan concerns a new Orbit-owned thread on the same owner authority,
not writes to any existing personal thread, project entry or application
profile. The first writable tier is a new conversation and bounded private
display actions. A selected project file grant is a later gate within this
plan. It does not authorize a personal cutover. The user's acceptance criterion
is broader: Orbit must eventually do the same work the person can do in the
same account, including existing conversations, files and devices, from its
own display. The new-thread tier is an intermediate measurement, not success
against that criterion.

## Evidence and boundaries

- The session-bound MCP adapter fixes `sessionId` at process creation, outside
  the tool schema, in `src/session-mcp.ts:16-64`. The broker applies session
  policy after parsing an action in `src/session.ts:339-376`. A disposable
  shared authority routed two different thread MCP configs to their fixed
  Orbit session IDs in `experiments/codex-bound-mcp-routing-probe.py:63-113`.
- The matching official Codex protocol has per-thread `config`, `cwd`,
  `sandbox`, `approvalPolicy` and sticky `environments` on `thread/start`, at
  [thread.rs:62-151](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62-L151).
  `environment/add` accepts an environment ID and exec-server URL at
  [environment.rs:37-48](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server-protocol/src/protocol/v2/environment.rs#L37-L48).
  A turn can also select an environment at
  [turn.rs:167-203](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L167-L203).
  A selected remote environment routed one model `exec_command` to a separate
  executor in `docs/codex-local-state.md:13-16`. That selection did not move a
  direct MCP call: it still ran under the authority's home in
  `experiments/codex-mcp-routing-probe.py:131-199`.
- The exact-tag Codex core captures `AllowedTools` at thread creation in
  [session.rs:952-957](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/core/src/session/session.rs#L952-L957)
  and filters trusted and external registrations in
  [registry.rs:291-398](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/core/src/tools/registry.rs#L291-L398).
  `experiments/codex-app-server-allowed-tools-new-thread.patch:1-81` exposes
  that startup ceiling on `thread/start`. A pinned copied Desktop with the
  patched CLI advertised only one allowed toy Orbit MCP tool and completed a
  turn. A later fake-account fixture invoked the real session-bound `orbit_act`
  once on a blank private display, in `docs/codex-attached-client.md:127-142`.
  The patch has no resume or fork ceiling and does not govern direct RPC.
- An empty per-thread MCP config inherited host transports. Complete disabled
  stubs and `features.plugins=false` hid the named toy `codex_app`, `cua_repl`
  and `node_repl` transports, but not every possible host route, in
  `experiments/codex-authority-tool-boundary.md:14-49`. A direct
  `mcpServer/tool/call` names a thread, server and tool in the official
  [mcp.rs:177-187](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L177-L187).
  The official app-server dispatches `thread/start`, `turn/start` and that MCP
  call through separate request paths at
  [message_processor.rs:1265-1278](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server/src/message_processor.rs#L1265-L1278),
  [1610-1618](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server/src/message_processor.rs#L1610-L1618)
  and [1708-1713](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server/src/message_processor.rs#L1708-L1713).
- A resumed thread's dynamic tool callback reached both connected clients in
  `docs/codex-local-state.md:21-22`. Dynamic tools are therefore excluded from
  this route. The private window must not be a callback authority.
- The current private Desktop mount uses `--bind / /` in
  `src/native/mount_unix.py:98-115`; it masks the host home later in
  `src/native/mount_unix.py:116-150`. That is a display mount, not a complete
  filesystem boundary for a command executor. The private network transport
  probes in `docs/codex-private-network-transport.md:5-44` prove selected
  shell execution in a disposable namespace, while leaving host authority
  transport and filesystem isolation unresolved.
- The candidate Desktop's main bundle has a local project migration path:
  `project/list` is followed by `project/import` for missing cached
  `local-projects`, then global migration state is updated. A disposable
  read-only gate audit saw `project/list` requested and denied at startup. It
  did not witness `project/import`. The matching official app-server's
  [projects.rs:69-108](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server/src/request_processors/projects.rs#L69-L108)
  reads projects, while
  [projects.rs:155-176](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/app-server/src/request_processors/projects.rs#L155-L176)
  creates or imports them. The private client cannot receive a generic write
  path to solve its startup migration.

## Required authority split

The owner Desktop keeps its ordinary profile and direct owner connection. The
private Orbit Desktop keeps a read-only projection for account, thread and
sidebar viewing. A separate broker-controlled writer creates one new thread
and starts turns on that thread. The private client never gets the writer's
raw authority socket or a generic JSON-RPC method tunnel.

"Orbit-owned" means a broker-controlled thread ID and write permission. The
shared Codex authority still stores that new thread in its ordinary personal
thread database. This route must not mutate existing owner-owned threads,
project records or global migration state. Physical separation of the two
thread stores is outside this shared-owner design and would need a different
authority or an upstream storage change.

The broker owns a record keyed by Orbit session ID. Its fields are the owner
socket identity and version, candidate manifest pin, one generated Codex
thread ID, fixed executor environment ID, selected project identity if any,
and a policy revision. Only a successful broker `thread/start` response may
populate the thread ID. An agent may name the Orbit session, but cannot supply
or replace the Codex thread ID, config, environment URL or tool list. A
request that names a different or missing thread fails before any owner RPC.
The record must be written atomically to an owned `0700` Orbit state directory
with `0600` records before the first turn. A broker restart loses the live
Orbit session, so the retained record is only a read-only tombstone until a
new session explicitly reattests the owner, thread and policy. On a changed
owner socket identity, the live record becomes read-only until thread
identity and startup ceiling are reverified.
The current patch cannot reapply `AllowedTools` on resume or fork, so those
write paths remain denied.

Every private-window RPC is denied by default. Keep the existing narrow read
projection for `initialize`, safe account status and `thread/list` with
`useStateDbOnly=true`. The current gate rejects `thread/read` because its
rollout fallback may repair the owner's SQLite index, and it rejects
`thread/resume` because that creates or reuses a writer. A later content viewer
needs an owner-side request proven free of both repair and persistence, plus
an attach-only Desktop flow that opens a conversation without resume. Do not
forward `project/list` while the migration
path can lead to `project/import`; any future project list must be an inert
broker-owned projection, with import and global state writes still denied.
The private client cannot call `thread/start`, `turn/start`, `thread/resume`,
`thread/fork`, `project/import`, `config/write`, `command/exec`,
`thread/shellCommand`, `mcpServer/tool/call`, or arbitrary unknown methods.
The broker writer exposes typed `create`, `turn` and `interrupt` operations
only. It supplies security-sensitive RPC fields itself and enforces the
stored thread ID on every turn. For the first tier, accept bounded text input
only; reject attachments, caller-chosen cwd, config, sandbox, permissions,
environments, model, dynamic tools and tool names. If the private UI must send
a turn, the gate translates only this narrow shape to the broker writer and
never forwards the original request.

## Implementation sequence

1. Retain the read-only gate in `src/codex-authority-gate.ts` and
   `src/native-codex-attach.ts` as the only socket available to the private
   Desktop. Make the project migration case a regression test: a fixture
   `project/list` and any `project/import` from the private client cannot
   write owner project or global state. Test unknown and direct tool RPCs as
   denied. Keep owner socket identity checks on reconnect.
2. Add an internal `src/codex-thread-route.ts` owned by the broker, with a
   private durable record under Orbit's user state directory. Integrate it at
   `src/session.ts:119-149` and `src/session.ts:534-567`, not as a generic
   owner RPC method exposed by `src/ipc.ts:17-95`. Its constructor accepts
   only a verified active Codex session and its existing owner socket identity.
   Create at most one writable Codex thread per Orbit session in the first
   tier. Persist the ID and policy revision atomically, and reject a second
   creation, cross-session ID, changed socket, stopped session or stale record.
3. Give each Orbit session a broker-created fixed private exec environment.
   Register only that environment through `environment/add`, then set the same
   ID and broker-validated private cwd on both `thread/start` and `turn/start`.
   Launch `exec-server` with a separate home, private Wayland display, bounded
   resources, private network and an explicit file mount containing only its
   scratch space and selected project grant. Do not reuse the current
   `--bind / /` display mount as an executor boundary. The host authority to
   private executor transport is unresolved: the successful namespace probe
   put both authority and executor in one namespace. A host-owner compatible,
   authenticated relay must be implemented and tested before writable turns
   are enabled. The private Desktop display mount also needs a curated root:
   its current writable `/` bind can expose host paths outside the masked
   home through a file chooser or UI action. If either mount or relay
   attestation fails, no writable thread starts.
4. Extend the exact-version Codex candidate's startup patch so the broker
   can request `allowedTools` containing only
   `mcp__orbit_private.orbit_observe` and
   `mcp__orbit_private.orbit_act` for this first tier. Thread config supplies
   a restricted view of the session-bound `src/session-mcp.ts:16-64`
   transport with the broker socket and fixed Orbit session ID. That view
   rejects `launch`, `launch-app`, selected file grants, arbitrary window
   changes and file operations until the curated mounts are verified. The
   existing `write` policy class includes both pointer and arbitrary launch
   at `src/policy.ts:47-55`, so a class-only policy cannot enforce this
   distinction. Disable inherited plugin transports,
   but rely on the positive startup ceiling and authority-side dispatch
   checks, not a partial `mcp_servers` override. Reject an unpatched CLI or
   an omitted ceiling. Test excluded host tool invocation, not only the
   advertised model inventory. Keep resume, fork and dynamic tools disabled
   until their equivalent ceilings and callback ownership are implemented.
5. Add a typed writer path that sends broker-constructed `thread/start` and
   `turn/start` only for its stored ID. The start request sets a fixed private
   environment, a selected private cwd, `sandbox: read-only`, an approval
   policy that cannot ask the host Desktop to act, no dynamic tools, and the
   exact two-tool ceiling. The turn path rejects any caller override of these
   fields. A direct owner RPC tool call cannot inherit this ceiling, so the
   private gate and an owner-side thread ownership check must deny host MCP,
   shell, browser, native UI and app-tool requests on Orbit-owned IDs. A
   protocol proxy on Orbit's socket alone cannot police an MCP process that
   runs inside the shared authority.
6. After the first tier is measured, add project file work through a
   separate, explicit broker grant. Reuse
   the canonical, owned, no-link path checks of `src/native-codex.ts:27-45`
   and the descriptor identity recheck of
   `src/native/mount_unix.py:39-70`, then confine the executor mount to that
   one project. The public `active` launch still rejects a free-form
   `projectPath`. The broker chooses the private cwd; it does not pass an
   agent-provided host path to Codex. The selected directory must be the only
   writable host bind in both the private Desktop display and executor
   mounts. No project grant means scratch-only execution. Writes through the
   selected project require the Orbit session policy to allow `write` and a
   separate path-scoped action check; the session MCP action still goes
   through `src/session.ts:339-376`.
7. Bind interruption and cleanup to the Orbit session. `session.pause` stops
   new turns and waits for or interrupts the current turn; `session.stop`
   closes the writer, executor relay and private client, and keeps owner
   profile state intact. Owner restart invalidates the live writer. Reopen
   may display the completed Orbit thread read-only, as the disposable owner
   restart fixture did in `docs/codex-attached-client.md:144-153`, but cannot
   start another turn until the resume ceiling and thread mapping checks pass.

## Acceptance tests, in order

1. Run a baseline fixture against the unpatched CLI. Assert that its ignored
   `allowedTools` request exposes a forbidden tool or permits a direct host
   call. The current copied Desktop baseline with `allowedTools: []` advertised
   eight tools, recorded in `experiments/codex-app-server-allowed-tools-candidate.md:40-47`.
2. Unit-test the broker record and private gate with two Orbit sessions and
   two Codex thread IDs. Cross-session, owner-owned, stale and forged IDs,
   unrecognized methods, project import, direct MCP, shell and config writes
   must produce denials with no owner-side request. A malformed response or
   changed socket inode closes the writer. A replayed request ID cannot
   create a second turn.
3. In a disposable exact-version authority, inspect the mock model's complete
   tool inventory. It must contain only the two named Orbit MCP tools. Have
   the mock request `exec_command`, each known host MCP namespace, and an
   excluded built-in tool. Assert zero host executions and explicit rejection
   at dispatch, including a direct `mcpServer/tool/call` attempt. Add a
   newly named toy host MCP to prove the ceiling is positive, not based on a
   fixed deny list.
4. In a disposable owner with two simultaneous private sessions, perform one
   model-selected `orbit_act` against a private fixture. Assert exact session
   IDs, one broker action, no host pointer or window action, no private auth
   file, unchanged owner socket identity, and no migration import. Attempts
   to launch another application, open a host path or change an owner-owned
   thread must fail. Test pause, interruption and cleanup.
5. Close and reopen the private client, then the disposable owner, checking
   the same Orbit thread and completed answer. Before resume support exists,
   a new turn after owner restart must be denied while read access works.
   Test a normal owner exit as well as targeted termination. Only after all
   disposable tests pass should a separately approved personal cutover or
   real-account turn be considered.
6. Before a project write tier, mount one disposable project in the private
   Desktop and executor with no other writable host path. Write one selected
   file and check its bytes. An unselected sibling must remain inaccessible.
   Reject a hidden profile, symlink, changed inode and path outside the
   grant, including paths outside the home that the old `/` bind exposed.

Unknown measurements remain `not measured`. In particular, a selected remote
environment alone does not confine MCP or direct RPC calls, the current
display mount does not isolate an executor's files, and a user-owned Unix
socket does not separate processes running under the same user identity.

## Existing conversation parity

The current candidate's `allowedTools` ceiling is captured only at
`thread/start`. It cannot constrain a new turn in an existing owner thread.
The gate must continue to deny `thread/resume` and `turn/start` from the
private window. Safe existing-thread work needs an owner-side per-turn tool
ceiling, a condition that atomically rejects a turn while the owner thread is
busy, and checks that a turn cannot change the owner's persistent cwd,
sandbox or environment settings. Direct host RPC and MCP dispatch need the
same thread ownership policy. None of these is implemented or measured.
