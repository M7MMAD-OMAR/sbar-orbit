# Multi agent sessions proof

Recorded 29 October 2026 for steps 1 to 3 of [the plan](multi-agent-sessions-plan.md). Steps 4 and 5
(panel grouping and labelled cursors, three way live run on the real plugin) are not part of this
record.

## What was run

- `tests/multi-agent-sessions.test.ts`: a private broker on its own socket, a fake native backend that
  refuses a held workspace with the plugin's own wording, and two agents that are real processes
  (sleeping children whose pid and start time are the claim). Covers redacted and full listings,
  `SESSION_NOT_OWNED` on every verb, forged and missing claims, the owner credential (mode 0600),
  `scope: "mine"`, SIGKILL then pause then stop after grace, return inside grace, forced close of a
  stuck `closing` session with the repair path called, busy messages, queueing, workspace allocation,
  and the CLI as stranger, as the same conversation and as `--owner`.
- `tests/live-multi-agent.ts`: the same private broker with two real `src/mcp.ts` adapter processes
  driven through the MCP SDK over stdio, plus the real CLI. Run with
  `bun run scripts/limited.ts bun tests/live-multi-agent.ts`. The shared broker, the plugin and every
  owner window were untouched.

## Live output

```
+0.01s private broker on /tmp/orbit-broker-oaV9n5/broker.sock
+0.24s adapter A pid 3741493, adapter B pid 3741507
+0.27s A orbit_open without a workspace -> {"opened":true,"workspace":20,"allocated":true}
+0.29s B orbit_open without a workspace -> {"opened":true,"workspace":21,"allocated":true}
+0.30s A session 88d9f0e0-4bb6-4a74-b4fb-df828d5bebaf owner Claude (9f5c); B session 850bfa31-d0c7-4822-a6da-76844e8bc2be owner Codex (242f)
+0.30s A orbit_status -> 2 entries, ids visible to A: 88d9f0e0; summary of the other: {"redacted":true,"label":"Codex (242f)","taskName":"Beta task","application":"Fake application 22","workspace":22,"state":"running","idleSeconds":0,"ownerState":"connected"}
+0.30s A's listing mentions B's session id: false
+0.30s A orbit_stop on B's session -> error=true {"code":"SESSION_NOT_OWNED","diagnosticId":"e815b61e-1ede-4719-b55f-c028755b6109","message":"This session belongs to Codex (242f) (task \"Beta task\", running, idle 0 s), not to you, so it cannot be stopped from here. Stop only your own sessions with orbit_stop and scope \"mine\"; the person can stop any session from the panel."}
+0.30s A orbit_pause on B's session -> error=true SESSION_NOT_OWNED
+0.31s B orbit_handoff on A's application -> error=true {"code":"APPLICATION_BUSY","diagnosticId":"e9ad1ccb-656a-42b6-b0df-9c4326aadbe0","message":"Application client is already leased by Claude (9f5c) (task \"Alpha task\", running, idle 0 s); its adapter is alive. Ask the holder to stop its session, pick another application window, or retry with wait to queue for it."}
+0.38s CLI as a stranger: session list -> {"ok":true,"result":[{"redacted":true,"label":"Claude (9f5c)","taskName":"Alpha task","application":"Fake application 21","workspace":21,"state":"running","idleSeconds":0,"ownerState":"connected"},{"redacted":true,"label
+0.45s CLI as a stranger: session stop --mine -> {"ok":true,"result":{"scope":"mine","owner":"Hermes (0906)","stopped":[],"failed":[]}}
+0.53s CLI as a stranger: session stop B's id -> {"ok":false,"error":{"code":"SESSION_NOT_OWNED","diagnosticId":"aca6efda-c6af-4593-bfbf-f50b98c7af79","message":"This session belongs to Codex (242f) (task \"Beta task\", running, idle 0 s), not to you, so it cannot be stopped from here. Stop only your own sessions with orbit_stop and scope \"mine\"; the person can stop any session from the panel."}}
+0.55s owner view: ["Claude (9f5c) running connected","Codex (242f) running connected"]
+0.55s SIGKILL adapter B (pid 3741507)
+0.65s B's session is paused, ownerState disconnected, after 103 ms
+3.70s B's session is closed after 3159 ms (grace 3000 ms); applications closed by the broker: 0; lease for workspace 22 held: false
+3.81s A's session after B's crash: running
+3.81s A orbit_handoff on the workspace B's crashed adapter held -> error=false running
+3.81s A orbit_stop scope mine -> {"scope":"mine","owner":"Claude (9f5c)","stopped":[{"sessionId":"88d9f0e0-4bb6-4a74-b4fb-df828d5bebaf","taskName":"Alpha task","application":"Fake application 21","workspace":21},{"sessionId":"fc33409d-0974-4d99-a3be-b2cd8c2bd9be","taskName":"Alpha takes the freed application","application":"Fake application 22","workspace":22}],"failed":[]}
+3.81s result: paused after 103 ms, closed after 3159 ms, fake lease table now []
```

## Acceptance for steps 1 to 3

- Two adapters create sessions at once; each sees its own in full and the other only as a summary;
  each stops its own and is refused, owner named, on the other's: met (test and live).
- Killing an adapter pauses its sessions within a second and stops them after the grace period, windows
  left open, lease released, no broker restart: met. Measured 103 ms to paused and 3159 ms to closed
  with a 3000 ms grace in the live run.
- `APPLICATION_BUSY` names the holder, live or gone: met. A dead holder is reclaimed after its grace
  period, with no plugin reload. A holder that is not an Orbit session (a plugin lease whose worker is
  gone) still gets the plugin's own orphan wording and the `native-leases release` path.
- No agent needs a workspace number to avoid another agent: met for `orbit_open`; an agent that chooses
  a workspace itself is honoured as before.
- The person can stop or pause anything from the panel: the panel presents the owner credential
  (`desktop/panel_broker.py`); tested for the broker side and the credential file, not clicked in a
  live GTK panel in this run.

## Gaps stated plainly

- Identity is a verified claim (pid, start time, same user from `/proc`), not SO_PEERCRED, which Bun
  does not expose. A process that forges another live process's pid and start time is not caught.
- The grace period is read from `ORBIT_SESSION_GRACE_SECONDS` or `orbit.session.graceSeconds` in
  `settings.json`; it is not yet in the panel's settings schema.
- Windows opened with `orbit_open` and not yet handed off are tracked for workspace choice only.
- A session created from the CLI is not tied to an adapter, so it is not reaped on disconnect.
- Forced close was tested with an injected release function. The real `native-leases release` path
  needs a Hyprland session with the plugin and was not exercised here.

Needs a restart after landing: the managed broker (for the new identity checks and lifecycle), the
panel and the mark (to present the owner credential), and every MCP adapter process (for the claim
header and the new `orbit_stop`, `wait` and optional `workspace` schemas). Not done from here because
a live owner task holds a lease on the shared broker.
