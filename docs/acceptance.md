# User stories and acceptance

Targets below are proposed release gates, not measured results. Current evidence lives in [experiment.md](experiment.md).

| ID | User story and test | Expected result |
|---|---|---|
| U1 / T1 | I keep working while the agent fills a page and clicks a control | Correct page result; no Orbit window becomes active; no host input API used |
| U2 / T2 | Two agents work at once in separate sessions | Different form values and storage remain separate over 100 actions each |
| U3 / T3 | I open the viewer only when wanted | No automatic viewer opening; visible frame age below 1 second at 5 FPS; closing viewer leaves work running |
| U4 / T4 | I pause and take control | No new agent action after pause acknowledgement; resume works; conflicting human and agent input is serialized |
| U5 / T5 | I stop one session | Its owned processes close within 5 seconds; other sessions and personal apps remain usable |
| U6 / T6 | I use an account I connect | Login survives an Orbit-profile restart; another session cannot take its lease; personal profile is untouched |
| U7 / T7 | Any supported agent can use the same workspace | Identical navigation, input, observation and stop contract through CLI, MCP and API harness; two actual host integrations pass |
| U8 / T8 | I ask for an unsupported desktop action | Explicit `UNSUPPORTED`; zero fallback input or focus change on the host |
| U9 / T9 | I work on Fedora native apps | A Wayland app and an X11 app accept text and clicks on the private display; capture matches their state |
| U10 / T10 | Orbit fails or restarts | No host fallback, stale session rejected, owned children reaped, fresh session works. The process half is measured by `tests/browser-crash.test.ts`. The FILESYSTEM half was false until 19 September 2026 and is named here rather than quietly fixed: a SIGKILLed broker left its egress socket directory on tmpfs with nothing to sweep it, measured at 33 abandoned directories on the developer's own machine, and tmpfs pages are charged to the cgroup that wrote them. `cleanEgress` now runs from `clean` and from a managed broker's startup. The kill itself still reclaims nothing, because nothing runs between SIGKILL and the successor; what closes it is that `Restart=on-failure` with `RestartSec=2` guarantees a successor within seconds |
| U11 / T11 | Orbit uses my files | Only the selected fixture is modified as intended; simultaneous edits follow lease/worktree policy |
| U12 / T12 | I use another OS | Repeat T1-T11 on actual macOS/Windows hosts; unsupported operations remain visible in the matrix |

Current T2 evidence: [100 submissions per browser through broker RPC](experiment.md#two-broker-sessions-100-submissions-each), with independent storage and a post-stop submission. The sustained simultaneous human-work gate remains open.

The corrected [validation summary](validation.md) completed 2077 submissions at 5.006 FPS with at most 284 ms sampled displayed age. This supports the scripted duration and viewer portions of T3. It does not close the simultaneous human-work or takeover gates.

## How to measure no interference

Subscribe to Hyprland window/focus events and sample active window and client PIDs during the experiment. Attribute events to Orbit's process tree. Record polling gaps, because sampling alone cannot exclude transient focus changes. Never capture private window titles or the user's keystrokes.

Cursor motion by the human is allowed. Do not require a stationary pointer as evidence. Code inspection verifies the absence of host input calls; a later adversarial test exercises denied tool paths. Combine telemetry with a 10-minute simultaneous-work acceptance session before claiming the full experience works.

## Performance and failure gates

Compare five matched runs with direct Playwright: same browser, fixture and concurrency. Report startup median/p95, peak process-tree RSS, CPU seconds and frame latency. Provisional target: broker overhead under 100 MiB idle and under 20% extra action latency. Include browser/display costs separately; no claim of zero overhead.

Exercise timeout, invalid session, duplicate action ID, busy profile, backend crash, unavailable capture, preview disconnection and shutdown during input. An unknown measurement is `not measured`, never a pass.

## Worked scenario

1. User remains in their editor.
2. Agent A opens an Orbit browser and submits a local test form.
3. Agent B opens another session and submits different data.
4. User can request a preview without giving either agent host focus.
5. Stopping A leaves B working. Neither uses the user's browser profile.

Steps 1-3 and 5 are the first experiment. Interactive preview, real accounts and native apps are separate gates.
