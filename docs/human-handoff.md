# Human work and takeover trial

Status: preparation only. The monitor and the runner are in place, and a trial may be running; no human participation is inferred from a run or from desktop activity until the participant confirms it.

## Running it

```sh
ORBIT_SOCKET="$XDG_RUNTIME_DIR/sbar-orbit/broker.sock" bun run scripts/limited.ts bun run experiments/human-handoff.ts
```

With `ORBIT_SOCKET` naming a broker that answers, the trial attaches to it, so it can run beside a
managed installation on this workstation, which is the case the trial is for. That broker is never
closed by the trial. Without it the runner starts a private broker of its own. The run prints the
viewer link and the disposable phrase once, and rewrites `output/human-handoff-<id>/report.json` as
it goes.

Two consequences of attaching, both printed in the report's own `limitations`:

- The browser belongs to the managed broker rather than to this process, so the monitor's owned set
  is every process in the shared `sbarorbit.slice`, which also counts any other agent's sessions
  running at the same time.
- The memory guard reads the slice's live headroom through `budgetHeadroom()` and stops the trial
  before the shared ceiling, rather than comparing against a fixed number that a managed broker has
  already spent. A fixed threshold made the trial abort immediately whenever Orbit was already
  running, which is the one situation it needs to work in.

## User flow

1. Start one bounded Orbit session and let the agent work while you use another application.
2. Open the optional viewer, choose Pause, and wait for Paused.
3. Enter a disposable test phrase in the agent's page and submit it.
4. Resume. Verify that the agent reads the changed result and continues.
5. Close the viewer and verify that work continues. Stop the session at the end.

```mermaid
sequenceDiagram
    participant Human
    participant Viewer
    participant Broker
    participant Agent
    Human->>Viewer: Pause
    Viewer->>Broker: Drain current input and pause
    Broker-->>Viewer: Paused
    Human->>Viewer: Enter test phrase
    Viewer->>Broker: Scoped manual input
    Human->>Viewer: Resume
    Broker-->>Agent: Continue with changed page state
```

## Record and judge

| Check | Required evidence |
|---|---|
| Human kept working | Explicit participant confirmation, not inferred from focus changes |
| No Orbit focus interference | Focus/client observations plus events, matched to owned PIDs; include errors, unknown event ownership and sampling gaps |
| Pause and takeover | Pause acknowledgement, rejected agent input while paused, exact disposable phrase readback and successful work after resume |
| Viewer is optional | Work succeeds after viewer close |
| Cleanup and resources | Owned processes exit; no host fallback; shared cap and memory-event deltas recorded |

The new `experiments/hyprland-focus.ts` monitor is read-only. It uses `hyprctl` queries and the documented [Hyprland event socket](https://wiki.hypr.land/IPC/). It keeps only ownership flags, counts and elapsed times in its returned report. Window titles, classes, addresses, PIDs and keystrokes are not persisted. Raw query/event data exists transiently in memory while being parsed.

Event attribution uses the latest sampled client/PID map. Newly created or very short-lived windows can remain unresolved. An unresolved event, dropped connection or sample error must be reported; absence of a detected owned window alone is not proof of continuous non-interference. This tool is not a keyboard or pointer recorder.

The monitor's parser/privacy tests and a short live connection/cleanup test pass. The experimental `experiments/human-handoff.ts` runner starts the participant trial. A submitted phrase alone does not prove human participation; confirmation and interpretation remain required.
