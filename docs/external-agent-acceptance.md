# Executed external agent application tasks

Historical failed and partial measurements from an earlier revision. The former
browser category refusal, crash hold and cached standing instructions described
below are not current operating rules. Use [the current contract](desktop-only.md)
and [current acceptance index](acceptance.md) for later measurements. These earlier
outcomes remain failures; later success does not rewrite them.

On 22 October 2026, the installed Claude Code, Hermes and Codex CLIs were given
actual model-driven desktop tasks. Each task required the registered Orbit MCP
connector, original installed applications, visible workspace 2, bounded floating
windows and actual application-state evidence. No mock agent or application was
used. Existing model/provider/account settings were preserved.

**Result: complete application operation is not accepted.** Original windows were
observed, but neither agent delivered input or capture, signed-in state was not
verified, and browser operation did not succeed. Passing source CI does not close
these failures.

| Host | Executed outcome | Application operation |
| --- | --- | --- |
| Claude Code | After exact protected approval, opened original Text Editor at 840 by 620 on workspace 2 through `orbit_open` | Exact handoff request refused by compositor crash hold; marker not typed, no capture |
| Hermes | Discovered original Calculator; after schema correction and exact approval, launch returned an uncertain error | Actual receipt-bound window was 720 by 616 instead of requested 720 by 600; handoff refused by crash hold; calculation not entered |
| Codex CLI | Provider rejected configured `gpt-6.1-sol` with its ChatGPT account before any Orbit tool call | Not performed; this is a host configuration failure, not an Orbit execution result |

See the [sanitized machine-readable record](external-agent-results.json). The
checkout was `93aead2`. The existing managed broker was not restarted for this
round; its loaded module revision was not independently pinned. Raw transcripts
and workstation identities remain local and are not published.

## Original process and lifecycle checks

Independent metadata inspection bound Text Editor to its exact acknowledged
PID/address/stable identity, and Calculator to its retained launch receipt and
exact compositor identity. Both used the original `/usr/bin` executable, the
owner UID, normal owner HOME and the owner Wayland display. Both were mapped,
floating and reported `hidden: false`. These are process/window observations,
not screenshots or proof of account state.

Text Editor's opening acknowledgement reported workspace 2. Later independent
metadata showed workspace 1. Owner input was not controlled or logged, so the cause of that move is not
established. Continuous workspace, focus and pointer preservation are not accepted.
Calculator remained on workspace 2 at independent inspection. Its observed
720 by 616 size did not satisfy the requested 720 by 600. The opener retained
uncertain delivery instead of returning successful geometry. The cause of the
size difference remains undiagnosed.

The coordinator closed only the two exact new test windows through ordinary
compositor close requests. Calculator required receipt-ancestry inspection because
the failed opening did not return an acknowledged window identity. No process-wide
kill, existing-window closure or unsaved-content discard was used.

## Actual integration failures

Fresh MCP connections through all three registered host commands exposed 14 current
tools and `orbit_open` fields `requestId`, `workspace`, `applicationId`, `window`.
The actual Hermes gateway instead exposed and enforced an older cached `argv`
schema. Its first call failed because `applicationId` was missing; an argv-free
current request was rejected by the gateway. Explicit schema correction was not
enough to remove the gateway's obsolete required field. This is a real host cache
compatibility failure, despite successful fresh connector negotiation.

After uncertain opening, Hermes retried the same requestId with a changed window
payload and received `REQUEST_CONFLICT`. The agent did not create a fresh requestId
or get another acknowledged opening. A failed request must not be treated as proof
that no application window exists.

The installed Hermes gateway also rejected two options advertised by underlying
CLI help, and rejected a changed turn limit on resume. Those failed invocations
are retained as failures. A minimal resume preserved the original gateway session
policy. No owner configuration was changed to make the run pass.

Claude initially omitted `origins: "any"` from native handoff policy and received
`Native origin enforcement is unavailable`. A subsequent exact request including
that field reached the actual crash hold and was refused. This establishes the
hold as an observed blocker without claiming that default policy ergonomics work.

Claude called original Chrome opening and received Orbit's explicit browser-route
`UNSUPPORTED` error. Hermes declined its browser call because its loaded standing
policy still prohibited browsers, despite the current task clarification. That
is an agent-side policy refusal, not a measured Orbit browser failure. No browser
was launched and no signed-in browser account was inspected.

## Acceptance missing from this historical run

A completed workflow must show an external agent opening the original app through
its actual host connector, executing input, observing application state, preserving
owner work and returning control, with exact cleanup. Account continuity needs
permitted in-application evidence. The [handoff hold](native-handoff-incident.md) applied at the time of these
measurements. See [current acceptance](native-acceptance-0.3.0.md) and the current
[support boundaries](support-tiers.md). This report records failed
and partial real tasks; it does not certify universal or problem-free use.
