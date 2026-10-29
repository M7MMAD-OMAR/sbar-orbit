# Multi agent sessions plan

Written 29 October 2026. Status: plan, to be built in one round.

## The problem, as observed this week

Several agents use one Orbit broker at the same time (the owner's own Claude and Codex work, plus the
sessions of this development round). What went wrong, all of it observed:

- One agent's test left a plugin lease behind (`APPLICATION_BUSY` for every later Firefox handoff).
- A session left in `closing` for twenty minutes (an owner task) made every other agent refuse to
  reload the plugin or restart the broker.
- An agent clicking in the panel hit another agent's session because the list reordered under it.
- An agent that tried to stop its own leftover sessions was refused by the permission check, because
  the check cannot tell "my session" from "someone else's workload".
- Test windows from different agents pile up on one numbered workspace and nobody knows whose they are.

## Cause

A session id is a bearer handle and nothing else. Reading the code:

- `session.list` returns every session, with titles, to every caller. Any caller can `act`, `stop`,
  `pause`, `forget` or `close-window` on any id. Nothing records which agent connection created a
  session (`agentName` and `taskName` are free text chosen by the caller).
- A lease is per application client in the plugin and says nothing about who holds it, how long it has
  been idle, or whether the holder is alive, so a busy answer is a dead end.
- A session whose adapter connection disappears is not stopped or paused, so its lease and its window
  binding survive it.
- `orbit_open` takes a workspace from the caller. Two agents choose the same one.

This is a coordination design gap, not a bug in one file. The product contract says same user
cooperative control, not a security sandbox (`docs/desktop-only.md`), so the goal is to stop accidents
between cooperating agents and to make every conflict explainable, not to resist a hostile process.

## Design

### 1. Identity: who is calling

Every broker connection gets a caller identity, taken from facts the broker can check rather than from
what the caller says:

- The Unix socket peer credentials (pid and start time) of the MCP adapter or CLI process, and the
  conversation id from `ORBIT_CONVERSATION_ID` when the host sets it (the MCP adapter generates one per
  adapter process when it does not).
- A caller label: agent name, host name, and a short suffix, shown everywhere (`Claude (a3f9)`).
- The panel and the owner's CLI presenting the owner credential file are the `owner` role.

### 2. Ownership: whose session

- `session.create` records `ownerId` and `ownerLabel` from the connection, not from parameters.
- `act`, `pause`, `resume`, `stop`, `forget`, `narrow`, `close-window`, `close-application`,
  `mouse-*` and handoff need the caller to own the session or to be `owner`. Otherwise the answer is
  `SESSION_NOT_OWNED` naming the owner label and its state. No silent success, no cross talk.
- A window or application client belongs to the session that opened or took it. Closing a window you
  did not open is refused unless the person does it.

### 3. Visibility: what each caller sees

- An agent gets its own sessions in full. Other agents' sessions appear as a short list without ids
  that can be reused: label, application, workspace, state, idle time. That is enough to explain a conflict
  and to choose another workspace.
- The panel (owner role) sees everything, grouped by agent, and stops or pauses any session after
  confirming.

### 4. Lifecycle: no orphans

- When an adapter connection closes, its sessions pause at once, and stop after a grace period
  (default 60 seconds, a setting). Applications stay open; leases are released with the stop.
- A session that stays in `closing` past a deadline is forced closed in the broker, and the plugin lease
  is released through the repair path (`native-leases release`, built in the lease fix).
- `orbit_stop` takes `scope: "mine"` and lists exactly what it stopped, so a permission check and a
  reader can see that only the caller's own sessions were touched. The same for the CLI
  (`session stop --mine`).

### 5. Arbitration: when two agents want the same thing

- `APPLICATION_BUSY` names the holder (label, task, how long idle, alive or not) and offers
  `wait: true` with a timeout and a queue position, instead of a dead end.
- `orbit_open` without a workspace chooses a free numbered workspace for that caller, recorded in the
  session, and never one that another agent's session uses. The owner's visible workspaces are never
  chosen.
- A lease is kept only while its holder is acting or has acted within an idle limit (setting). An idle
  holder is asked to release through its next call, then reclaimed with a note in its journal.

### 6. Seeing who is who

- Each session's ghost cursor carries the agent label and a distinct hue, so a person watching a
  workspace knows which agent is acting. The panel card uses the same label and hue.
- The journal records the caller label per action.

## Order of work

1. Caller identity and ownership in the broker (`src/session.ts`, `src/ipc.ts`, `src/mcp.ts`,
   `src/session-mcp.ts`), with `SESSION_NOT_OWNED`, redacted listing, owner role, tests with two fake
   connections. This is the base; nothing else lands before it.
2. Lifecycle: disconnect pause and stop, forced close of stuck `closing`, `scope: "mine"` for stop.
3. Arbitration: informative busy errors, wait with timeout, per caller workspace allocation.
4. Panel: grouped by agent, owner confirmations, labels and hues. Plugin: labelled cursor.
5. Live proof with three real agent connections at once (two adapters and the CLI), including the
   crash of one adapter in the middle.

## Acceptance

- Two adapters create sessions at once; each sees its own in full and the other only as a summary;
  each can stop its own and is refused, with the owner named, on the other's.
- Killing an adapter pauses its sessions within a second and stops them after the grace period, with
  windows left open and leases released, with no broker restart.
- `APPLICATION_BUSY` always names a live or dead holder; a dead holder is reclaimed without a plugin
  reload.
- No agent needs a workspace number to avoid another agent.
- The person can still stop or pause anything from the panel.
